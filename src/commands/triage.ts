import pc from "picocolors";
import { senderOf, type Email } from "../fastmail.ts";
import { triageEmails, CATEGORIES, type Category, type TriageResult } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import { JmapClient } from "../jmap.ts";
import { UnsubStore } from "../unsubstore.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  batch: number;
  all?: boolean;
  unread?: boolean;
  mailbox?: string;
  oldest?: boolean;
  skipUnsubscribed?: boolean;
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
  unsubscribe: "Unsubscribe",
  noise: "Noise",
};

const LABELS: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  offers: "Offers",
  newsletter: "Newsletter",
  unsubscribe: "Unsubscribe",
  noise: "Noise / Skip",
};

const COLOR: Record<Category, (s: string) => string> = {
  reply: (s) => pc.bold(pc.red(s)),
  fyi: (s) => pc.yellow(s),
  offers: (s) => pc.magenta(s),
  newsletter: (s) => pc.blue(s),
  unsubscribe: (s) => pc.bold(pc.cyan(s)),
  noise: (s) => pc.dim(s),
};

function emptyTotals(): Record<Category, number> {
  return { reply: 0, fyi: 0, offers: 0, newsletter: 0, unsubscribe: 0, noise: 0 };
}

/**
 * Classify a batch, but route mail from senders we've already unsubscribed
 * straight to "unsubscribe" without spending a Claude call on it.
 */
async function classifyBatch(
  emails: Email[],
  store: UnsubStore | null,
): Promise<TriageResult[]> {
  if (!store) return triageEmails(emails);

  const preFiled: TriageResult[] = [];
  const toClassify: Email[] = [];
  for (const e of emails) {
    if (store.has(senderOf(e).email)) {
      preFiled.push({ id: e.id, category: "unsubscribe", reason: "already unsubscribed" });
    } else {
      toClassify.push(e);
    }
  }
  const classified = toClassify.length > 0 ? await triageEmails(toClassify) : [];
  return [...preFiled, ...classified];
}

export async function triageCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);
  const batchSize = Math.max(1, Math.min(opts.batch, 100));

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);

    const unreadOnly = opts.unread || !opts.all;
    const where = `${opts.mailbox ?? "Inbox"}${unreadOnly ? " (unread)" : ""}`;
    const order = opts.oldest ? "oldest first" : "newest first";
    const store = opts.skipUnsubscribed ? new UnsubStore(account.name) : null;

    if (opts.dryRun || opts.json) {
      await previewMode(jmap, opts, batchSize, where, order, store);
    } else {
      await applyMode(jmap, opts, batchSize, where, order, store);
    }
  }
}

/** Read-only: paginate through up to --limit emails and show/emit the plan. */
async function previewMode(
  jmap: JmapClient,
  opts: Opts,
  batchSize: number,
  where: string,
  order: string,
  store: UnsubStore | null,
): Promise<void> {
  ui.info(`Previewing up to ${opts.limit} emails from ${where} (${order})…`);
  const all: (TriageResult & { sender: string; subject: string })[] = [];
  const totals = emptyTotals();

  let offset = 0;
  while (all.length < opts.limit) {
    const want = Math.min(batchSize, opts.limit - all.length);
    const emails = await jmap.queryEmails({
      mailbox: opts.mailbox,
      unread: opts.unread || !opts.all,
      oldestFirst: opts.oldest,
      limit: want,
      offset,
    });
    if (emails.length === 0) break;
    offset += emails.length;

    const results = await classifyBatch(emails, store);
    const byId = new Map(emails.map((e) => [e.id, e]));
    for (const r of results) {
      const e = byId.get(r.id);
      const s = e ? senderOf(e) : { name: "?", email: "" };
      totals[r.category] = (totals[r.category] ?? 0) + 1;
      all.push({ ...r, sender: s.name || s.email || "?", subject: e?.subject ?? "?" });
    }
    if (!opts.json) ui.info(pc.dim(`  …classified ${all.length}`));
  }

  if (opts.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  for (const cat of CATEGORIES) {
    const items = all.filter((r) => r.category === cat);
    if (items.length === 0) continue;
    ui.header(COLOR[cat](`${LABELS[cat]} (${items.length})`));
    ui.table({
      head: ["From", "Subject", "Why"],
      colWidths: [26, 44, 40],
      rows: items.map((r) => [r.sender, r.subject, r.reason]),
    });
  }
  ui.info(`\nDry run — nothing moved. ${summary(totals)}`);
}

/** Drain the mailbox in batches, classifying then bulk-moving each batch. */
async function applyMode(
  jmap: JmapClient,
  opts: Opts,
  batchSize: number,
  where: string,
  order: string,
  store: UnsubStore | null,
): Promise<void> {
  ui.info(`Triaging up to ${opts.limit} emails from ${where} (${order})…`);

  // Create the full Triage tree once up front and cache the mailbox ids.
  const { ids: labelIds, created } = await jmap.ensureLabelTree(
    PARENT_LABEL,
    CATEGORIES.map((c) => MAILBOX_NAMES[c]),
  );
  if (created.length > 0) ui.info(pc.dim(`Created: ${created.join(", ")}`));

  const totals = emptyTotals();
  const seen = new Set<string>();
  let processed = 0;
  let batchNo = 0;

  while (processed < opts.limit) {
    const want = Math.min(batchSize, opts.limit - processed);
    const fetched = await jmap.queryEmails({
      mailbox: opts.mailbox,
      unread: opts.unread || !opts.all,
      oldestFirst: opts.oldest,
      limit: want,
    });
    // Skip anything we've already handled this run (e.g. a move that didn't
    // clear the filter) to guarantee forward progress.
    const emails = fetched.filter((e) => !seen.has(e.id));
    if (emails.length === 0) break;

    batchNo++;
    const results = await classifyBatch(emails, store);
    const valid = new Set(emails.map((e) => e.id));

    // Group ids by destination category.
    const byCat: Record<Category, string[]> = {
      reply: [], fyi: [], offers: [], newsletter: [], unsubscribe: [], noise: [],
    };
    for (const r of results) {
      if (!valid.has(r.id)) continue;
      (byCat[r.category] ?? byCat.noise).push(r.id);
    }

    let movedThisBatch = 0;
    for (const cat of CATEGORIES) {
      const ids = byCat[cat];
      if (ids.length === 0) continue;
      const moved = await jmap.moveEmails(ids, labelIds[MAILBOX_NAMES[cat]]!);
      totals[cat] += moved;
      movedThisBatch += moved;
    }

    for (const e of emails) seen.add(e.id);
    processed += emails.length;
    ui.info(
      pc.dim(`  batch ${batchNo}: classified ${emails.length}, moved ${movedThisBatch} ` +
        `(total ${processed})`),
    );
    if (movedThisBatch === 0) break; // nothing is leaving the mailbox; avoid looping
  }

  ui.info(pc.green(`\n✓ Filed ${processed} emails under "${PARENT_LABEL}/". ${summary(totals)}`));
}

function summary(totals: Record<Category, number>): string {
  const parts = CATEGORIES.filter((c) => totals[c] > 0).map(
    (c) => `${LABELS[c].replace(" / Skip", "")}: ${totals[c]}`,
  );
  return parts.length ? `(${parts.join(", ")})` : "";
}
