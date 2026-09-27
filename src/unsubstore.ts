/**
 * Persistent record of senders we've already unsubscribed from, so re-runs
 * skip the unsubscribe request and just file their mail via --then.
 *
 * Records are buffered in memory and persisted by flush() — call it after the
 * apply loop (in a finally, so a mid-run failure keeps what succeeded) instead
 * of rewriting the whole file once per sender.
 *
 * Stored at $FASTMAIL_TRIAGE_HOME/unsubscribed.json:
 *   { "<account>": { "<sender-email>": { "unsubscribedAt": "<ISO>" } } }
 */

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { configDir } from "./config.ts";

interface Entry {
  unsubscribedAt: string;
  /** Set when the unsubscribe went through a link found in the email body. */
  url?: string;
}
type Store = Record<string, Record<string, Entry>>;

function storePath(): string {
  return join(configDir(), "unsubscribed.json");
}

function load(): Store {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(storePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Tracks unsubscribed senders for one account, with in-memory caching. */
export class UnsubStore {
  private store: Store;
  private accountKey: string;
  private dirty = false;

  constructor(account: string) {
    this.accountKey = account;
    this.store = load();
    this.store[account] ??= {};
  }

  has(senderEmail: string): boolean {
    return Boolean(this.store[this.accountKey]?.[senderEmail.toLowerCase()]);
  }

  /** Record a sender as unsubscribed in memory; persisted by flush(). */
  record(senderEmail: string, url?: string): void {
    const acct = (this.store[this.accountKey] ??= {});
    acct[senderEmail.toLowerCase()] = {
      unsubscribedAt: new Date().toISOString(),
      ...(url ? { url } : {}),
    };
    this.dirty = true;
  }

  /** The body link a sender was unsubscribed through, if any. */
  urlFor(senderEmail: string): string | null {
    return this.store[this.accountKey]?.[senderEmail.toLowerCase()]?.url ?? null;
  }

  /** True if some sender was already unsubscribed through this exact body link. */
  hasUrl(url: string): boolean {
    return Object.values(this.store[this.accountKey] ?? {}).some((e) => e.url === url);
  }

  /** Persist once per run instead of on every record. */
  flush(): void {
    if (!this.dirty) return;
    save(this.store);
    this.dirty = false;
  }

  count(): number {
    return Object.keys(this.store[this.accountKey] ?? {}).length;
  }
}
