/**
 * Claude-powered analysis for the four inbox tasks.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Email, extractBody, senderOf } from "./fastmail.ts";

// Sonnet is the sweet spot for bulk email classification: fast + cheap + sharp.
// (claude-haiku-4-5 is ~3x cheaper and usually sufficient — set FASTMAIL_TRIAGE_MODEL.)
export const MODEL = process.env.FASTMAIL_TRIAGE_MODEL || "claude-sonnet-4-6";

let client: Anthropic | null = null;
export function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
  client ??= new Anthropic();
  return client;
}

const DEBUG = process.env.FASTMAIL_TRIAGE_DEBUG === "1";

/**
 * Call Claude with a stable, cached `system` prompt and a per-request `user`
 * message. The system block carries `cache_control: ephemeral`, so when the
 * same instructions repeat across many calls within the 5-minute TTL (e.g. the
 * batched triage loop) the prefix is served from cache at ~0.1x input cost.
 *
 * Caching only engages when the system prefix exceeds the model's minimum
 * (~1024 tokens for Sonnet 4.5, ~2048 for Sonnet 4.6); shorter prefixes
 * silently won't cache. Set FASTMAIL_TRIAGE_DEBUG=1 to log cache hit/miss.
 */
async function ask(system: string, user: string, maxTokens: number): Promise<string> {
  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  if (DEBUG) {
    const u = resp.usage;
    console.error(
      `[cache] write=${u.cache_creation_input_tokens ?? 0} ` +
        `read=${u.cache_read_input_tokens ?? 0} uncached=${u.input_tokens}`,
    );
  }
  const block = resp.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

/** Like `ask`, but parses a JSON array out of the response (tolerates fences). */
async function askJson<T>(system: string, user: string, maxTokens = 4096): Promise<T> {
  let text = await ask(system, user, maxTokens);
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Claude did not return valid JSON:\n${text.slice(0, 400)}`);
  }
}

function emailDigest(email: Email, includeBody: boolean): string {
  const { name, email: addr } = senderOf(email);
  const seen = email.keywords?.["$seen"] === true;
  const lines = [
    `From: ${name} <${addr}>`,
    `Subject: ${email.subject ?? "(no subject)"}`,
    `Date: ${email.receivedAt ?? ""}`,
    `Status: ${seen ? "read" : "unread"}`,
  ];
  if (includeBody) {
    const body = extractBody(email).slice(0, 1500);
    lines.push(`Body:\n${body}`);
  } else if (email.preview) {
    lines.push(`Preview: ${email.preview}`);
  }
  return lines.join("\n");
}

// ── Triage ────────────────────────────────────────────────────────────────

export type Category =
  | "reply"
  | "fyi"
  | "offers"
  | "newsletter"
  | "unsubscribe"
  | "noise";
export const CATEGORIES: Category[] = [
  "reply",
  "fyi",
  "offers",
  "newsletter",
  "unsubscribe",
  "noise",
];

export interface TriageResult {
  id: string;
  category: Category;
  reason: string;
}

// Shared category rubric — stable across every request in a run → lives in
// the cached system prompt (and is byte-identical between batch requests, so
// the Batches API can share the prefix cache too).
const CATEGORY_RUBRIC =
  "  - reply: needs a personal response from the user\n" +
  "  - fyi: informational, worth skimming, no reply needed (receipts, alerts, confirmations)\n" +
  "  - offers: promotional sales, discounts, deals, marketing from retailers\n" +
  "  - newsletter: recurring subscriptions, digests, editorial content you signed up for\n" +
  "  - unsubscribe: low-value bulk/marketing/newsletter mail the user clearly doesn't engage\n" +
  "      with and should stop receiving — favor this when such mail is left unread.\n" +
  "  - noise: automated notifications or spam that fit none of the above — safe to ignore\n\n" +
  "Use 'unsubscribe' for recurring promo/newsletter clutter of little value (especially if\n" +
  "unread); use 'offers'/'newsletter' for mail of that type the user may still want.\n\n" +
  "Decision guidance for the tricky boundaries:\n" +
  "  • reply vs fyi: choose 'reply' only when a specific human is waiting on an answer,\n" +
  "    decision, or action FROM the user (a direct question, a meeting request needing a\n" +
  "    yes/no, a document to approve). Automated 'do not reply' mail is never 'reply'.\n" +
  "  • fyi vs noise: 'fyi' is mail the user would want to have seen even if no action is\n" +
  "    needed — receipts, shipping/delivery updates, security alerts, bills, calendar\n" +
  "    invites, statements, personal-but-informational notes. 'noise' is automated chatter\n" +
  "    with no lasting value (social pings, 'someone viewed your profile', app nudges).\n" +
  "  • offers vs newsletter: 'offers' pushes a sale/discount/coupon/limited-time deal.\n" +
  "    'newsletter' delivers editorial or digest content (articles, roundups, product\n" +
  "    updates) even if it ends with a small promo. Judge by the email's primary purpose.\n" +
  "  • unsubscribe vs offers/newsletter: pick 'unsubscribe' for low-value bulk mail the\n" +
  "    user is clearly not engaging with — strong signals are an UNREAD status combined\n" +
  "    with generic mass-marketing from a sender they have no relationship with. If the\n" +
  "    promo/newsletter is from a brand or publication the user plausibly cares about, or\n" +
  "    it's already been read, prefer 'offers'/'newsletter' over 'unsubscribe'.\n\n" +
  "Worked examples (From / Subject / Status -> category: reason):\n" +
  "  • Maria Chen <maria@acme.com> / 'Can you review the Q3 deck before Thursday?' / unread\n" +
  "      -> reply: a colleague is directly asking the user to review and respond by a date.\n" +
  "  • Calendar <invite@calendar.com> / 'Invitation: Design sync @ Fri 2pm' / unread\n" +
  "      -> reply: a meeting invite awaiting the user's accept/decline.\n" +
  "  • Amazon <ship@amazon.com> / 'Your package has shipped' / unread\n" +
  "      -> fyi: a delivery update worth seeing but needing no response.\n" +
  "  • Chase <alerts@chase.com> / 'Your statement is ready' / read\n" +
  "      -> fyi: a financial statement notification, informational and worth keeping.\n" +
  "  • Google <no-reply@accounts.google.com> / 'Security alert: new sign-in' / unread\n" +
  "      -> fyi: a security notice the user should be aware of, no reply expected.\n" +
  "  • LinkedIn <notify@linkedin.com> / 'You appeared in 9 searches this week' / unread\n" +
  "      -> noise: a low-value engagement nudge with nothing actionable or lasting.\n" +
  "  • Nextdoor <digest@nextdoor.com> / 'New replies in your neighborhood' / unread\n" +
  "      -> noise: automated social chatter with no lasting value.\n" +
  "  • Pottery Barn <sale@potterybarn.com> / 'Final hours: 50% off bedding' / unread\n" +
  "      -> offers: a limited-time discount push from a retailer.\n" +
  "  • REI <news@rei.com> / 'Member deals + trail tips for spring' / read\n" +
  "      -> offers: the primary purpose is the member discount, and it has been read.\n" +
  "  • Stratechery <ben@stratechery.com> / 'The Weekly Article: Platform shifts' / read\n" +
  "      -> newsletter: editorial content the user subscribed to and is reading.\n" +
  "  • GitHub <noreply@github.com> / 'Your weekly digest of repository activity' / unread\n" +
  "      -> newsletter: a recurring digest, informational rather than a sale.\n" +
  "  • RandomBoutique <promo@shopxyz.com> / 'Dear friend, 70% off everything!!!' / unread\n" +
  "      -> unsubscribe: generic mass-marketing from an unfamiliar sender, left unread.\n" +
  "  • DealsDaily <blast@dealsdaily.net> / 'You won't believe these prices' / unread\n" +
  "      -> unsubscribe: recurring low-value promotional blast the user isn't opening.\n\n";

const TRIAGE_SYSTEM =
  "You are an inbox triage assistant. Classify each email into exactly one of:\n" +
  CATEGORY_RUBRIC +
  'Return ONLY a JSON array: [{"id":"...","category":"reply|fyi|offers|newsletter|unsubscribe|noise","reason":"one short sentence"}]';

// Sender-level classification: one verdict per sender, applied to all of its
// mail. No "reason" field — at bulk scale the reasons are output tokens (5x
// input price) that nobody reads.
const TRIAGE_SENDER_SYSTEM =
  "You are an inbox triage assistant. You will receive email SENDERS aggregated " +
  "from the user's mailbox — one line per sender with its address, display name, " +
  "how many emails it has in the mailbox, how many of those are unread, whether " +
  "the user has ever written to it, and up to three sample subjects.\n\n" +
  "Classify each SENDER into exactly one of:\n" +
  CATEGORY_RUBRIC +
  "Sender-level guidance: every email from the sender will be filed under your " +
  "chosen category, so judge the sender's typical mail. Reserve 'reply' for " +
  "senders where a human is personally waiting on the user (rare among bulk " +
  "senders). A sender the user has never written to, whose recurring marketing " +
  "mail sits entirely unread, is 'unsubscribe'. 'written to: yes' is a strong " +
  "signal the user values the sender — prefer fyi/newsletter over unsubscribe/noise.\n\n" +
  'Return ONLY a JSON array: [{"sender":"<address>","category":"reply|fyi|offers|newsletter|unsubscribe|noise"}] — no other fields.';

/** A single Claude call, ready for the Batches API or a direct request. */
export interface ClaudeRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export function emailTriageRequest(emails: Email[]): ClaudeRequest {
  const user = emails
    .map((e) => `--- ID: ${e.id} ---\n${emailDigest(e, false)}`)
    .join("\n\n");
  // Sized for a batch of ~50 short result objects with headroom.
  return { system: TRIAGE_SYSTEM, user, maxTokens: 8192 };
}

export interface SenderSummary {
  email: string;
  name: string;
  total: number;
  unread: number;
  replied: boolean;
  sampleSubjects: string[];
}

export interface SenderVerdict {
  sender: string;
  category: Category;
}

export function senderTriageRequest(senders: SenderSummary[]): ClaudeRequest {
  const user = senders
    .map((s) => {
      const subjects = s.sampleSubjects.map((x) => JSON.stringify(x)).join(", ");
      return (
        `${s.email} | name: ${s.name || "(none)"} | emails: ${s.total} | ` +
        `unread: ${s.unread} | written to: ${s.replied ? "yes" : "no"} | subjects: ${subjects}`
      );
    })
    .join("\n");
  return { system: TRIAGE_SENDER_SYSTEM, user, maxTokens: 4096 };
}

/** Run a prepared request directly (the --sync path). */
export async function runRequest(req: ClaudeRequest): Promise<string> {
  return ask(req.system, req.user, req.maxTokens);
}

function parseJsonArray<T>(text: string): T[] {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
  }
  // Tolerate stray prose around the array.
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array in response:\n${text.slice(0, 300)}`);
  }
  return JSON.parse(t.slice(start, end + 1)) as T[];
}

