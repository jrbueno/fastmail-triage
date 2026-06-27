import pc from "picocolors";
import { FastmailEngine, senderOf } from "../fastmail.ts";
import { triageEmails, type Category, type TriageResult } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import { JmapClient } from "../jmap.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  all?: boolean;
  json?: boolean;
  dryRun?: boolean;
}

// Display headers for each bucket.
const LABELS: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  noise: "Noise / Skip",
};

// Parent label + child mailbox names applied in Fastmail.
const PARENT_LABEL = "Triage";
const MAILBOX_NAMES: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  noise: "Noise",
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

    if (opts.dryRun) {
      ui.info(`\nDry run — no labels applied. Re-run without --dry-run to label under "${PARENT_LABEL}/".`);
      continue;
    }

    await applyLabels(account.token, buckets);
  }
}

async function applyLabels(
  token: string,
  buckets: Record<Category, TriageResult[]>,
): Promise<void> {
  const used = (Object.keys(buckets) as Category[]).filter((c) => buckets[c].length > 0);
  if (used.length === 0) return;

  ui.info(`\nApplying labels under "${PARENT_LABEL}/"…`);
  const jmap = new JmapClient(token);

  // Create the Triage parent + only the child labels we actually need.
  const childNames = used.map((c) => MAILBOX_NAMES[c]);
  const { children } = await jmap.ensureLabelTree(PARENT_LABEL, childNames);

  // Map every triaged email id → its category's label mailbox id.
  const assignments: Record<string, string> = {};
  for (const cat of used) {
    const mailboxId = children[MAILBOX_NAMES[cat]]!;
    for (const item of buckets[cat]) assignments[item.id] = mailboxId;
  }

  const count = await jmap.addLabels(assignments);
  ui.info(
    pc.green(`✓ Labeled ${count} email${count === 1 ? "" : "s"} (kept in Inbox).`),
  );
}
