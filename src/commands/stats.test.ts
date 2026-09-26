import { test, expect } from "bun:test";
import { byVolume, isIgnoredList, kindOf, overview } from "./stats.ts";
import { groupBySender } from "../heuristics.ts";
import type { Email } from "../fastmail.ts";

const LIST = { "header:List-Unsubscribe:asRaw": "<https://x>" };
const SEEN = { keywords: { $seen: true } };

function email(id: string, from: string, over: Partial<Email> = {}): Email {
  return { id, subject: "hi", from: [{ name: "", email: from }], ...over };
}

const emails = [
  email("1", "news@shop.com", { ...LIST, receivedAt: "2026-01-02T00:00:00Z" }),
  email("2", "news@shop.com", { ...LIST, receivedAt: "2026-03-01T00:00:00Z" }),
  email("3", "news@shop.com", LIST),
  email("4", "digest@blog.com", { ...LIST, ...SEEN }),
  email("5", "digest@blog.com", LIST),
  email("6", "digest@blog.com", LIST),
  email("7", "no-reply@bank.com", { receivedAt: "2025-12-31T00:00:00Z" }),
  email("8", "maria@acme.com", SEEN),
];
const groups = [...groupBySender(emails).values()];
const g = (addr: string) => groups.find((x) => x.email === addr)!;

test("sender kinds", () => {
  expect(kindOf(g("news@shop.com"))).toBe("list");
  expect(kindOf(g("no-reply@bank.com"))).toBe("automated");
  expect(kindOf(g("maria@acme.com"))).toBe("personal");
});

test("overview counts and date range", () => {
  const o = overview(emails, groups);
  expect(o).toEqual({
    emails: 8,
    senders: 4,
    unread: 6,
    fromLists: 6,
    fromAutomated: 1,
    oldest: "2025-12-31T00:00:00Z",
    newest: "2026-03-01T00:00:00Z",
  });
});

test("ignored lists need volume and zero opens", () => {
  expect(isIgnoredList(g("news@shop.com"))).toBe(true);
  expect(isIgnoredList(g("digest@blog.com"))).toBe(false); // one opened
  expect(isIgnoredList(g("no-reply@bank.com"))).toBe(false); // not a list
});

test("volume ranking breaks ties on unread", () => {
  expect(byVolume(groups).map((x) => x.email).slice(0, 2)).toEqual(["news@shop.com", "digest@blog.com"]);
});
