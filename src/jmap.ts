/**
 * Minimal direct-JMAP helper — fetching (sort order, folder selection,
 * pagination), mailbox creation, and bulk moves, since the engine binary
 * exposes none of these.
 *
 * The client reads the server's advertised core limits (maxObjectsInGet,
 * maxObjectsInSet, maxCallsInRequest, …) from the JMAP session and sizes
 * every bulk operation from them, so large runs (90k+ emails) never exceed
 * what Fastmail will accept in a single request.
 */

import type { Email } from "./fastmail.ts";

const SESSION_URL =
  process.env.JMAP_SESSION_URL || "https://api.fastmail.com/.well-known/jmap";
const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

interface Session {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
  capabilities?: Record<string, Record<string, unknown>>;
}

/** Server-advertised core limits (RFC 8620 §2). */
export interface JmapLimits {
  maxSizeRequest: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  maxConcurrentRequests: number;
}

export interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  totalEmails?: number;
  unreadEmails?: number;
}

/** Standard listing properties for triage. */
const EMAIL_PROPERTIES = [
  "id", "subject", "from", "to", "receivedAt", "preview", "keywords",
];

/** Raw headers fetched alongside, powering the zero-token heuristics. */
export const HEURISTIC_HEADER_PROPERTIES = [
  "header:List-Unsubscribe:asRaw",
  "header:List-Id:asRaw",
  "header:Precedence:asRaw",
  "header:Auto-Submitted:asRaw",
];

export class JmapClient {
  private session: Session | null = null;
  private mailboxCache: JmapMailbox[] | null = null;

  constructor(private readonly token: string) {}

  private async getSession(): Promise<Session> {
    if (this.session) return this.session;
    const resp = await fetch(SESSION_URL, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!resp.ok) {
      throw new Error(`JMAP session request failed (${resp.status})`);
    }
    this.session = (await resp.json()) as Session;
    return this.session;
  }

  private async accountId(): Promise<string> {
    const s = await this.getSession();
    const id = s.primaryAccounts[MAIL_CAPABILITY];
    if (!id) throw new Error("No primary mail account found for this token.");
    return id;
  }

  /** The primary mail account id (for diagnostics like the `limits` command). */
  async primaryAccountId(): Promise<string> {
    return this.accountId();
  }

  /** Core request limits advertised by the server (with RFC minimums as fallback). */
  async limits(): Promise<JmapLimits> {
    const s = await this.getSession();
    const core = (s.capabilities?.[CORE_CAPABILITY] ?? {}) as Record<string, number>;
    return {
      maxSizeRequest: core.maxSizeRequest ?? 10_000_000,
      maxCallsInRequest: core.maxCallsInRequest ?? 16,
      maxObjectsInGet: core.maxObjectsInGet ?? 500,
      maxObjectsInSet: core.maxObjectsInSet ?? 500,
      maxConcurrentRequests: core.maxConcurrentRequests ?? 4,
    };
  }

  async apiUrl(): Promise<string> {
    return (await this.getSession()).apiUrl;
  }

