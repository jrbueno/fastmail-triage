/**
 * Zero-token bulk-mail heuristics, built from signals already in the mailbox:
 *
 *   - RFC 2369/2919 headers (List-Unsubscribe, List-Id) and Precedence: bulk
 *     mark machine-generated bulk mail.
 *   - Auto-Submitted / no-reply sender addresses mark automated notifications.
 *   - "Has the user ever written to this sender?" (a Sent-mailbox query) is
 *     the engagement signal that keeps personal mail out of the bulk tiers.
 *
 * These never claim "reply" — anything plausibly personal is left for the model
 * (or, under --no-ai, left untouched).
 */

import type { Email } from "./fastmail.ts";
import { senderOf } from "./fastmail.ts";

export function hasBulkHeaders(e: Email): boolean {
  if (e["header:List-Unsubscribe:asRaw"]) return true;
  if (e["header:List-Id:asRaw"]) return true;
  const precedence = e["header:Precedence:asRaw"] ?? "";
  return /\b(bulk|list|junk)\b/i.test(precedence);
}

export function isAutoSubmitted(e: Email): boolean {
  const auto = (e["header:Auto-Submitted:asRaw"] ?? "").trim().toLowerCase();
  return auto !== "" && !auto.startsWith("no");
}

const NO_REPLY_RE =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|updates?|news|newsletter|marketing|promo(tions)?|info|hello|mailer(-daemon)?|bounce|postmaster|automated?)([+._-]|@|\d)/i;

export function isNoReplyAddress(address: string): boolean {
  return NO_REPLY_RE.test(address);
}

export function isUnread(e: Email): boolean {
  return e.keywords?.["$seen"] !== true;
}

/** One sender's aggregate view of the mailbox slice being triaged. */
export interface SenderGroup {
  email: string;
  name: string;
  emails: Email[];
  unread: number;
  bulk: boolean; // any message carries bulk-mail headers
  automated: boolean; // every message is auto-submitted or from a no-reply address
  replied: boolean; // the user has written to this sender (Sent mailbox)
}

/** Aggregate emails per sender address (replied is filled in separately). */
export function groupBySender(emails: Email[]): Map<string, SenderGroup> {
  const groups = new Map<string, SenderGroup>();
  for (const e of emails) {
    const { name, email } = senderOf(e);
    const key = email.toLowerCase() || "(unknown)";
    let g = groups.get(key);
    if (!g) {
      g = { email: key, name, emails: [], unread: 0, bulk: false, automated: true, replied: false };
      groups.set(key, g);
    }
    g.emails.push(e);
    if (isUnread(e)) g.unread++;
    if (hasBulkHeaders(e)) g.bulk = true;
    if (!isAutoSubmitted(e) && !isNoReplyAddress(key)) g.automated = false;
    if (!g.name && name) g.name = name;
  }
  return groups;
}

/**
 * A sender is "bulk-ish" when a single sender-level verdict is safe to apply
 * to all of its mail: it sends bulk/automated mail, or it floods the mailbox
 * and the user has never engaged. Personal-looking senders stay per-email.
 */
export function isBulkish(g: SenderGroup): boolean {
  if (g.replied) return false;
  return looksBulk(g);
}

/** Bulk-looking before the Sent-history veto: the senders worth checking in Sent. */
export function looksBulk(g: SenderGroup): boolean {
  return g.bulk || g.automated || g.emails.length >= 5;
}

export type HeuristicCategory = "unsubscribe" | "newsletter" | "fyi" | null;

/**
 * Conservative zero-token classification for --no-ai mode. Returns null when
 * the headers alone aren't conclusive — those emails are left untouched.
 */
export function classifyHeuristically(g: SenderGroup): HeuristicCategory {
  if (g.replied) return null; // engaged sender — never auto-file
  if (g.bulk) {
    // Entirely-unread recurring bulk mail ⇒ the user isn't engaging: unsubscribe.
    if (g.unread === g.emails.length && g.emails.length >= 2) return "unsubscribe";
    return "newsletter";
  }
  // Automated non-bulk mail (receipts, alerts, system notices) is worth
  // skimming but never needs a reply — file as fyi, never noise, since
  // headers can't distinguish a security alert from a social ping.
  if (g.automated) return "fyi";
  return null;
}
