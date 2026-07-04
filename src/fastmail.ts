/**
 * Thin wrapper around the `radiosilence/fastmail-cli` binary.
 *
 * That tool handles all JMAP auth + plumbing and emits a uniform JSON envelope:
 *   { success: boolean, data?: T, message?: string, error?: string }
 *
 * We isolate each account by pointing XDG_CONFIG_HOME at a per-account directory
 * so multiple Fastmail accounts never clobber each other's stored token.
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { configDir, type Account } from "./config.ts";

const ENGINE_BIN = process.env.FASTMAIL_CLI_BIN || "fastmail-cli";

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface Email {
  id: string;
  subject?: string;
  from?: EmailAddress[];
  to?: EmailAddress[];
  receivedAt?: string;
  preview?: string;
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
  bodyValues?: Record<string, { value: string }>;
  textBody?: { partId?: string }[];
  htmlBody?: { partId?: string }[];
  // Raw headers fetched by the direct-JMAP path (zero-token bulk-mail heuristics).
  "header:List-Unsubscribe:asRaw"?: string | null;
  "header:List-Id:asRaw"?: string | null;
  "header:Precedence:asRaw"?: string | null;
  "header:Auto-Submitted:asRaw"?: string | null;
}

export interface Mailbox {
  id: string;
  name: string;
  role?: string;
  parentId?: string | null;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface SearchFilters {
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  mailbox?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  before?: string;
  after?: string;
}

export class FastmailEngine {
  constructor(public readonly account: Account) {}

  /** Per-account config home for the underlying engine binary. */
  private engineHome(): string {
    return join(configDir(), "engine", this.account.name);
  }

  private assertEngineInstalled(): void {
    if (Bun.which(ENGINE_BIN)) return;
    throw new Error(
      `The Fastmail engine "${ENGINE_BIN}" is not on PATH.\n` +
        "Install it with: cargo install --git https://github.com/radiosilence/fastmail-cli\n" +
        "(or set FASTMAIL_CLI_BIN to its path).",
    );
  }

  private async ensureAuthed(): Promise<void> {
    this.assertEngineInstalled();
    const home = this.engineHome();
    const tomlPath = join(home, "fastmail-cli", "config.toml");
    if (existsSync(tomlPath)) return;

    mkdirSync(home, { recursive: true });
    const proc = Bun.spawn([ENGINE_BIN, "auth"], {
      env: { ...process.env, XDG_CONFIG_HOME: home },
      stdin: new TextEncoder().encode(this.account.token + "\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(
        `Failed to authenticate engine for account "${this.account.name}": ${err.trim()}`,
      );
    }
  }

  private async run<T>(args: string[]): Promise<T> {
    await this.ensureAuthed();
    const proc = Bun.spawn([ENGINE_BIN, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: this.engineHome() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (code !== 0 && !stdout.trim()) {
      throw new Error(
        `engine \`${args.join(" ")}\` failed (exit ${code}): ${stderr.trim() || "no output"}`,
      );
    }

    let env: Envelope<T>;
    try {
      env = JSON.parse(stdout);
    } catch {
      throw new Error(`engine returned non-JSON output: ${stdout.slice(0, 200)}`);
    }
    if (!env.success) {
      throw new Error(`engine error: ${env.error || env.message || "unknown"}`);
    }
    return env.data as T;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    return this.run<Mailbox[]>(["list", "mailboxes"]);
  }

  async listEmails(opts: { mailbox?: string; limit?: number; unread?: boolean } = {}): Promise<Email[]> {
    // `list emails` has no unread filter; route unread-only through `search`.
    if (opts.unread) {
      return this.search(
        { unread: true, mailbox: opts.mailbox ?? "INBOX" },
        opts.limit ?? 50,
      );
    }
    const args = ["list", "emails"];
    if (opts.mailbox) args.push("--mailbox", opts.mailbox);
    if (opts.limit) args.push("--limit", String(opts.limit));
    const data = await this.run<{ emails: Email[] } | Email[]>(args);
    return Array.isArray(data) ? data : (data.emails ?? []);
  }

  async getEmail(id: string): Promise<Email> {
    return this.run<Email>(["get", id]);
  }

  /** Move an email into a mailbox (resolved by leaf name or role). */
  async moveEmail(id: string, mailbox: string): Promise<void> {
    await this.run<unknown>(["move", "--to", mailbox, id]);
  }

  /** Send a plain-text email (used for mailto: unsubscribe requests). */
  async send(opts: { to: string; subject: string; body: string }): Promise<void> {
    await this.run<unknown>([
      "send",
      "--to", opts.to,
      "--subject", opts.subject,
      "--body", opts.body,
    ]);
  }

  async search(filters: SearchFilters, limit = 20): Promise<Email[]> {
    const args = ["search"];
    if (filters.text) args.push("--text", filters.text);
    if (filters.from) args.push("--from", filters.from);
    if (filters.to) args.push("--to", filters.to);
    if (filters.subject) args.push("--subject", filters.subject);
    if (filters.body) args.push("--body", filters.body);
    if (filters.mailbox) args.push("--mailbox", filters.mailbox);
    if (filters.unread) args.push("--unread");
    if (filters.flagged) args.push("--flagged");
    if (filters.hasAttachment) args.push("--has-attachment");
    if (filters.before) args.push("--before", filters.before);
    if (filters.after) args.push("--after", filters.after);
    args.push("--limit", String(limit));
    const data = await this.run<{ emails: Email[] } | Email[]>(args);
    return Array.isArray(data) ? data : (data.emails ?? []);
  }
}

/** Extract a plain-text body from an Email, falling back to preview. */
export function extractBody(email: Email): string {
  const bodyValues = email.bodyValues ?? {};
  for (const part of email.textBody ?? []) {
    const val = part.partId ? bodyValues[part.partId] : undefined;
    if (val) return val.value;
  }
  // Fall back to first available body value, then preview.
  const first = Object.values(bodyValues)[0];
  if (first?.value) return first.value;
  return email.preview ?? "";
}

export function senderOf(email: Email): { name: string; email: string } {
  const f = email.from?.[0];
  return { name: f?.name ?? "", email: f?.email ?? "" };
}