  private async call(methodCalls: unknown[][]): Promise<any> {
    const s = await this.getSession();
    const resp = await fetch(s.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY],
        methodCalls,
      }),
    });
    if (!resp.ok) {
      throw new Error(`JMAP request failed (${resp.status}): ${await resp.text()}`);
    }
    return resp.json();
  }

  /** Low-level escape hatch for diagnostics (the `limits` command's probes). */
  async rawCall(methodCalls: unknown[][]): Promise<any> {
    return this.call(methodCalls);
  }

  /** Mailboxes are stable within a run — fetch once and cache. */
  async getMailboxes(): Promise<JmapMailbox[]> {
    if (this.mailboxCache) return this.mailboxCache;
    const accountId = await this.accountId();
    const res = await this.call([["Mailbox/get", { accountId, ids: null }, "0"]]);
    this.mailboxCache = res.methodResponses[0][1].list as JmapMailbox[];
    return this.mailboxCache;
  }

  /** Every mailbox with its full "Parent/Child" path, sorted by path. */
  async mailboxesWithPaths(): Promise<(JmapMailbox & { path: string })[]> {
    const mailboxes = await this.getMailboxes();
    return mailboxes
      .map((m) => ({ ...m, path: this.pathOf(m, mailboxes) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Resolve a mailbox by leaf name (case-insensitive) or role. */
  private resolveMailbox(mailboxes: JmapMailbox[], selector?: string): JmapMailbox {
    if (!selector) {
      const inbox = mailboxes.find((m) => m.role === "inbox");
      if (!inbox) throw new Error("No Inbox mailbox found.");
      return inbox;
    }
    const lower = selector.toLowerCase();
    // A "Parent/Child" path disambiguates same-named leaves (e.g. a top-level
    // Politics folder vs Triage/Politics). Leaf names stay first-match.
    const match = lower.includes("/")
      ? mailboxes.find((m) => this.pathOf(m, mailboxes).toLowerCase() === lower)
      : (mailboxes.find((m) => m.name.toLowerCase() === lower) ??
        mailboxes.find((m) => m.role === lower));
    if (!match) throw new Error(`Mailbox "${selector}" not found.`);
    return match;
  }

  /** Full "Parent/Child" path of a mailbox, walking parentId to the root. */
  private pathOf(box: JmapMailbox, mailboxes: JmapMailbox[]): string {
    const byId = new Map(mailboxes.map((m) => [m.id, m]));
    const parts = [box.name];
    for (
      let p = box.parentId ? byId.get(box.parentId) : undefined;
      p;
      p = p.parentId ? byId.get(p.parentId) : undefined
    ) {
      parts.unshift(p.name);
    }
    return parts.join("/");
  }

  private async buildFilter(opts: {
    mailbox?: string;
    from?: string;
    unread?: boolean;
  }): Promise<Record<string, unknown>> {
    const mailboxes = await this.getMailboxes();
    const filter: Record<string, unknown> = {};
    // Default to Inbox unless an explicit folder, or a sender-wide search, is given.
    if (opts.mailbox) {
      filter.inMailbox = this.resolveMailbox(mailboxes, opts.mailbox).id;
    } else if (!opts.from) {
      filter.inMailbox = this.resolveMailbox(mailboxes, undefined).id;
    }
    if (opts.from) filter.from = opts.from;
    if (opts.unread) filter.notKeyword = "$seen";
    return filter;
  }

  /**
   * Query emails from a mailbox with full control over sort order, unread
   * filtering, and limit.
   */
  async queryEmails(opts: {
    mailbox?: string;
    from?: string;
    unread?: boolean;
    oldestFirst?: boolean;
    limit?: number;
    offset?: number;
    withHeaders?: boolean;
    calculateTotal?: boolean;
  }): Promise<{ emails: Email[]; total?: number }> {
    const accountId = await this.accountId();
    const filter = await this.buildFilter(opts);
    const properties = opts.withHeaders
      ? [...EMAIL_PROPERTIES, ...HEURISTIC_HEADER_PROPERTIES]
      : EMAIL_PROPERTIES;

    const res = await this.call([
      [
        "Email/query",
        {
          accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: Boolean(opts.oldestFirst) }],
          position: opts.offset ?? 0,
          limit: opts.limit ?? 50,
          calculateTotal: Boolean(opts.calculateTotal),
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties,
        },
        "g",
      ],
    ]);
    return {
      emails: res.methodResponses[1][1].list as Email[],
      total: res.methodResponses[0][1].total as number | undefined,
    };
  }

  /**
   * Fetch every matching email (up to `limit`) by paging Email/query+Email/get,
   * page size bounded by the server's maxObjectsInGet. Dedupes by id, so mail
   * arriving mid-run can't produce duplicates.
   */
  async fetchAllEmails(
    opts: {
      mailbox?: string;
      unread?: boolean;
      oldestFirst?: boolean;
      limit: number;
      withHeaders?: boolean;
    },
    onProgress?: (fetched: number, total?: number) => void,
  ): Promise<Email[]> {
    // Fastmail advertises maxObjectsInGet=4096; cap pages at 2000 to keep
    // responses (with the heuristic headers) comfortably a few MB.
    const limits = await this.limits();
    const pageSize = Math.min(2000, limits.maxObjectsInGet);
    const seen = new Set<string>();
    const all: Email[] = [];
    let position = 0;
    let total: number | undefined;

    while (all.length < opts.limit) {
      const want = Math.min(pageSize, opts.limit - all.length);
      const page = await this.queryEmails({
        mailbox: opts.mailbox,
        unread: opts.unread,
        oldestFirst: opts.oldestFirst,
        limit: want,
        offset: position,
        withHeaders: opts.withHeaders,
        calculateTotal: position === 0,
      });
      if (page.total !== undefined) total = page.total;
      if (page.emails.length === 0) break;
      position += page.emails.length;
      for (const e of page.emails) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          all.push(e);
        }
      }
      onProgress?.(all.length, total);
      if (page.emails.length < want) break; // exhausted
    }
    return all;
  }

  /** Fetch specific emails by id (chunked to maxObjectsInGet); missing ids are skipped. */
  async getEmailsByIds(ids: string[]): Promise<Email[]> {
    if (ids.length === 0) return [];
    const accountId = await this.accountId();
    const limits = await this.limits();
    const out: Email[] = [];
    for (let i = 0; i < ids.length; i += limits.maxObjectsInGet) {
      const chunk = ids.slice(i, i + limits.maxObjectsInGet);
      const res = await this.call([
        ["Email/get", { accountId, ids: chunk, properties: EMAIL_PROPERTIES }, "0"],
      ]);
      out.push(...(res.methodResponses[0][1].list as Email[]));
    }
    return out;
  }

  /**
   * Check which of the given sender addresses the user has ever written to
   * (any message in Sent addressed to them) — a zero-token engagement signal.
   * Queries are packed maxCallsInRequest-deep per HTTP round-trip.
   */
  async hasRepliedTo(senderEmails: string[]): Promise<Set<string>> {
    const replied = new Set<string>();
    if (senderEmails.length === 0) return replied;

    const mailboxes = await this.getMailboxes();
    const sent = mailboxes.find((m) => m.role === "sent");
    if (!sent) return replied;

    const accountId = await this.accountId();
    const limits = await this.limits();
    const perRequest = Math.max(1, Math.min(limits.maxCallsInRequest, 32));

    for (let i = 0; i < senderEmails.length; i += perRequest) {
      const chunk = senderEmails.slice(i, i + perRequest);
      const calls = chunk.map((email, j) => [
        "Email/query",
        { accountId, filter: { inMailbox: sent.id, to: email }, limit: 1 },
        `q${j}`,
      ]);
      const res = await this.call(calls);
      for (const [name, args, tag] of res.methodResponses as [string, any, string][]) {
        if (name !== "Email/query") continue;
        const idx = parseInt(tag.slice(1), 10);
        const email = chunk[idx];
        if (email && Array.isArray(args.ids) && args.ids.length > 0) {
          replied.add(email);
        }
      }
    }
    return replied;
  }

  /**
   * Fetch List-Unsubscribe info for the given emails (RFC 2369 / RFC 8058),
   * chunked to the server's maxObjectsInGet.
   */
  async getUnsubscribeInfo(
    ids: string[],
  ): Promise<{ id: string; senderEmail: string; senderName: string; urls: string[]; oneClick: boolean }[]> {
    if (ids.length === 0) return [];
    const accountId = await this.accountId();
    const limits = await this.limits();
    const out: { id: string; senderEmail: string; senderName: string; urls: string[]; oneClick: boolean }[] = [];

    for (let i = 0; i < ids.length; i += limits.maxObjectsInGet) {
      const chunk = ids.slice(i, i + limits.maxObjectsInGet);
      const res = await this.call([
        [
          "Email/get",
          {
            accountId,
            ids: chunk,
            properties: [
              "id",
              "from",
              // Typed asURLs is convenient but returns null for RFC 2047
              // encoded-word headers; keep the raw header as a fallback.
              "header:List-Unsubscribe:asURLs",
              "header:List-Unsubscribe",
              "header:List-Unsubscribe-Post:asText",
            ],
          },
          "0",
        ],
      ]);
      const list = res.methodResponses[0][1].list as any[];
      for (const e of list) {
        const from = e.from?.[0] ?? {};
        const typed = (e["header:List-Unsubscribe:asURLs"] ?? null) as string[] | null;
        const urls = typed && typed.length > 0
          ? typed
          : parseListUnsubscribe(e["header:List-Unsubscribe"] ?? "");
        const post = (e["header:List-Unsubscribe-Post:asText"] ?? "") as string;
        out.push({
          id: e.id as string,
          senderEmail: (from.email ?? "") as string,
          senderName: (from.name ?? "") as string,
          urls,
          oneClick: /one-click/i.test(post),
        });
      }
    }
    return out;
  }

  private async createMailbox(name: string, parentId: string | null): Promise<string> {
    const accountId = await this.accountId();
    const res = await this.call([
      ["Mailbox/set", { accountId, create: { new: { name, parentId, role: null } } }, "0"],
    ]);
    const created = res.methodResponses[0][1].created?.new;
    if (!created?.id) {
      const err = res.methodResponses[0][1].notCreated?.new;
      throw new Error(`Failed to create mailbox "${name}": ${JSON.stringify(err)}`);
    }
    this.mailboxCache = null; // mailbox tree changed
    return created.id as string;
  }

  /**
   * Ensure a parent mailbox and the given child mailboxes exist, creating any
   * that are missing. Returns each child name mapped to its mailbox id, plus
   * the list of mailboxes that were newly created.
   */
  async ensureLabelTree(
    parentName: string,
    childNames: string[],
  ): Promise<{ ids: Record<string, string>; created: string[] }> {
    const existing = await this.getMailboxes();
    const created: string[] = [];

    let parent = existing.find((m) => m.name === parentName && m.parentId === null);
    let parentId: string;
    if (parent) {
      parentId = parent.id;
    } else {
      parentId = await this.createMailbox(parentName, null);
      created.push(parentName);
    }

    const ids: Record<string, string> = {};
    for (const name of childNames) {
      const child = existing.find((m) => m.name === name && m.parentId === parentId);
      if (child) {
        ids[name] = child.id;
      } else {
        ids[name] = await this.createMailbox(name, parentId);
        created.push(`${parentName}/${name}`);
      }
    }
    return { ids, created };
  }

  /**
   * Move emails into a mailbox resolved by name or role (e.g. "archive",
   * "trash", or a folder name). Returns the number moved.
   */
  async moveEmailsTo(ids: string[], selector: string): Promise<number> {
    if (ids.length === 0) return 0;
    const mailboxes = await this.getMailboxes();
    const box = this.resolveMailbox(mailboxes, selector);
    return this.moveEmails(ids, box.id);
  }

  /**
   * Move many emails into a single mailbox at once (replaces mailbox
   * membership, so they leave the Inbox). Returns the number moved.
   */
  async moveEmails(ids: string[], mailboxId: string): Promise<number> {
    const dest = new Map(ids.map((id) => [id, mailboxId]));
    const { moved, failed } = await this.moveEmailsBulk(dest);
    if (failed.length > 0) {
      throw new Error(`Some emails could not be moved: ${failed.length} failed`);
    }
    return moved;
  }

  /**
   * Move many emails, each to its own destination mailbox, in as few
   * Email/set calls as the server's maxObjectsInSet allows (mixed
   * destinations are fine — one update map covers all categories).
   * Partial failures are returned, not thrown, so one bad message can't
   * abort a 90k run.
   */
  async moveEmailsBulk(
    destinations: Map<string, string>,
    onProgress?: (moved: number, total: number) => void,
  ): Promise<{ moved: number; failed: string[] }> {
    if (destinations.size === 0) return { moved: 0, failed: [] };
    const accountId = await this.accountId();
    const limits = await this.limits();
    const chunkSize = Math.max(1, limits.maxObjectsInSet);

    const entries = [...destinations];
    let moved = 0;
    const failed: string[] = [];

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const update: Record<string, unknown> = {};
      for (const [id, mailboxId] of chunk) {
        update[id] = { mailboxIds: { [mailboxId]: true } };
      }
      const res = await this.call([["Email/set", { accountId, update }, "0"]]);
      const body = res.methodResponses[0][1];
      moved += Object.keys(body.updated ?? {}).length;
      for (const id of Object.keys(body.notUpdated ?? {})) failed.push(id);
      onProgress?.(moved, entries.length);
    }
    return { moved, failed };
  }
}

/** Decode RFC 2047 encoded-words (Q and B) in a header value. */
function decodeEncodedWords(s: string): string {
  // Adjacent encoded-words separated only by whitespace must be joined.
  const joined = s.replace(/\?=\s+=\?/g, "?==?");
  return joined.replace(
    /=\?[^?]+\?([BbQq])\?([^?]*)\?=/g,
    (_full, enc: string, text: string) => {
      if (enc.toUpperCase() === "B") {
        try {
          return Buffer.from(text, "base64").toString("latin1");
        } catch {
          return "";
        }
      }
      // Q-encoding: '_' is space, '=XX' is a hex byte.
      return text
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        );
    },
  );
}

/**
 * Parse a raw `List-Unsubscribe` header into its target URLs, decoding any
 * RFC 2047 encoding first. Handles `<https://…>, <mailto:…>` forms.
 */
export function parseListUnsubscribe(raw: string): string[] {
  if (!raw) return [];
  const decoded = decodeEncodedWords(raw);
  const urls: string[] = [];
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoded))) urls.push(m[1]!.trim());
  if (urls.length > 0) return urls;
  // No angle brackets — fall back to comma-splitting bare tokens.
  return decoded
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^(https?:|mailto:)/i.test(x));
}
