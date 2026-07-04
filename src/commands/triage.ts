import pc from "picocolors";
import { senderOf, type Email } from "../fastmail.ts";
import {
  CATEGORIES,
  emailTriageRequest,
  parseSenderVerdicts,
  parseTriageResults,
  senderTriageRequest,
  type Category,
  type ClaudeRequest,
  type SenderSummary,
  type TriageResult,
} from "../ai.ts";
import {
  awaitClaudeBatches,
  runClaudeDirect,
  submitClaudeBatches,
  type ClaudeOutcome,
} from "../batch.ts";
import {
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type SenderChunkEntry,
} from "../checkpoint.ts";
import { resolveAccounts } from "../config.ts";
import {
  classifyHeuristically,
  groupBySender,
  isBulkish,
  type SenderGroup,
} from "../heuristics.ts";
import { JmapClient } from "../jmap.ts";
import { SenderVerdictStore } from "../senderstore.ts";
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
  ai?: boolean; // --no-ai → false: zero-token heuristics only
  sync?: boolean; // direct Claude calls instead of the Batches API
  reclassify?: boolean; // ignore cached sender verdicts
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

const SENDERS_PER_REQUEST = 40;

function emptyTotals(): Record<Category, number> {
  return { reply: 0, fyi: 0, offers: 0, newsletter: 0, unsubscribe: 0, noise: 0 };
}

interface Classified extends TriageResult {
  email: Email;
}

/** The request→email mapping needed to ingest a batch outcome. */
interface ChunkMaps {
  senderChunks: Map<string, SenderChunkEntry[]>;
  emailChunks: Map<string, string[]>;
}

export async function triageCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);

    // An earlier run may have been interrupted after submitting a batch —
    // that batch kept processing (and billing) server-side, so reattach and
    // apply its results before doing anything new.
    await resumePendingBatch(jmap, account.name, opts);

    const unreadOnly = opts.unread || !opts.all;
    const where = `${opts.mailbox ?? "Inbox"}${unreadOnly ? " (unread)" : ""}`;
    const order = opts.oldest ? "oldest first" : "newest first";

    // ── 1. Fetch everything up front (paged to the server's limits) ─────────
    ui.info(`Fetching up to ${opts.limit} emails from ${where} (${order})…`);
    const emails = await jmap.fetchAllEmails(
      {
        mailbox: opts.mailbox,
        unread: unreadOnly,
        oldestFirst: opts.oldest,
        limit: opts.limit,
        withHeaders: true,
      },
      (n, total) =>
        ui.info(pc.dim(`  fetched ${n}${total !== undefined ? ` of ${Math.min(total, opts.limit)}` : ""}`)),
    );
    if (emails.length === 0) {
      ui.info("Nothing to triage.");
      continue;
    }

    // ── 2. Free tiers: unsubscribe store + cached sender verdicts ───────────
    const unsubStore = opts.skipUnsubscribed ? new UnsubStore(account.name) : null;
    const verdictStore = new SenderVerdictStore(account.name);

    const classified: Classified[] = [];
    const remaining: Email[] = [];
    for (const e of emails) {
      const sender = senderOf(e).email.toLowerCase();
      if (unsubStore?.has(sender)) {
        classified.push({ id: e.id, category: "unsubscribe", reason: "already unsubscribed", email: e });
        continue;
      }
      const cached = opts.reclassify ? null : verdictStore.get(sender);
      if (cached) {
        classified.push({ id: e.id, category: cached, reason: "cached sender verdict", email: e });
        continue;
      }
      remaining.push(e);
    }
    if (classified.length > 0) {
      ui.info(pc.dim(`  ${classified.length} classified from stores (0 tokens)`));
    }

    // ── 3. Group by sender + zero-token engagement check ────────────────────
    const groups = groupBySender(remaining);
    const candidates = [...groups.values()].filter(
      (g) => g.bulk || g.automated || g.emails.length >= 5,
    );
    if (candidates.length > 0) {
      ui.info(pc.dim(`  checking Sent history for ${candidates.length} bulk-looking senders…`));
      const replied = await jmap.hasRepliedTo(candidates.map((g) => g.email));
      for (const g of candidates) g.replied = replied.has(g.email);
    }

    // ── 4. Classify ──────────────────────────────────────────────────────────
    let untouched = 0;
    if (opts.ai === false) {
      untouched = classifyWithHeuristics(groups, classified);
    } else {
      untouched = await classifyWithClaude(groups, classified, verdictStore, opts, account.name);
    }
    verdictStore.flush();

    // ── 5. Emit / apply ──────────────────────────────────────────────────────
    await emitOrApply(jmap, opts, classified, untouched);
  }
}

