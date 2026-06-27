import { FastmailEngine, senderOf } from "../fastmail.ts";
import { summarizeThread } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  from?: string;
  after?: string;
  before?: string;
}

export async function findCommand(query: string, opts: Opts): Promise<void> {
  // Find searches a single account (the default, or the one named).
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const engine = new FastmailEngine(account);

    ui.info(`Searching for "${query}"…`);
    const emails = await engine.search(
      { text: query, from: opts.from, after: opts.after, before: opts.before },
      opts.limit,
    );

    if (emails.length === 0) {
      ui.info(`No emails found matching "${query}".`);
      continue;
    }

    // Fetch full bodies for the matches so the summary has real content.
    ui.info(`Found ${emails.length} emails. Fetching bodies…`);
    const full = await Promise.all(emails.map((e) => engine.getEmail(e.id).catch(() => e)));

    ui.header("Matching emails");
    ui.table({
      head: ["From", "Subject", "Date"],
      colWidths: [26, 50, 24],
      rows: full.map((e) => {
        const s = senderOf(e);
        return [s.name || s.email || "?", e.subject ?? "?", (e.receivedAt ?? "").slice(0, 10)];
      }),
    });

    ui.info("\nSummarizing with Claude…");
    const summary = await summarizeThread(full, query);
    ui.header("Summary");
    console.log(summary);
  }
}
