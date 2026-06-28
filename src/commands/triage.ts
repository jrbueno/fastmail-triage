import pc from "picocolors";
import { FastmailEngine, senderOf } from "../fastmail.ts";
import { triageEmails, CATEGORIES, type Category, type TriageResult } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import { JmapClient } from "../jmap.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  all?: boolean;
  mailbox?: string;
  oldest?: boolean;
  json?: boolean;
  dryRun?: boolean;
}

// Parent mailbox + child mailbox (leaf) names that emails are moved into.
const PARENT_LABEL = "Triage";
const MAILBOX_NAMES: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  offers: "Offers",
  newsletter: "Newsletter",
  noise: "Noise",
};

// Display headers for each bucket.
const LABELS: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  offers: "Offers",
  newsletter: "Newsletter",
  noise: "Noise / Skip",
};

const COLOR: Record<Category, (s: string) => string> = {
  reply: (s) => pc.bold(pc.red(s)),
  fyi: (s) => pc.yellow(s),
  offers: (s) => pc.magenta(s),
  newsletter: (s) => pc.blue(s),
  noise: (s) => pc.dim(s),
};

export async function triageCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const engine = new FastmailEngine(account);
    const jmap = new JmapClient(account.token);

    const where = opts.mailbox ?? "Inbox";
    const order = opts.oldest ? "oldest first" : "newest first";
    ui.info(`Fetching emails from ${where} (${order})…`);
    const emails = await jmap.queryEmails({
      mailbox: opts.mailbox,
      unread: !opts.all,
      oldestFirst: opts.oldest,
      limit: opts.limit,
    });
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

    const buckets: Record<Category, TriageResult[]> = {
      reply: [], fyi: [], offers: [], newsletter: [], noise: [],
    };
    for (const r of results) (buckets[r.category] ?? buckets.noise).push(r);

    for (const cat of CATEGORIES) {
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
      ui.info(`\nDry run — nothing moved. Re-run without --dry-run to file mail under "${PARENT_LABEL}/".`);
      continue;
    }

    await applyMoves(engine, jmap, buckets);
  }
}

async function applyMoves(
  engine: FastmailEngine,
  jmap: JmapClient,
  buckets: Record<Category, TriageResult[]>,
): Promise<void> {
  const used = CATEGORIES.filter((c) => buckets[c].length > 0);
  if (used.length === 0) return;

  // The engine can't create mailboxes, so use JMAP to auto-create the Triage
  // tree (only the children we actually need), then move via the engine.
  const childNames = used.map((c) => MAILBOX_NAMES[c]);
  const created = await jmap.ensureLabelTree(PARENT_LABEL, childNames);
  if (created.length > 0) {
    ui.info(pc.dim(`Created: ${created.join(", ")}`));
  }

  let moved = 0;
  for (const cat of used) {
    for (const item of buckets[cat]) {
      await engine.moveEmail(item.id, MAILBOX_NAMES[cat]);
      moved++;
    }
  }

  if (moved > 0) {
    ui.info(pc.green(`\n✓ Moved ${moved} email${moved === 1 ? "" : "s"} into "${PARENT_LABEL}/".`));
  }
}