/** Zero-token tier: header heuristics only. Returns the untouched count. */
function classifyWithHeuristics(
  groups: Map<string, SenderGroup>,
  classified: Classified[],
): number {
  let untouched = 0;
  for (const g of groups.values()) {
    const cat = classifyHeuristically(g);
    if (!cat) {
      untouched += g.emails.length;
      continue;
    }
    const reason = g.bulk
      ? cat === "unsubscribe"
        ? "bulk headers, never opened, never written to"
        : "bulk headers (List-Unsubscribe/List-Id)"
      : "automated notification sender";
    for (const e of g.emails) classified.push({ id: e.id, category: cat, reason, email: e });
  }
  return untouched;
}

/**
 * Claude tier: bulk-ish senders get one sender-level verdict (applied to all
 * their mail and cached for future runs); personal-looking mail is classified
 * per-email. All requests go through the Batches API (50% price) unless
 * --sync; the submitted batch ids are checkpointed so an interrupted run can
 * reattach. Returns the count of emails left unclassified by failures.
 */
async function classifyWithClaude(
  groups: Map<string, SenderGroup>,
  classified: Classified[],
  verdictStore: SenderVerdictStore,
  opts: Opts,
  account: string,
): Promise<number> {
  const senderGroups: SenderGroup[] = [];
  const perEmail: Email[] = [];
  for (const g of groups.values()) {
    if (isBulkish(g)) senderGroups.push(g);
    else perEmail.push(...g.emails);
  }

  const requests = new Map<string, ClaudeRequest>();
  const chunks: ChunkMaps = { senderChunks: new Map(), emailChunks: new Map() };
  const byId = new Map<string, Email>();
  for (const g of senderGroups) for (const e of g.emails) byId.set(e.id, e);
  for (const e of perEmail) byId.set(e.id, e);

  for (let i = 0; i < senderGroups.length; i += SENDERS_PER_REQUEST) {
    const chunk = senderGroups.slice(i, i + SENDERS_PER_REQUEST);
    const id = `s${i / SENDERS_PER_REQUEST}`;
    chunks.senderChunks.set(
      id,
      chunk.map((g) => ({ email: g.email, ids: g.emails.map((e) => e.id) })),
    );
    requests.set(id, senderTriageRequest(chunk.map(toSummary)));
  }
  const perCall = Math.max(1, Math.min(opts.batch, 100));
  for (let i = 0; i < perEmail.length; i += perCall) {
    const chunk = perEmail.slice(i, i + perCall);
    const id = `e${i / perCall}`;
    chunks.emailChunks.set(id, chunk.map((e) => e.id));
    requests.set(id, emailTriageRequest(chunk));
  }

  if (requests.size === 0) return 0;

  const senderEmailCount = senderGroups.reduce((n, g) => n + g.emails.length, 0);
  ui.info(
    `Classifying ${senderGroups.length} bulk senders (${senderEmailCount} emails) + ` +
      `${perEmail.length} individual emails in ${requests.size} Claude request(s) ` +
      `via ${opts.sync ? "direct calls" : "the Batches API (50% token price)"}…`,
  );

  let outcome: ClaudeOutcome;
  if (opts.sync) {
    outcome = await runClaudeDirect(requests, (done, total, status) =>
      ui.info(pc.dim(`  ${status}: ${done}/${total} requests done`)),
    );
  } else {
    const batchIds = await submitClaudeBatches(requests);
    saveCheckpoint(account, {
      batchIds,
      createdAt: new Date().toISOString(),
      senderChunks: Object.fromEntries(chunks.senderChunks),
      emailChunks: Object.fromEntries(chunks.emailChunks),
    });
    ui.info(
      `Submitted ${batchIds.length === 1 ? `batch ${batchIds[0]}` : `${batchIds.length} batches`} — ` +
        `most finish well within the hour. Safe to Ctrl-C: re-running reattaches without spending new tokens.`,
    );
    outcome = await awaitClaudeBatches(batchIds, (done, total, status) =>
      ui.info(pc.dim(`  ${status}: ${done}/${total} requests done`)),
    );
  }

  const untouched = ingestOutcome(outcome, chunks, byId, classified, verdictStore);
  if (!opts.sync) clearCheckpoint(account);
  return untouched;
}

