import { FastmailEngine } from "../fastmail.ts";
import { findUnsubscribeCandidates } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  json?: boolean;
}

export async function unsubscribeCommand(opts: Opts): Promise<void> {
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

    ui.info(`Scanning ${emails.length} emails for unsubscribe candidates…`);
    const candidates = await findUnsubscribeCandidates(emails);

    if (opts.json) {
      console.log(JSON.stringify(candidates, null, 2));
      continue;
    }

    if (candidates.length === 0) {
      ui.info("No obvious unsubscribe candidates found.");
      continue;
    }

    ui.header(`Unsubscribe Candidates (${candidates.length})`);
    ui.table({
      head: ["Sender", "Email", "Example Subject", "Why"],
      colWidths: [20, 28, 32, 34],
      rows: candidates.map((c) => [
        c.sender_name,
        c.sender_email,
        c.subject_example,
        c.reason,
      ]),
    });
    ui.info("\nTip: open these in Fastmail and use its built-in unsubscribe, or block the sender.");
  }
}
