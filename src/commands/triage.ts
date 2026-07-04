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
import { runClaudeBatch, runClaudeDirect } from "../batch.ts";
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

export async function triageCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);

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

    let untouched = 0;
    if (opts.ai === false) {
      untouched = classifyWithHeuristics(groups, classified);
    } else {
      untouched = await classifyWithClaude(groups, classified, verdictStore, opts);
    }
    verdictStore.flush();

    // ── 5. Emit / apply ──────────────────────────────────────────────────────
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
      continue;
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
      continue;
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
 * --sync. Returns the count of emails left unclassified by failures.
 */
async function classifyWithClaude(
  groups: Map<string, SenderGroup>,
  classified: Classified[],
  verdictStore: SenderVerdictStore,
  opts: Opts,
): Promise<number> {
  const senderGroups: SenderGroup[] = [];
  const perEmail: Email[] = [];
  for (const g of groups.values()) {
    if (isBulkish(g)) senderGroups.push(g);
    else perEmail.push(...g.emails);
  }

  const requests = new Map<string, ClaudeRequest>();
  const senderChunks = new Map<string, SenderGroup[]>();
  const emailChunks = new Map<string, Email[]>();

  for (let i = 0; i < senderGroups.length; i += SENDERS_PER_REQUEST) {
    const chunk = senderGroups.slice(i, i + SENDERS_PER_REQUEST);
    const id = `s${i / SENDERS_PER_REQUEST}`;
    senderChunks.set(id, chunk);
    requests.set(id, senderTriageRequest(chunk.map(toSummary)));
  }
  const perCall = Math.max(1, Math.min(opts.batch, 100));
  for (let i = 0; i < perEmail.length; i += perCall) {
    const chunk = perEmail.slice(i, i + perCall);
    const id = `e${i / perCall}`;
    emailChunks.set(id, chunk);
    requests.set(id, emailTriageRequest(chunk));
  }

  if (requests.size === 0) return 0;

  const senderEmailCount = senderGroups.reduce((n, g) => n + g.emails.length, 0);
  ui.info(
    `Classifying ${senderGroups.length} bulk senders (${senderEmailCount} emails) + ` +
      `${perEmail.length} individual emails in ${requests.size} Claude request(s) ` +
      `via ${opts.sync ? "direct calls" : "the Batches API (50% token price)"}…`,
  );

  const run = opts.sync ? runClaudeDirect : runClaudeBatch;
  const outcome = await run(requests, (done, total, status) =>
    ui.info(pc.dim(`  ${status}: ${done}/${total} requests done`)),
  );

  let untouched = 0;

  for (const [id, chunk] of senderChunks) {
    const text = outcome.results.get(id);
    if (!text) {
      untouched += chunk.reduce((n, g) => n + g.emails.length, 0);
      ui.warn(`Sender request ${id} failed: ${outcome.errors.get(id) ?? "no result"}`);
      continue;
    }
    let verdicts;
    try {
      verdicts = parseSenderVerdicts(text);
    } catch (err) {
      untouched += chunk.reduce((n, g) => n + g.emails.length, 0);
      ui.warn(`Sender request ${id}: ${(err as Error).message}`);
      continue;
    }
    const bySender = new Map(verdicts.map((v) => [v.sender, v.category]));
    for (const g of chunk) {
      const cat = bySender.get(g.email);
      if (!cat) {
        untouched += g.emails.length;
        continue;
      }
      verdictStore.record(g.email, cat); // cached only for bulk categories
      const reason = `sender verdict (${g.emails.length} email${g.emails.length === 1 ? "" : "s"})`;
      for (const e of g.emails) classified.push({ id: e.id, category: cat, reason, email: e });
    }
  }

  for (const [id, chunk] of emailChunks) {
    const text = outcome.results.get(id);
    const valid = new Set(chunk.map((e) => e.id));
    const byId = new Map(chunk.map((e) => [e.id, e]));
    if (!text) {
      untouched += chunk.length;
      ui.warn(`Email request ${id} failed: ${outcome.errors.get(id) ?? "no result"}`);
      continue;
    }
    let results;
    try {
      results = parseTriageResults(text);
    } catch (err) {
      untouched += chunk.length;
      ui.warn(`Email request ${id}: ${(err as Error).message}`);
      continue;
    }
    const seen = new Set<string>();
    for (const r of results) {
      if (!valid.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      classified.push({ ...r, email: byId.get(r.id)! });
    }
    untouched += chunk.length - seen.size;
  }

  return untouched;
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
