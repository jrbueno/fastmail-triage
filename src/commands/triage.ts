import pc from "picocolors";
import { senderOf, type Email } from "../fastmail.ts";
import {
  buildJobs,
  CATEGORIES,
  classifyJobs,
  describeVerdict,
  jobEmails,
  type Category,
  type Verdict,
} from "../classify.ts";
import { resolveAccounts } from "../config.ts";
import {
  classifyHeuristically,
  groupBySender,
  looksBulk,
  type SenderGroup,
} from "../heuristics.ts";
import { JmapClient } from "../jmap.ts";
import { SenderVerdictStore } from "../senderstore.ts";
import { UnsubStore } from "../unsubstore.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  minConfidence: number;
  all?: boolean;
  unread?: boolean;
  mailbox?: string;
  oldest?: boolean;
  includePinned?: boolean;
  skipUnsubscribed?: boolean;
  json?: boolean;
  dryRun?: boolean;
  ai?: boolean; // --no-ai → false: zero-token heuristics only
  useCache?: boolean; // file senders from cached sender verdicts
}

/** Default --min-confidence. A starting point, not calibrated; see `calibrate`. */
export const DEFAULT_MIN_CONFIDENCE = 0.4;

// Parent mailbox + child mailbox (leaf) names that emails are moved into.
export const PARENT_LABEL = "Triage";
export const MAILBOX_NAMES: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  offers: "Offers",
  newsletter: "Newsletter",
  politics: "Politics",
  unsubscribe: "Unsubscribe",
  noise: "Noise",
};

const LABELS: Record<Category, string> = {
  reply: "Needs Reply",
  fyi: "FYI",
  offers: "Offers",
  newsletter: "Newsletter",
  politics: "Politics",
  unsubscribe: "Unsubscribe",
  noise: "Noise / Skip",
};

const COLOR: Record<Category, (s: string) => string> = {
  reply: (s) => pc.bold(pc.red(s)),
  fyi: (s) => pc.yellow(s),
  offers: (s) => pc.magenta(s),
  newsletter: (s) => pc.blue(s),
  politics: (s) => pc.green(s),
  unsubscribe: (s) => pc.bold(pc.cyan(s)),
  noise: (s) => pc.dim(s),
};

function emptyTotals(): Record<Category, number> {
  return { reply: 0, fyi: 0, offers: 0, newsletter: 0, politics: 0, unsubscribe: 0, noise: 0 };
}

interface Classified {
  id: string;
  category: Category;
  reason: string;
  /** Model confidence; absent for store and heuristic verdicts. */
  confidence?: number;
  email: Email;
}

/** Results of the classification tiers for one run. */
interface Outcome {
  classified: Classified[];
  /** Model verdicts below --min-confidence: reported, never moved. */
  held: Classified[];
  /** Emails whose request failed. */
  untouched: number;
}

