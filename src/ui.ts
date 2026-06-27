/** Terminal output helpers. */

import pc from "picocolors";
import Table from "cli-table3";

export function header(text: string): void {
  console.log("\n" + pc.bold(pc.cyan(text)));
}

export function accountBanner(name: string): void {
  console.log(pc.dim("─".repeat(60)));
  console.log(pc.bold(pc.magenta(`▶ Account: ${name}`)));
  console.log(pc.dim("─".repeat(60)));
}

export function info(text: string): void {
  console.log(pc.dim(text));
}

export function warn(text: string): void {
  console.error(pc.yellow(text));
}

export function error(text: string): void {
  console.error(pc.red(text));
}

export function table(opts: { head: string[]; rows: string[][]; colWidths?: number[] }): void {
  const t = new Table({
    head: opts.head.map((h) => pc.bold(h)),
    colWidths: opts.colWidths,
    // wordWrap requires explicit colWidths in cli-table3.
    wordWrap: Boolean(opts.colWidths),
    style: { head: [], border: ["dim"] },
  });
  for (const row of opts.rows) t.push(row);
  console.log(t.toString());
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
