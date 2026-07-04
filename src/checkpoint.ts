/**
 * Crash/Ctrl-C safety for Batches API runs. A batch keeps processing (and
 * billing) server-side after the CLI dies, so the submitted batch ids and the
 * request→email mapping are checkpointed to disk the moment a batch is
 * created. The next triage run reattaches, ingests the finished results, and
 * clears the checkpoint — no tokens are ever paid twice.
 *
 * Stored at $FASTMAIL_TRIAGE_HOME/pending-batch-<account>.json
 */

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { configDir } from "./config.ts";

export interface SenderChunkEntry {
  email: string;
  ids: string[]; // the email ids this sender's verdict applies to
}

export interface BatchCheckpoint {
  batchIds: string[];
  createdAt: string;
  /** custom_id → the senders (and their email ids) that request classified */
  senderChunks: Record<string, SenderChunkEntry[]>;
  /** custom_id → the email ids that request classified individually */
  emailChunks: Record<string, string[]>;
}

function checkpointPath(account: string): string {
  const safe = account.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(configDir(), `pending-batch-${safe}.json`);
}

export function saveCheckpoint(account: string, cp: BatchCheckpoint): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(checkpointPath(account), JSON.stringify(cp, null, 2), { mode: 0o600 });
}

export function loadCheckpoint(account: string): BatchCheckpoint | null {
  const path = checkpointPath(account);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BatchCheckpoint;
  } catch {
    return null;
  }
}

export function clearCheckpoint(account: string): void {
  const path = checkpointPath(account);
  if (existsSync(path)) unlinkSync(path);
}
