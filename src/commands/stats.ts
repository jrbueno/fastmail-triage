/**
 * Zero-token mailbox report: folder totals, the shape of a mailbox slice
 * (unread, bulk, automated), the heaviest senders, and bulk senders the user
 * never opens. Everything comes from JMAP metadata, headers, the Sent mailbox,
 * and the local stores — no model is called.
 */

import pc from "picocolors";
import { resolveAccounts } from "../config.ts";
import type { Email } from "../fastmail.ts";
import { groupBySender, type SenderGroup } from "../heuristics.ts";
import { JmapClient } from "../jmap.ts";
import { SenderVerdictStore } from "../senderstore.ts";
import { UnsubStore } from "../unsubstore.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  mailbox?: string;
  limit: number;
  all?: boolean;
  top: number;
  sentCheck: boolean;
  json?: boolean;
}

/** A bulk sender needs this many never-opened messages to count as ignored. */
const IGNORED_MIN_EMAILS = 3;

export type SenderKind = "list" | "automated" | "personal";

export interface SenderStat {
  email: string;
  name: string;
  count: number;
  unread: number;
  openedPct: number;
  kind: SenderKind;
  lastReceived: string | null;
  replied: boolean | null; // null when the Sent check was skipped
  verdict: string | null; // cached triage verdict, if any
  unsubscribed: boolean;
}

export interface SliceOverview {
  emails: number;
  senders: number;
  unread: number;
  fromLists: number;
  fromAutomated: number;
  oldest: string | null;
  newest: string | null;
}

export function kindOf(g: SenderGroup): SenderKind {
  if (g.bulk) return "list";
  if (g.automated) return "automated";
  return "personal";
}

function receivedRange(emails: Email[]): { oldest: string | null; newest: string | null } {
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const e of emails) {
    if (!e.receivedAt) continue;
    // ISO-8601 UTC strings compare correctly as strings.
    if (oldest === null || e.receivedAt < oldest) oldest = e.receivedAt;
    if (newest === null || e.receivedAt > newest) newest = e.receivedAt;
  }
  return { oldest, newest };
}

export function overview(emails: Email[], groups: SenderGroup[]): SliceOverview {
  let unread = 0;
  let fromLists = 0;
  let fromAutomated = 0;
  for (const g of groups) {
    unread += g.unread;
    const kind = kindOf(g);
    if (kind === "list") fromLists += g.emails.length;
    else if (kind === "automated") fromAutomated += g.emails.length;
  }
  return { emails: emails.length, senders: groups.length, unread, fromLists, fromAutomated, ...receivedRange(emails) };
}

/** Groups ordered by volume, then by most unread. */
export function byVolume(groups: SenderGroup[]): SenderGroup[] {
  return [...groups].sort((a, b) => b.emails.length - a.emails.length || b.unread - a.unread);
}

/**
 * Bulk senders the user never opens: list mail, every message unread, enough
 * volume to matter. The Sent-history veto and the unsubscribed filter are
 * applied by the caller, once those facts are known.
 */
