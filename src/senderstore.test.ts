import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SenderVerdictStore } from "./senderstore.ts";

beforeEach(() => {
  process.env.FASTMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), "senderstore-"));
});

test("bulk verdicts are cached across runs", () => {
  const store = new SenderVerdictStore("a");
  store.record("News@Shop.com", "newsletter");
  store.flush();
  expect(new SenderVerdictStore("a").get("news@shop.com")).toBe("newsletter");
});

test("a non-bulk verdict clears the sender's cached entry", () => {
  const first = new SenderVerdictStore("a");
  first.record("news@shop.com", "newsletter");
  first.flush();

  const second = new SenderVerdictStore("a");
  second.record("news@shop.com", "reply");
  second.flush();
  expect(new SenderVerdictStore("a").get("news@shop.com")).toBeNull();
});

test("a non-bulk verdict for an uncached sender is a no-op", () => {
  const store = new SenderVerdictStore("a");
  store.record("friend@example.com", "fyi");
  expect(store.count()).toBe(0);
});
