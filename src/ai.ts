/**
 * Claude-powered analysis for the four inbox tasks.
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Email, extractBody, senderOf } from "./fastmail.ts";

// Sonnet is the sweet spot for bulk email classification: fast + cheap + sharp.
const MODEL = process.env.FASTMAIL_TRIAGE_MODEL || "claude-sonnet-4-6";

let client: Anthropic | null = null;
function getClient(): Anthropic {
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

// Stable across every batch in a run → lives in the cached system prompt.
const TRIAGE_SYSTEM =
  "You are an inbox triage assistant. Classify each email into exactly one of:\n" +
  "  - reply: needs a personal response from the user\n" +
  "  - fyi: informational, worth skimming, no reply needed (receipts, alerts, confirmations)\n" +
  "  - offers: promotional sales, discounts, deals, marketing from retailers\n" +
  "  - newsletter: recurring subscriptions, digests, editorial content you signed up for\n" +
  "  - unsubscribe: low-value bulk/marketing/newsletter mail the user clearly doesn't engage\n" +
  "      with and should stop receiving — favor this when such mail is left unread.\n" +
  "  - noise: automated notifications or spam that fit none of the above — safe to ignore\n\n" +
  "Use 'unsubscribe' for recurring promo/newsletter clutter of little value (especially if\n" +
  "unread); use 'offers'/'newsletter' for mail of that type the user may still want.\n\n" +
  'Return ONLY a JSON array: [{"id":"...","category":"reply|fyi|offers|newsletter|unsubscribe|noise","reason":"one short sentence"}]';

export async function triageEmails(emails: Email[]): Promise<TriageResult[]> {
  const user = emails
    .map((e) => `--- ID: ${e.id} ---\n${emailDigest(e, false)}`)
    .join("\n\n");
  // Sized for a batch of ~50 short result objects with headroom.
  return askJson<TriageResult[]>(TRIAGE_SYSTEM, user, 8192);
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
