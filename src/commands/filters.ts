import pc from "picocolors";
import { FastmailEngine } from "../fastmail.ts";
import { suggestFilters } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  json?: boolean;
}

export async function filtersCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const engine = new FastmailEngine(account);

    ui.info("Fetching emails…");
    const emails = await engine.listEmails({ limit: opts.limit });
    if (emails.length === 0) {
      ui.info("No emails found.");
      continue;
    }

    ui.info(`Analyzing ${emails.length} emails for filter suggestions…`);
    const rules = await suggestFilters(emails);

    if (opts.json) {
      console.log(JSON.stringify(rules, null, 2));
      continue;
    }

    if (rules.length === 0) {
      ui.info("No filter suggestions generated.");
      continue;
    }

    rules.forEach((rule, i) => {
      ui.header(`Rule ${i + 1}: ${rule.name}`);
      console.log(`  ${pc.cyan("Condition:")} ${rule.condition}`);
      console.log(`  ${pc.cyan("Action:")}    ${rule.action}`);
      if (rule.example_senders?.length) {
        console.log(`  ${pc.cyan("Examples:")}  ${rule.example_senders.join(", ")}`);
      }
      console.log(`  ${pc.dim(rule.rationale)}`);
    });
  }
}
