/**
 * Minimal direct-JMAP helper — used for the one thing the engine binary can't
 * do: create mailboxes. The engine still handles the actual `move` of emails.
 *
 * Fastmail folders/labels are JMAP mailboxes; we ensure a `Triage` parent and
 * its category children exist, creating any that are missing.
 */

import type { Email } from "./fastmail.ts";

const SESSION_URL =
  process.env.JMAP_SESSION_URL || "https://api.fastmail.com/.well-known/jmap";
const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

interface Session {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

export interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
}

export class JmapClient {
  private session: Session | null = null;

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

  private async call(methodCalls: unknown[][]): Promise<any> {
    const s = await this.getSession();
    const resp = await fetch(s.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", MAIL_CAPABILITY],
        methodCalls,
      }),
    });
    if (!resp.ok) {
      throw new Error(`JMAP request failed (${resp.status}): ${await resp.text()}`);
    }
    return resp.json();
  }

  async getMailboxes(): Promise<JmapMailbox[]> {
    const accountId = await this.accountId();
    const res = await this.call([["Mailbox/get", { accountId, ids: null }, "0"]]);
    return res.methodResponses[0][1].list as JmapMailbox[];
  }

  /** Resolve a mailbox by leaf name (case-insensitive) or role. */
  private resolveMailbox(mailboxes: JmapMailbox[], selector?: string): JmapMailbox {
    if (!selector) {
      const inbox = mailboxes.find((m) => m.role === "inbox");
      if (!inbox) throw new Error("No Inbox mailbox found.");
      return inbox;
    }
    const lower = selector.toLowerCase();
    const match =
      mailboxes.find((m) => m.name.toLowerCase() === lower) ??
      mailboxes.find((m) => m.role === lower);
    if (!match) throw new Error(`Mailbox "${selector}" not found.`);
    return match;
  }

  /**
   * Query emails from a mailbox with full control over sort order, unread
   * filtering, and limit — capabilities the engine binary doesn't expose.
   */
  async queryEmails(opts: {
    mailbox?: string;
    from?: string;
    unread?: boolean;
    oldestFirst?: boolean;
    limit?: number;
  }): Promise<Email[]> {
    const accountId = await this.accountId();
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

    const res = await this.call([
      [
        "Email/query",
        {
          accountId,
          filter,
          sort: [{ property: "receivedAt", isAscending: Boolean(opts.oldestFirst) }],
          limit: opts.limit ?? 50,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["id", "subject", "from", "to", "receivedAt", "preview", "keywords"],
        },
        "g",
      ],
    ]);
    return res.methodResponses[1][1].list as Email[];
  }

  /**
   * Fetch List-Unsubscribe info for the given emails (RFC 2369 / RFC 8058).
   * `urls` are the parsed targets (mailto: and/or https:); `oneClick` is true
   * when the sender supports RFC 8058 one-click POST unsubscribe.
   */
  async getUnsubscribeInfo(
    ids: string[],
  ): Promise<{ id: string; senderEmail: string; senderName: string; urls: string[]; oneClick: boolean }[]> {
    if (ids.length === 0) return [];
    const accountId = await this.accountId();
    const res = await this.call([
      [
        "Email/get",
        {
          accountId,
          ids,
          properties: [
            "id",
            "from",
            "header:List-Unsubscribe:asURLs",
            "header:List-Unsubscribe-Post:asText",
          ],
        },
        "0",
      ],
    ]);
    const list = res.methodResponses[0][1].list as any[];
    return list.map((e) => {
      const from = e.from?.[0] ?? {};
      const urls = (e["header:List-Unsubscribe:asURLs"] ?? []) as string[];
      const post = (e["header:List-Unsubscribe-Post:asText"] ?? "") as string;
      return {
        id: e.id as string,
        senderEmail: (from.email ?? "") as string,
        senderName: (from.name ?? "") as string,
        urls,
        oneClick: /one-click/i.test(post),
      };
    });
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
    return created.id as string;
  }

  /**
   * Ensure a parent mailbox and the given child mailboxes exist, creating any
   * that are missing. Returns the names of mailboxes that were newly created.
   */
  async ensureLabelTree(parentName: string, childNames: string[]): Promise<string[]> {
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

    for (const name of childNames) {
      const child = existing.find((m) => m.name === name && m.parentId === parentId);
      if (!child) {
        await this.createMailbox(name, parentId);
        created.push(`${parentName}/${name}`);
      }
    }
    return created;
  }
}
