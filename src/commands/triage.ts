import pc from "picocolors";
import { FastmailEngine, senderOf } from "../fastmail.ts";
import { triageEmails, type Category, type TriageResult } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  all?: boolean;
  json?: boolean;
}

const LABELS: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  noise: "Noise / Skip",
};

const COLOR: Record<Category, (s: string) => string> = {
  reply: (s) => pc.bold(pc.red(s)),
  fyi: (s) => pc.yellow(s),
  noise: (s) => pc.dim(s),
};

export async function triageCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const engine = new FastmailEngine(account);

    ui.info("Fetching emails…");
    const emails = await engine.listEmails({ limit: opts.limit, unread: !opts.all });
    if (emails.length === 0) {
      ui.info("No emails found.");
      continue;
    }

    ui.info(`Triaging ${emails.length} emails with Claude…`);
    const results = await triageEmails(emails);
    const byId = new Map(emails.map((e) => [e.id, e]));

    if (opts.json) {
      const enriched = results.map((r) => ({ ...r, account: account.name }));
      console.log(JSON.stringify(enriched, null, 2));
      continue;
    }

    const buckets: Record<Category, TriageResult[]> = { reply: [], fyi: [], noise: [] };
    for (const r of results) (buckets[r.category] ?? buckets.noise).push(r);

    for (const cat of ["reply", "fyi", "noise"] as Category[]) {
      const items = buckets[cat];
      if (items.length === 0) continue;
      ui.header(COLOR[cat](`${LABELS[cat]} (${items.length})`));
      ui.table({
        head: ["From", "Subject", "Why"],
        colWidths: [26, 44, 40],
        rows: items.map((r) => {
          const e = byId.get(r.id);
          const s = e ? senderOf(e) : { name: "?", email: "" };
          return [s.name || s.email || "?", e?.subject ?? "?", r.reason];
        }),
      });
    }
  }
}
