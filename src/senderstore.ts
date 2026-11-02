/**
 * Persistent cache of the model's per-sender triage verdicts, so mail from a
 * sender classified once is filed for free on every later run. Only bulk
 * categories (offers / newsletter / politics / career / unsubscribe / noise) are cached —
 * "reply" and "fyi" depend on the individual message, never on the sender alone.
 *
 * Stored at $FASTMAIL_TRIAGE_HOME/sender-verdicts.json:
 *   { "<account>": { "<sender-email>": { "category": "...", "decidedAt": "<ISO>" } } }
 */

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { configDir } from "./config.ts";
import type { Category } from "./classify.ts";

/** Categories that describe the sender, not the individual message. */
export const CACHEABLE_CATEGORIES: ReadonlySet<Category> = new Set([
  "offers",
  "newsletter",
  "politics",
  "career",
  "unsubscribe",
  "noise",
]);

interface Entry {
  category: Category;
  decidedAt: string;
}
type Store = Record<string, Record<string, Entry>>;

function storePath(): string {
  return join(configDir(), "sender-verdicts.json");
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

/** Per-account sender→category verdicts, batched in memory until flush(). */
export class SenderVerdictStore {
  private store: Store;
  private accountKey: string;
  private dirty = false;

  constructor(account: string) {
    this.accountKey = account;
    this.store = load();
    this.store[account] ??= {};
  }

  get(senderEmail: string): Category | null {
    return this.store[this.accountKey]?.[senderEmail.toLowerCase()]?.category ?? null;
  }

  /**
   * Record a verdict in memory. A non-sender-level category isn't cached, and
   * clears any earlier entry so a sender that stopped looking bulk isn't still
   * filed from a stale verdict under --use-cache.
   */
  record(senderEmail: string, category: Category): void {
    const acct = (this.store[this.accountKey] ??= {});
    const key = senderEmail.toLowerCase();
    if (CACHEABLE_CATEGORIES.has(category)) {
      acct[key] = { category, decidedAt: new Date().toISOString() };
    } else if (key in acct) {
      delete acct[key];
    } else {
      return;
    }
    this.dirty = true;
  }

  /** Persist once per run instead of on every record. */
  flush(): void {
    if (!this.dirty) return;
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(this.store, null, 2), { mode: 0o600 });
    this.dirty = false;
  }

  count(): number {
    return Object.keys(this.store[this.accountKey] ?? {}).length;
  }
}
