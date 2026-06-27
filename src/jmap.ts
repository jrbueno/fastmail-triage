/**
 * Minimal direct JMAP client — used only for operations the engine binary
 * doesn't expose: creating label mailboxes and adding a label to an email
 * *without* removing it from the Inbox.
 *
 * Fastmail "labels" are JMAP mailboxes; an email can belong to several at once.
 * We add a label by patching `mailboxIds/<id>` to true, leaving Inbox intact.
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
    const res = await this.call([
      ["Mailbox/get", { accountId, ids: null }, "0"],
    ]);
    return res.methodResponses[0][1].list as JmapMailbox[];
  }

  private async createMailbox(
    name: string,
    parentId: string | null,
  ): Promise<string> {
    const accountId = await this.accountId();
    const res = await this.call([
      [
        "Mailbox/set",
        { accountId, create: { new: { name, parentId, role: null } } },
        "0",
      ],
    ]);
    const created = res.methodResponses[0][1].created?.new;
    if (!created?.id) {
      const err = res.methodResponses[0][1].notCreated?.new;
      throw new Error(`Failed to create mailbox "${name}": ${JSON.stringify(err)}`);
    }
    return created.id as string;
  }

  /**
   * Ensure a parent mailbox and the given child mailboxes exist.
   * Returns a map of child-name → mailbox id (creating any that are missing).
   */
  async ensureLabelTree(
    parentName: string,
    childNames: string[],
  ): Promise<{ parentId: string; children: Record<string, string> }> {
    const existing = await this.getMailboxes();

    let parent = existing.find((m) => m.name === parentName && m.parentId === null);
    const parentId = parent?.id ?? (await this.createMailbox(parentName, null));

    const children: Record<string, string> = {};
    for (const name of childNames) {
      const child = existing.find((m) => m.name === name && m.parentId === parentId);
      children[name] = child?.id ?? (await this.createMailbox(name, parentId));
    }
    return { parentId, children };
  }

  /**
   * Add a label mailbox to many emails at once, keeping existing mailboxes
   * (e.g. Inbox). `assignments` maps emailId → mailboxId to add.
   */
  async addLabels(assignments: Record<string, string>): Promise<number> {
    const ids = Object.keys(assignments);
    if (ids.length === 0) return 0;
    const accountId = await this.accountId();

    const update: Record<string, Record<string, boolean>> = {};
    for (const [emailId, mailboxId] of Object.entries(assignments)) {
      update[emailId] = { [`mailboxIds/${mailboxId}`]: true };
    }

    const res = await this.call([
      ["Email/set", { accountId, update }, "0"],
    ]);
    const notUpdated = res.methodResponses[0][1].notUpdated;
    if (notUpdated && Object.keys(notUpdated).length > 0) {
      throw new Error(`Some emails could not be labeled: ${JSON.stringify(notUpdated)}`);
    }
    return Object.keys(res.methodResponses[0][1].updated ?? {}).length;
  }
}
