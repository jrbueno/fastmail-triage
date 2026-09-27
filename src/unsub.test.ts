import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBodyUnsubUrl } from "./unsub.ts";
import { UnsubStore } from "./unsubstore.ts";

test("prefers a link whose text says unsubscribe", () => {
  const html = `
    <a href="https://shop.com/sale">Shop now</a>
    <a href="https://shop.com/prefs?unsub=1">Preferences</a>
    <a href="https://shop.com/u?id=1&amp;t=2"><span>Unsubscribe</span></a>`;
  expect(extractBodyUnsubUrl(html, "")).toBe("https://shop.com/u?id=1&t=2");
});

test("falls back to an unsubscribe href, then 'unsubscribe … click here'", () => {
  expect(extractBodyUnsubUrl(`<a href='https://x.com/optout/9'>here</a>`, "")).toBe("https://x.com/optout/9");
  expect(extractBodyUnsubUrl(`To unsubscribe, <a href="https://x.com/r/abc">click here</a>`, "")).toBe(
    "https://x.com/r/abc",
  );
});

test("ignores non-https links and unrelated links", () => {
  expect(extractBodyUnsubUrl(`<a href="http://x.com/unsubscribe">Unsubscribe</a>`, "")).toBeNull();
  expect(extractBodyUnsubUrl(`<a href="https://x.com/a">Read more</a>`, "")).toBeNull();
});

test("uses the plain-text body when there's no HTML link", () => {
  const text = "Thanks for reading.\nTo stop these emails visit:\nhttps://x.com/unsubscribe?u=1\n";
  expect(extractBodyUnsubUrl("", text)).toBe("https://x.com/unsubscribe?u=1");
  expect(extractBodyUnsubUrl("", "Unsubscribe: https://x.com/r/1")).toBe("https://x.com/r/1");
});

beforeEach(() => {
  process.env.FASTMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), "unsubstore-"));
});

test("body-link unsubscribes remember the sender and url", () => {
  const store = new UnsubStore("a");
  store.record("News@Shop.com", "https://shop.com/u?id=1");
  store.record("other@shop.com");
  store.flush();
  const reread = new UnsubStore("a");
  expect(reread.has("news@shop.com")).toBe(true);
  expect(reread.urlFor("news@shop.com")).toBe("https://shop.com/u?id=1");
  expect(reread.urlFor("other@shop.com")).toBeNull();
  expect(reread.hasUrl("https://shop.com/u?id=1")).toBe(true);
});