const VALID = new Set<string>(CATEGORIES);

/** Parse per-email results, dropping malformed or unknown-category entries. */
export function parseTriageResults(text: string): TriageResult[] {
  return parseJsonArray<TriageResult>(text).filter(
    (r) => typeof r?.id === "string" && VALID.has(r?.category),
  );
}

/** Parse sender verdicts, dropping malformed or unknown-category entries. */
export function parseSenderVerdicts(text: string): SenderVerdict[] {
  return parseJsonArray<SenderVerdict>(text)
    .filter((r) => typeof r?.sender === "string" && VALID.has(r?.category))
    .map((r) => ({ sender: r.sender.toLowerCase(), category: r.category }));
}

// ── Unsubscribe sweep ───────────────────────────────────────────────────────

export interface UnsubCandidate {
  sender_email: string;
  sender_name: string;
  subject_example: string;
  reason: string;
}

const UNSUB_SYSTEM =
  "You are an email declutter assistant. From the emails below, identify senders that are " +
  "newsletters, marketing lists, or promotional mail the user could safely unsubscribe from. " +
  "Collapse duplicates: one entry per sender.\n\n" +
  'Return ONLY a JSON array: [{"sender_email":"...","sender_name":"...","subject_example":"...","reason":"why"}]';

export async function findUnsubscribeCandidates(emails: Email[]): Promise<UnsubCandidate[]> {
  const user = emails
    .map((e) => {
      const { name, email } = senderOf(e);
      return `From: ${name} <${email}> | Subject: ${e.subject ?? ""}`;
    })
    .join("\n");
  return askJson<UnsubCandidate[]>(UNSUB_SYSTEM, user, 2048);
}

