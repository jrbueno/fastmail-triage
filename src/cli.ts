#!/usr/bin/env bun
import { Command } from "commander";
import * as ui from "./ui.ts";
import { triageCommand } from "./commands/triage.ts";
import { unsubscribeCommand } from "./commands/unsubscribe.ts";
import { findCommand } from "./commands/find.ts";
import { filtersCommand } from "./commands/filters.ts";
import { limitsCommand } from "./commands/limits.ts";
import { statsCommand } from "./commands/stats.ts";
import { calibrateCommand } from "./commands/calibrate.ts";
import {
  accountAdd,
  accountList,
  accountRemove,
  accountDefault,
} from "./commands/account.ts";

const program = new Command();

program
  .name("fastmail-triage")
  .description("AI-powered Fastmail inbox assistant (triage, unsubscribe, stats, calibrate, find, filters).")
  .version("0.1.0");

// Shared --account option: a name, or "all" to fan out across every account.
const accountOpt = ["-a, --account <name>", 'account name, or "all" for every account'] as const;

program
  .command("triage")
  .description("Sort mail into reply / fyi / offers / newsletter / politics / noise and file it under Triage/")
  .option(...accountOpt)
  .option("-n, --limit <n>", "max emails to process", (v) => parseInt(v, 10), 50)
  .option("--min-confidence <n>", "leave mail in place when the model's confidence is below this (0-1)", parseFloat, 0.3)
  .option("-m, --mailbox <name>", 'folder to triage, leaf or "Parent/Child" path (default: Inbox)')
  .option("--oldest", "start with the oldest emails instead of newest", false)
  .option("--all", "include read mail, not just unread", false)
  .option("--unread", "unread only (use with --all to drain every unread email)", false)
  .option("--include-pinned", "triage pinned (flagged) mail too; by default it's never fetched, classified, or moved", false)
  .option("--skip-unsubscribed", "file mail from already-unsubscribed senders straight to Triage/Unsubscribe (no model call)", false)
  .option("--no-ai", "zero-token mode: classify from bulk-mail headers + Sent history only")
  .option("--use-cache", "file senders decided in an earlier run from sender-verdicts.json (no model call)", false)
  .option("--dry-run", "preview only — don't move anything", false)
  .option("--json", "output raw JSON (implies no moving)", false)
  .action((opts) => run(() => triageCommand(opts)));

program
  .command("limits")
  .description("Show Fastmail's JMAP limits and probe large-request handling (read-only)")
  .option(...accountOpt)
  .option("--no-probe", "skip the live large-request probes")
  .action((opts) => run(() => limitsCommand(opts)));

program
  .command("calibrate")
  .description("Measure triage accuracy on already-filed mail and recommend a --min-confidence")
  .option(...accountOpt)
  .option("-n, --per-folder <n>", "newest emails to sample from each labelled folder", (v) => parseInt(v, 10), 40)
  .option(
    "-l, --label <folder=category>",
    'label a folder you filed by hand, e.g. "Shopping=offers" (repeatable)',
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .option("--no-triage-folders", "don't sample the Triage/* folders; use only --label folders")
  .option("--target <p>", "accuracy the recommended threshold must reach (0-1)", parseFloat, 0.9)
  .option("--json", "output raw JSON (sweep + every scored email)", false)
  .action((opts) => run(() => calibrateCommand(opts)));

program
  .command("stats")
  .description("Report folder totals, top senders, and never-opened mailing lists (no model calls)")
  .option(...accountOpt)
  .option("-m, --mailbox <name>", 'folder to scan, leaf or "Parent/Child" path (default: Inbox)')
  .option("-n, --limit <n>", "max emails to scan, newest first", (v) => parseInt(v, 10), 5000)
  .option("--all", "scan the whole folder, ignoring --limit", false)
  .option("-t, --top <n>", "rows per sender table", (v) => parseInt(v, 10), 20)
  .option("--no-sent-check", "skip the Sent-history lookup (faster; ignored lists aren't vetted)")
  .option("--json", "output raw JSON", false)
  .action((opts) => run(() => statsCommand(opts)));

program
  .command("unsubscribe")
  .description("Find newsletters/promos and actually unsubscribe (List-Unsubscribe)")
  .option(...accountOpt)
  .option("-n, --limit <n>", "max emails to scan (page size with --all)", (v) => parseInt(v, 10), 100)
  .option("--all", "scan the entire scope, paginating past --limit", false)
  .option("-m, --mailbox <name>", 'scan a reviewed folder, leaf or "Parent/Child" path (e.g. Triage/Unsubscribe); every sender is a target')
  .option("-s, --sender <email>", "target a single sender")
  .option("--apply", "actually unsubscribe (default: preview only)", false)
  .option("--then <dest>", 'after a successful unsubscribe, move that sender\'s mail (archive | trash | <folder>, leaf or "Parent/Child" path)')
  .option("--skip-no-header", "ignore senders with no List-Unsubscribe header", false)
  .option("--min-probability <p>", "Inbox scan: only target senders the model rates at least this likely to be safe to leave (0-1)", parseFloat, 0.7)
  .option("--json", "output raw JSON", false)
  .action((opts) => run(() => unsubscribeCommand(opts)));

program
  .command("find <query...>")
  .description('Search a topic/thread and summarize it, e.g. "Q3 launch marketing"')
  .option(...accountOpt)
  .option("-n, --limit <n>", "max emails to fetch", (v) => parseInt(v, 10), 20)
  .option("--from <email>", "restrict to a sender")
  .option("--after <date>", "only mail after YYYY-MM-DD")
  .option("--before <date>", "only mail before YYYY-MM-DD")
  .action((query: string[], opts) => run(() => findCommand(query.join(" "), opts)));

program
  .command("filters")
  .description("Suggest filter/label rules based on your inbox")
  .option(...accountOpt)
  .option("-n, --limit <n>", "max emails to analyze", (v) => parseInt(v, 10), 100)
  .option("--json", "output raw JSON", false)
  .action((opts) => run(() => filtersCommand(opts)));

// ── account management ───────────────────────────────────────────────────────
const account = program.command("account").description("Manage Fastmail accounts");
account
  .command("add <name>")
  .description("Add or update an account (token via prompt or FASTMAIL_TOKEN)")
  .option("--default", "make this the default account", false)
  .action((name, opts) => run(() => accountAdd(name, opts)));
account.command("list").description("List configured accounts").action(() => run(async () => accountList()));
account.command("remove <name>").description("Remove an account").action((name) => run(async () => accountRemove(name)));
account.command("default <name>").description("Set the default account").action((name) => run(async () => accountDefault(name)));

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ui.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

program.parseAsync().catch((err) => {
  ui.error(`Error: ${err.message}`);
  process.exit(1);
});
