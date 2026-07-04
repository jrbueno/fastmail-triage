/**
 * Message Batches API plumbing: submit every classification call of a run as
 * one batch job at 50% of standard token prices, poll until it ends, and
 * return the raw text per custom_id. Individual request failures come back in
 * an errors map — one bad request can't abort a 90k-email run.
 *
 * The --sync path (runClaudeDirect) runs the same requests as concurrent
 * direct calls for small interactive runs where batch latency isn't worth it.
 */

import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { getClient, MODEL, type ClaudeRequest } from "./ai.ts";

export interface ClaudeOutcome {
  /** custom id → response text */
  results: Map<string, string>;
  /** custom id → error description */
  errors: Map<string, string>;
}

// Batches accept up to 100k requests / 256MB; our runs are far below either
// bound, but chunk defensively so the code never has to care.
const MAX_REQUESTS_PER_BATCH = 10_000;

function toParams(req: ClaudeRequest): MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: req.maxTokens,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: req.user }],
  };
}

export async function runClaudeBatch(
  requests: Map<string, ClaudeRequest>,
  onProgress?: (done: number, total: number, status: string) => void,
): Promise<ClaudeOutcome> {
  const client = getClient();
  const results = new Map<string, string>();
  const errors = new Map<string, string>();
  const entries = [...requests];

  for (let i = 0; i < entries.length; i += MAX_REQUESTS_PER_BATCH) {
    const slice = entries.slice(i, i + MAX_REQUESTS_PER_BATCH);
    const batch = await client.messages.batches.create({
      requests: slice.map(([customId, req]) => ({
        custom_id: customId,
        params: toParams(req),
      })),
    });

    // Poll fast at first (small batches often finish in under a minute),
    // then back off to 30s.
    let status = batch;
    let waited = 0;
    while (status.processing_status !== "ended") {
      const delay = waited < 60_000 ? 5_000 : 30_000;
      await Bun.sleep(delay);
      waited += delay;
      status = await client.messages.batches.retrieve(batch.id);
      const c = status.request_counts;
      onProgress?.(
        c.succeeded + c.errored + c.canceled + c.expired,
        slice.length,
        status.processing_status,
      );
    }

    // Results arrive in arbitrary order — always key by custom_id.
    for await (const result of await client.messages.batches.results(batch.id)) {
      const r = result.result;
      if (r.type === "succeeded") {
        const text = r.message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("");
        results.set(result.custom_id, text);
      } else if (r.type === "errored") {
        errors.set(result.custom_id, JSON.stringify(r.error));
      } else {
        errors.set(result.custom_id, r.type); // canceled | expired
      }
    }
  }
  return { results, errors };
}

/** Direct calls with bounded concurrency — the --sync escape hatch. */
export async function runClaudeDirect(
  requests: Map<string, ClaudeRequest>,
  onProgress?: (done: number, total: number, status: string) => void,
  concurrency = 4,
): Promise<ClaudeOutcome> {
  const client = getClient();
  const results = new Map<string, string>();
  const errors = new Map<string, string>();
  const entries = [...requests];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (next < entries.length) {
      const [customId, req] = entries[next++]!;
      try {
        const resp = await client.messages.create(toParams(req));
        const text = resp.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("");
        results.set(customId, text);
      } catch (err) {
        errors.set(customId, (err as Error).message);
      }
      done++;
      onProgress?.(done, entries.length, "in_progress");
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()),
  );
  return { results, errors };
}