// ── Find & summarize ────────────────────────────────────────────────────────

const SUMMARIZE_SYSTEM =
  "You are an email summarizer. Given a user question and a set of emails, summarize the " +
  "emails to directly answer that question. Use a few bullet points for the key facts, then " +
  "a one-to-two sentence bottom line.";

export async function summarizeThread(emails: Email[], topic: string): Promise<string> {
  const ordered = [...emails].sort((a, b) =>
    (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""),
  );
  const user =
    `The user asked: "${topic}"\n\nEmails:\n\n` +
    ordered.map((e) => emailDigest(e, true)).join("\n\n---\n\n");
  return ask(SUMMARIZE_SYSTEM, user, 1024);
}

// ── Filter / label suggestions ──────────────────────────────────────────────

export interface FilterSuggestion {
  name: string;
  condition: string;
  action: string;
  example_senders: string[];
  rationale: string;
}

const FILTERS_SYSTEM =
  "You are an email organization expert. Based on the emails below, suggest practical " +
  "filter/label rules to keep this inbox organized automatically. Favor a small set of " +
  "high-impact rules over many narrow ones.\n\n" +
  'Return ONLY a JSON array: [{"name":"label/folder","condition":"e.g. from:*.github.com",' +
  '"action":"label|archive|move to folder","example_senders":["..."],"rationale":"why"}]';

export async function suggestFilters(emails: Email[]): Promise<FilterSuggestion[]> {
  const user = emails
    .map((e) => {
      const { name, email } = senderOf(e);
      return `From: ${name} <${email}> | Subject: ${e.subject ?? ""} | Preview: ${(e.preview ?? "").slice(0, 120)}`;
    })
    .join("\n");
  return askJson<FilterSuggestion[]>(FILTERS_SYSTEM, user, 2048);
}
