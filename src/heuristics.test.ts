import { test, expect } from "bun:test";
import {
  classifyHeuristically,
  groupBySender,
  hasBulkHeaders,
  isBulkish,
  isNoReplyAddress,
} from "./heuristics.ts";
import type { Email } from "./fastmail.ts";

function email(over: Partial<Email> & { id: string }): Email {
  return { subject: "hi", from: [{ name: "A", email: "a@x.com" }], ...over };
}

test("bulk headers detected", () => {
  expect(hasBulkHeaders(email({ id: "1", "header:List-Unsubscribe:asRaw": "<https://x>" }))).toBe(true);
  expect(hasBulkHeaders(email({ id: "2", "header:List-Id:asRaw": "<list.x.com>" }))).toBe(true);
  expect(hasBulkHeaders(email({ id: "3", "header:Precedence:asRaw": "bulk" }))).toBe(true);
  expect(hasBulkHeaders(email({ id: "4" }))).toBe(false);
});

test("no-reply addresses", () => {
  expect(isNoReplyAddress("no-reply@github.com")).toBe(true);
  expect(isNoReplyAddress("donotreply@bank.com")).toBe(true);
  expect(isNoReplyAddress("notifications@linkedin.com")).toBe(true);
  expect(isNoReplyAddress("maria@acme.com")).toBe(false);
});

test("grouping aggregates unread and bulk", () => {
  const groups = groupBySender([
    email({ id: "1", keywords: { $seen: true }, "header:List-Id:asRaw": "<l>" }),
    email({ id: "2" }), // unread (no $seen)
  ]);
  const g = groups.get("a@x.com")!;
  expect(g.emails.length).toBe(2);
  expect(g.unread).toBe(1);
  expect(g.bulk).toBe(true);
});

test("replied senders are never bulk-ish or heuristically filed", () => {
  const g = groupBySender([email({ id: "1", "header:List-Id:asRaw": "<l>" })]).get("a@x.com")!;
  g.replied = true;
  expect(isBulkish(g)).toBe(false);
  expect(classifyHeuristically(g)).toBeNull();
});

test("entirely-unread recurring bulk → unsubscribe; read bulk → newsletter", () => {
  const unreadBulk = groupBySender([
    email({ id: "1", "header:List-Unsubscribe:asRaw": "<u>" }),
    email({ id: "2", "header:List-Unsubscribe:asRaw": "<u>" }),
  ]).get("a@x.com")!;
  expect(classifyHeuristically(unreadBulk)).toBe("unsubscribe");

  const readBulk = groupBySender([
    email({ id: "1", keywords: { $seen: true }, "header:List-Unsubscribe:asRaw": "<u>" }),
    email({ id: "2", "header:List-Unsubscribe:asRaw": "<u>" }),
  ]).get("a@x.com")!;
  expect(classifyHeuristically(readBulk)).toBe("newsletter");
});

test("personal mail is not classified heuristically", () => {
  const g = groupBySender([email({ id: "1" })]).get("a@x.com")!;
  expect(classifyHeuristically(g)).toBeNull();
  expect(isBulkish(g)).toBe(false);
});
