import { test, expect } from "bun:test";
import { confusion, parseLabels, perCategory, recommend, sweep, type Scored } from "./calibrate.ts";

const items: Scored[] = [
  { label: "newsletter", predicted: "newsletter", confidence: 0.9 },
  { label: "newsletter", predicted: "offers", confidence: 0.2 },
  { label: "offers", predicted: "offers", confidence: 0.6 },
  { label: "reply", predicted: "fyi", confidence: 0.5 },
  { label: "reply", predicted: "reply", confidence: 0.35 },
];

test("sweep counts filed and correct per threshold", () => {
  const rows = sweep(items, [0, 0.3, 0.55, 0.95]);
  expect(rows.map((r) => [r.filed, r.correct])).toEqual([[5, 3], [4, 3], [2, 2], [0, 0]]);
  expect(rows[3]!.accuracy).toBeNull();
});

test("recommend picks the lowest threshold meeting the target", () => {
  const rows = sweep(items, [0, 0.3, 0.55, 0.95]);
  expect(recommend(rows, 0.75)?.threshold).toBe(0.3);
  expect(recommend(rows, 1)?.threshold).toBe(0.55);
  expect(recommend(sweep([items[1]!], [0, 0.5]), 0.9)).toBeNull();
});

test("per-category recall and precision inputs", () => {
  const rows = perCategory(items, 0.3);
  expect(rows.find((r) => r.category === "newsletter")).toEqual({ category: "newsletter", labelled: 2, filedCorrectly: 1, filedAs: 1 });
  expect(rows.find((r) => r.category === "fyi")).toEqual({ category: "fyi", labelled: 0, filedCorrectly: 0, filedAs: 1 });
  expect(rows.some((r) => r.category === "noise")).toBe(false);
});

test("confusion ignores confidence", () => {
  const m = confusion(items);
  expect(m.newsletter.offers).toBe(1);
  expect(m.reply.fyi).toBe(1);
  expect(m.reply.reply).toBe(1);
});

test("label parsing", () => {
  expect([...parseLabels(["Shopping=offers", "Lists/A=newsletter"])]).toEqual([
    ["Shopping", "offers"],
    ["Lists/A", "newsletter"],
  ]);
  expect(() => parseLabels(["Shopping"])).toThrow();
  expect(() => parseLabels(["Shopping=deals"])).toThrow();
});