/**
 * Turn a batch/direct outcome back into per-email classifications using the
 * request→email mapping. Shared by the normal path and checkpoint resume.
 */
function ingestOutcome(
  outcome: ClaudeOutcome,
  chunks: ChunkMaps,
  byId: Map<string, Email>,
  classified: Classified[],
  verdictStore: SenderVerdictStore,
): number {
  let untouched = 0;

  for (const [id, senders] of chunks.senderChunks) {
    const text = outcome.results.get(id);
    if (!text) {
      untouched += countPresent(senders.flatMap((s) => s.ids), byId);
      ui.warn(`Sender request ${id} failed: ${outcome.errors.get(id) ?? "no result"}`);
      continue;
    }
    let verdicts;
    try {
      verdicts = parseSenderVerdicts(text);
    } catch (err) {
      untouched += countPresent(senders.flatMap((s) => s.ids), byId);
      ui.warn(`Sender request ${id}: ${(err as Error).message}`);
      continue;
    }
    const bySender = new Map(verdicts.map((v) => [v.sender, v.category]));
    for (const s of senders) {
      const cat = bySender.get(s.email);
      if (!cat) {
        untouched += countPresent(s.ids, byId);
        continue;
      }
      verdictStore.record(s.email, cat); // cached only for bulk categories
      const reason = `sender verdict (${s.ids.length} email${s.ids.length === 1 ? "" : "s"})`;
      for (const eid of s.ids) {
        const email = byId.get(eid);
        if (email) classified.push({ id: eid, category: cat, reason, email });
      }
    }
  }

  for (const [id, ids] of chunks.emailChunks) {
    const text = outcome.results.get(id);
    const valid = new Set(ids);
    if (!text) {
      untouched += countPresent(ids, byId);
      ui.warn(`Email request ${id} failed: ${outcome.errors.get(id) ?? "no result"}`);
      continue;
    }
    let results;
    try {
      results = parseTriageResults(text);
    } catch (err) {
      untouched += countPresent(ids, byId);
      ui.warn(`Email request ${id}: ${(err as Error).message}`);
      continue;
    }
    const seen = new Set<string>();
    for (const r of results) {
      if (!valid.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      const email = byId.get(r.id);
      if (email) classified.push({ ...r, email });
    }
    untouched += countPresent(ids.filter((i) => !seen.has(i)), byId);
  }

  return untouched;
}

/** Count ids that still resolve to an email (deleted/moved ones don't matter). */
function countPresent(ids: string[], byId: Map<string, Email>): number {
  return ids.reduce((n, id) => n + (byId.has(id) ? 1 : 0), 0);
}

/**
 * Reattach to a batch submitted by an interrupted run: wait for it, apply its
 * results with the current run's flags, and clear the checkpoint. No new
 * classification tokens are spent.
 */
async function resumePendingBatch(
  jmap: JmapClient,
  account: string,
  opts: Opts,
): Promise<void> {
  const pending = loadCheckpoint(account);
  if (!pending) return;

  ui.warn(
    `Found a pending batch from ${pending.createdAt} — reattaching (no new tokens spent)…`,
  );
  let outcome: ClaudeOutcome;
  try {
    outcome = await awaitClaudeBatches(pending.batchIds, (done, total, status) =>
      ui.info(pc.dim(`  ${status}: ${done}/${total} requests done`)),
    );
  } catch (err) {
    // Batch gone (expired/deleted): drop the checkpoint so runs aren't wedged.
    ui.warn(`Could not reattach (${(err as Error).message}) — discarding checkpoint.`);
    clearCheckpoint(account);
    return;
  }

  const chunks: ChunkMaps = {
    senderChunks: new Map(Object.entries(pending.senderChunks)),
    emailChunks: new Map(Object.entries(pending.emailChunks)),
  };
  const allIds = [
    ...[...chunks.senderChunks.values()].flatMap((ss) => ss.flatMap((s) => s.ids)),
    ...[...chunks.emailChunks.values()].flat(),
  ];
  // Re-fetch by id so results can be displayed and moved; emails deleted or
  // filed since the interrupted run simply drop out.
  const emails = await jmap.getEmailsByIds(allIds);
  const byId = new Map(emails.map((e) => [e.id, e]));

  const verdictStore = new SenderVerdictStore(account);
  const classified: Classified[] = [];
  const untouched = ingestOutcome(outcome, chunks, byId, classified, verdictStore);
  verdictStore.flush();

  await emitOrApply(jmap, opts, classified, untouched);
  clearCheckpoint(account);
  ui.info(pc.dim("Resumed batch applied — continuing with the current run.\n"));
}

/** Print (--json / --dry-run) or move the classified emails. */
async function emitOrApply(
  jmap: JmapClient,
  opts: Opts,
  classified: Classified[],
  untouched: number,
): Promise<void> {
  const totals = emptyTotals();
  for (const r of classified) totals[r.category]++;

  if (opts.json) {
    console.log(
      JSON.stringify(
        classified.map((r) => {
          const s = senderOf(r.email);
          return {
            id: r.id,
            category: r.category,
            reason: r.reason,
            sender: s.name || s.email || "?",
            senderEmail: s.email,
            subject: r.email.subject ?? "?",
          };
        }),
        null,
        2,
      ),
    );
    if (untouched > 0) ui.info(pc.dim(`${untouched} emails left unclassified.`));
    return;
  }

  if (opts.dryRun) {
    for (const cat of CATEGORIES) {
      const items = classified.filter((r) => r.category === cat);
      if (items.length === 0) continue;
      ui.header(COLOR[cat](`${LABELS[cat]} (${items.length})`));
      ui.table({
        head: ["From", "Subject", "Why"],
        colWidths: [26, 44, 40],
        rows: items
          .slice(0, 40)
          .map((r) => {
            const s = senderOf(r.email);
            return [s.name || s.email || "?", r.email.subject ?? "?", r.reason];
          }),
      });
      if (items.length > 40) ui.info(pc.dim(`  … and ${items.length - 40} more`));
    }
    ui.info(
      `\nDry run — nothing moved. ${summary(totals)}` +
        (untouched > 0 ? ` (${untouched} left unclassified)` : ""),
    );
    return;
  }

  // Apply: create the Triage tree once, then bulk-move everything in as few
  // Email/set calls as the server allows (mixed destinations per call).
  const { ids: labelIds, created } = await jmap.ensureLabelTree(
    PARENT_LABEL,
    CATEGORIES.map((c) => MAILBOX_NAMES[c]),
  );
  if (created.length > 0) ui.info(pc.dim(`Created: ${created.join(", ")}`));

  const destinations = new Map<string, string>(
    classified.map((r) => [r.id, labelIds[MAILBOX_NAMES[r.category]]!]),
  );
  const { moved, failed } = await jmap.moveEmailsBulk(destinations, (n, total) =>
    ui.info(pc.dim(`  moved ${n}/${total}`)),
  );
  if (failed.length > 0) ui.warn(`${failed.length} emails could not be moved.`);
  ui.info(
    pc.green(`\n✓ Filed ${moved} emails under "${PARENT_LABEL}/". ${summary(totals)}`) +
      (untouched > 0 ? pc.dim(` ${untouched} left in place (unclassified).`) : ""),
  );
}

function toSummary(g: SenderGroup): SenderSummary {
  return {
    email: g.email,
    name: g.name,
    total: g.emails.length,
    unread: g.unread,
    replied: g.replied,
    sampleSubjects: g.emails.slice(0, 3).map((e) => (e.subject ?? "").slice(0, 100)),
  };
}

function summary(totals: Record<Category, number>): string {
  const parts = CATEGORIES.filter((c) => totals[c] > 0).map(
    (c) => `${LABELS[c].replace(" / Skip", "")}: ${totals[c]}`,
  );
  return parts.length ? `(${parts.join(", ")})` : "";
}
