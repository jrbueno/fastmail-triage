import pc from "picocolors";
import { FastmailEngine, senderOf, type Mailbox } from "../fastmail.ts";
import { triageEmails, type Category, type TriageResult } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
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

// Parent mailbox + child mailbox (leaf) names that emails are moved into.
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
      ui.info(`\nDry run — nothing moved. Re-run without --dry-run to file mail under "${PARENT_LABEL}/".`);
      continue;
    }

    await applyMoves(engine, buckets);
  }
}

async function applyMoves(
  engine: FastmailEngine,
  buckets: Record<Category, TriageResult[]>,
): Promise<void> {
  const used = (Object.keys(buckets) as Category[]).filter((c) => buckets[c].length > 0);
  if (used.length === 0) return;

  // The engine can't create mailboxes — verify the targets exist first.
  const mailboxes = await engine.listMailboxes();
  const parent = mailboxes.find((m) => m.name === PARENT_LABEL && !m.parentId);
  const missing: string[] = [];
  const targetByCat = new Map<Category, Mailbox>();

  for (const cat of used) {
    const leaf = MAILBOX_NAMES[cat];
    // Prefer a child under the Triage parent; fall back to any mailbox with that name.
    const box =
      mailboxes.find((m) => m.name === leaf && parent && m.parentId === parent.id) ??
      mailboxes.find((m) => m.name === leaf);
    if (box) targetByCat.set(cat, box);
    else missing.push(`${PARENT_LABEL}/${leaf}`);
  }

  if (missing.length > 0) {
    ui.warn(
      `\nMissing mailboxes (the engine can't create them):\n` +
        missing.map((m) => `  • ${m}`).join("\n") +
        `\n\nCreate them once in Fastmail (Settings → Folders, nested under "${PARENT_LABEL}"), then re-run.`,
    );
  }

  let moved = 0;
  for (const cat of used) {
    const box = targetByCat.get(cat);
    if (!box) continue;
    for (const item of buckets[cat]) {
      await engine.moveEmail(item.id, box.name);
      moved++;
    }
  }

  if (moved > 0) {
    ui.info(pc.green(`\n✓ Moved ${moved} email${moved === 1 ? "" : "s"} into "${PARENT_LABEL}/".`));
  }
}