export async function triageCommand(opts: Opts): Promise<void> {
  if (!(opts.minConfidence >= 0 && opts.minConfidence <= 1)) {
    throw new Error("--min-confidence must be a number between 0 and 1.");
  }
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);

    const unreadOnly = opts.unread || !opts.all;
    const skipPinned = !opts.includePinned;
    const filters = [unreadOnly && "unread", skipPinned && "not pinned"].filter(Boolean);
    const where = `${opts.mailbox ?? "Inbox"}${filters.length ? ` (${filters.join(", ")})` : ""}`;
    const order = opts.oldest ? "oldest first" : "newest first";

    // ── 1. Fetch everything up front (paged to the server's limits) ─────────
    ui.info(`Fetching up to ${opts.limit} emails from ${where} (${order})…`);
    const emails = await jmap.fetchAllEmails(
      {
        mailbox: opts.mailbox,
        unread: unreadOnly,
        skipPinned,
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

    // ── 2. Free tiers: unsubscribe store + cached sender verdicts (opt-in) ──
    // Verdicts are recorded every run, so the cache is current when opted into.
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
      const cached = opts.useCache ? verdictStore.get(sender) : null;
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
    const candidates = [...groups.values()].filter(looksBulk);
    if (candidates.length > 0) {
      ui.info(pc.dim(`  checking Sent history for ${candidates.length} bulk-looking senders…`));
      const replied = await jmap.hasRepliedTo(candidates.map((g) => g.email));
      for (const g of candidates) g.replied = replied.has(g.email);
    }

    // ── 4. Classify ──────────────────────────────────────────────────────────
    const outcome: Outcome = { classified, held: [], untouched: 0 };
    if (opts.ai === false) {
      outcome.untouched = classifyWithHeuristics(groups, classified);
    } else {
      await classifyWithModel(groups, outcome, verdictStore, opts.minConfidence);
    }
    verdictStore.flush();

    // ── 5. Emit / apply ──────────────────────────────────────────────────────
    await emitOrApply(jmap, opts, outcome);
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
 * Model tier (TypeSafe): bulk-ish senders get one sender-level verdict
 * (applied to all their mail and cached for future runs); personal-looking
 * mail is classified per-email. Verdicts under `minConfidence` are held —
 * shown, never filed or cached — so uncertain mail stays where it is.
 */
async function classifyWithModel(
  groups: Map<string, SenderGroup>,
  outcome: Outcome,
  verdictStore: SenderVerdictStore,
  minConfidence: number,
): Promise<void> {
  const jobs = buildJobs(groups.values());
  if (jobs.size === 0) return;
  let senderCount = 0;
  let senderEmailCount = 0;
  let perEmailCount = 0;
  for (const job of jobs.values()) {
    if (job.kind === "sender") {
      senderCount++;
      senderEmailCount += job.group.emails.length;
    } else perEmailCount++;
  }

  ui.info(
    `Classifying ${senderCount} bulk senders (${senderEmailCount} emails) + ` +
      `${perEmailCount} individual emails in ${jobs.size} TypeSafe request(s)…`,
  );
  const step = Math.max(50, Math.ceil(jobs.size / 20));
  const { results: verdicts, errors, inputTokens } = await classifyJobs(jobs, (done, total) => {
    if (done % step === 0 || done === total) ui.info(pc.dim(`  ${done}/${total} requests done`));
  });
  ui.info(pc.dim(`  ${inputTokens.toLocaleString()} input tokens`));

  let failures = 0;
  for (const [key, job] of jobs) {
    const emails = jobEmails(job);
    const v = verdicts.get(key);
    if (!v) {
      outcome.untouched += emails.length;
      if (failures++ < 5) ui.warn(`Request ${key} failed: ${errors.get(key) ?? "no result"}`);
      continue;
    }
    const confident = v.confidence >= minConfidence;
    // Cached only for bulk categories, and never from an uncertain verdict.
    if (job.kind === "sender" && confident) verdictStore.record(job.group.email, v.category);
    const reason =
      job.kind === "sender"
        ? `sender verdict (${emails.length} email${emails.length === 1 ? "" : "s"}), ${describeVerdict(v)}`
        : describeVerdict(v);
    const into = confident ? outcome.classified : outcome.held;
    for (const e of emails) into.push(toClassified(e, v, reason));
  }
  if (failures > 5) ui.warn(`…and ${failures - 5} more failed requests.`);
}

function toClassified(email: Email, v: Verdict, reason: string): Classified {
  return { id: email.id, category: v.category, reason, confidence: v.confidence, email };
}

/** Print (--json / --dry-run) or move the classified emails. */
async function emitOrApply(jmap: JmapClient, opts: Opts, outcome: Outcome): Promise<void> {
  const { classified, held, untouched } = outcome;
  const leftNote =
    (held.length > 0 ? ` ${held.length} held below --min-confidence.` : "") +
    (untouched > 0 ? ` ${untouched} left unclassified.` : "");
  const totals = emptyTotals();
  for (const r of classified) totals[r.category]++;

  if (opts.json) {
    const heldIds = new Set(held.map((r) => r.id));
    console.log(
      JSON.stringify(
        [...classified, ...held].map((r) => {
          const s = senderOf(r.email);
          return {
            id: r.id,
            category: r.category,
            confidence: r.confidence ?? null,
            held: heldIds.has(r.id),
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
    if (leftNote) ui.info(pc.dim(leftNote.trim()));
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
    if (held.length > 0) {
      ui.header(pc.dim(`Low confidence — would stay in place (${held.length})`));
      ui.table({
        head: ["From", "Subject", "Best guess"],
        colWidths: [26, 44, 40],
        rows: held.slice(0, 40).map((r) => {
          const s = senderOf(r.email);
          return [s.name || s.email || "?", r.email.subject ?? "?", `${r.category}: ${r.reason}`];
        }),
      });
      if (held.length > 40) ui.info(pc.dim(`  … and ${held.length - 40} more`));
    }
    ui.info(`\nDry run — nothing moved. ${summary(totals)}${pc.dim(leftNote)}`);
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
      (leftNote ? pc.dim(` Left in place:${leftNote}`) : ""),
  );
}

function summary(totals: Record<Category, number>): string {
  const parts = CATEGORIES.filter((c) => totals[c] > 0).map(
    (c) => `${LABELS[c].replace(" / Skip", "")}: ${totals[c]}`,
  );
  return parts.length ? `(${parts.join(", ")})` : "";
}