export function isIgnoredList(g: SenderGroup): boolean {
  return g.bulk && g.emails.length >= IGNORED_MIN_EMAILS && g.unread === g.emails.length;
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export async function statsCommand(opts: Opts): Promise<void> {
  if (!(opts.top > 0)) throw new Error("--top must be a positive number.");
  if (!opts.all && !(opts.limit > 0)) throw new Error("--limit must be a positive number.");
  const limit = opts.all ? Infinity : opts.limit;
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);
    const where = opts.mailbox ?? "Inbox";

    const folders = (await jmap.mailboxesWithPaths()).map((m) => ({
      path: m.path,
      role: m.role,
      total: m.totalEmails ?? 0,
      unread: m.unreadEmails ?? 0,
    }));

    ui.info(`Scanning ${opts.all ? "all" : `up to ${limit}`} emails in ${where}…`);
    const emails = await jmap.fetchAllEmails(
      { mailbox: opts.mailbox, limit, withHeaders: true },
      (n, total) => ui.info(pc.dim(`  fetched ${n}${total !== undefined ? ` of ${Math.min(total, limit)}` : ""}`)),
    );
    const groups = [...groupBySender(emails).values()];
    const unsubStore = new UnsubStore(account.name);
    const verdictStore = new SenderVerdictStore(account.name);

    const ranked = byVolume(groups);
    const top = ranked.slice(0, opts.top);
    // The ignored pool is filtered by Sent history before it is cut to --top,
    // so check every candidate, not just the ones that end up shown.
    const ignoredPool = ranked.filter((g) => isIgnoredList(g) && !unsubStore.has(g.email));

    // Only query Sent for senders that will be shown or filtered, not the
    // whole slice — that's one JMAP call per sender, packed per request.
    let replied: Set<string> | null = null;
    if (opts.sentCheck) {
      const toCheck = [...new Set([...top, ...ignoredPool].map((g) => g.email))];
      ui.info(`Checking Sent history for ${toCheck.length} senders…`);
      replied = await jmap.hasRepliedTo(toCheck);
    }
    const eligible = ignoredPool.filter((g) => !replied?.has(g.email));
    const ignored = eligible.slice(0, opts.top);

    const stat = (g: SenderGroup): SenderStat => ({
      email: g.email,
      name: g.name,
      count: g.emails.length,
      unread: g.unread,
      openedPct: pct(g.emails.length - g.unread, g.emails.length),
      kind: kindOf(g),
      lastReceived: receivedRange(g.emails).newest,
      replied: replied ? replied.has(g.email) : null,
      verdict: verdictStore.get(g.email),
      unsubscribed: unsubStore.has(g.email),
    });
    const topStats = top.map(stat);
    const ignoredStats = ignored.map(stat);
    const slice = overview(emails, groups);

    if (opts.json) {
      console.log(
        JSON.stringify(
          { account: account.name, mailbox: where, folders, overview: slice, topSenders: topStats, ignoredLists: ignoredStats },
          null,
          2,
        ),
      );
      continue;
    }

    ui.header("Folders");
    ui.table({
      head: ["Folder", "Total", "Unread"],
      colWidths: [40, 9, 9],
      rows: folders
        .filter((f) => f.total > 0 || f.role !== null)
        .map((f) => [f.path, String(f.total), f.unread ? String(f.unread) : pc.dim("0")]),
    });

    ui.header(`${where}: ${slice.emails} emails scanned`);
    if (slice.emails === 0) continue;
    const line = (label: string, n: number) =>
      console.log(`  ${label.padEnd(22)} ${String(n).padStart(7)}  ${pc.dim(`${pct(n, slice.emails)}%`)}`);
    console.log(`  ${"Date range".padEnd(22)} ${day(slice.oldest)} → ${day(slice.newest)}`);
    console.log(`  ${"Distinct senders".padEnd(22)} ${String(slice.senders).padStart(7)}`);
    line("Unread", slice.unread);
    line("From mailing lists", slice.fromLists);
    line("Automated", slice.fromAutomated);

    const flags = (s: SenderStat) =>
      [s.replied ? "wrote" : "", s.unsubscribed ? "unsub'd" : ""].filter(Boolean).join(" ");

    ui.header(`Top ${topStats.length} senders by volume`);
    ui.table({
      head: ["Sender", "Email", "#", "Opened", "Kind", "Verdict", "Last", "Flags"],
      colWidths: [20, 32, 6, 8, 11, 13, 12, 10],
      rows: topStats.map((s) => [
        ui.truncate(s.name, 18),
        ui.truncate(s.email, 30),
        String(s.count),
        `${s.openedPct}%`,
        s.kind,
        s.verdict ?? pc.dim("—"),
        day(s.lastReceived),
        flags(s),
      ]),
    });

    ui.header("Never-opened mailing lists");
    if (ignoredStats.length === 0) {
      ui.info(`None: no list sender with ${IGNORED_MIN_EMAILS}+ emails is entirely unread.`);
      continue;
    }
    ui.table({
      head: ["Sender", "Email", "#", "Last"],
      colWidths: [22, 36, 6, 12],
      rows: ignoredStats.map((s) => [ui.truncate(s.name, 20), ui.truncate(s.email, 34), String(s.count), day(s.lastReceived)]),
    });
    const note = replied ? "" : " (Sent history not checked)";
    ui.info(
      `${ignored.reduce((n, g) => n + g.emails.length, 0)} emails from these senders${note}. ` +
        `Unsubscribe with: fastmail-triage unsubscribe -s <email> --apply`,
    );
    const hidden = eligible.length - ignored.length;
    if (hidden > 0) ui.info(pc.dim(`${hidden} more not shown; raise --top to see them.`));
    const vetoed = ignoredPool.length - eligible.length;
    if (vetoed > 0) ui.info(pc.dim(`${vetoed} skipped because you've written to them.`));
  }
}
