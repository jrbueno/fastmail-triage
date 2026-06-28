/**
 * Minimal direct-JMAP helper — used for the one thing the engine binary can't
 * do: create mailboxes. The engine still handles the actual `move` of emails.
 *
 * Fastmail folders/labels are JMAP mailboxes; we ensure a `Triage` parent and
 * its category children exist, creating any that are missing.
 */

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
