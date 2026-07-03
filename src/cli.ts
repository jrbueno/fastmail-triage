#!/usr/bin/env bun
import { Command } from "commander";
import * as ui from "./ui.ts";
import { triageCommand } from "./commands/triage.ts";
import { unsubscribeCommand } from "./commands/unsubscribe.ts";
import { findCommand } from "./commands/find.ts";
import { filtersCommand } from "./commands/filters.ts";
import {
  accountAdd,
  accountList,
  accountRemove,
  accountDefault,
} from "./commands/account.ts";

const program = new Command();

program
  .name("fastmail-triage")
  .description("AI-powered Fastmail inbox assistant (triage, unsubscribe, find, filters).")
  .version("0.1.0");

// Shared --account option: a name, or "all" to fan out across every account.
const accountOpt = ["-a, --account <name>", 'account name, or "all" for every account'] as const;

program
  .command("triage")
  .description("Sort mail into reply / fyi / offers / newsletter / noise and file it under Triage/")
  .option(...accountOpt)
  .option("-n, --limit <n>", "max emails to process", (v) => parseInt(v, 10), 50)
  .option("-b, --batch <n>", "emails per Claude call (1-100)", (v) => parseInt(v, 10), 40)
  .option("-m, --mailbox <name>", "folder to triage (default: Inbox)")
  .option("--oldest", "start with the oldest emails instead of newest", false)
  .option("--all", "include read mail, not just unread", false)
  .option("--unread", "unread only (use with --all to drain every unread email)", false)
  .option("--skip-unsubscribed", "file mail from already-unsubscribed senders straight to Triage/Unsubscribe (no Claude call)", false)
  .option("--dry-run", "preview only — don't move anything", false)
  .option("--json", "output raw JSON (implies no moving)", false)
  .action((opts) => run(() => triageCommand(opts)));

program
  .command("unsubscribe")
  .description("Find newsletters/promos and actually unsubscribe (List-Unsubscribe)")
  .option(...accountOpt)
  .option("-n, --limit <n>", "max emails to scan (page size with --all)", (v) => parseInt(v, 10), 100)
  .option("--all", "scan the entire scope, paginating past --limit", false)
  .option("-m, --mailbox <name>", "scan a reviewed folder (e.g. Triage/Unsubscribe leaf 'Unsubscribe'); every sender is a target")
  .option("-s, --sender <email>", "target a single sender")
  .option("--apply", "actually unsubscribe (default: preview only)", false)
  .option("--then <dest>", "after a successful unsubscribe, move that sender's mail (archive | trash | <folder>)")
  .option("--skip-no-header", "ignore senders with no List-Unsubscribe header", false)
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
