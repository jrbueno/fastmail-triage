import pc from "picocolors";
import { FastmailEngine, senderOf } from "../fastmail.ts";
import { findUnsubscribeCandidates } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import { JmapClient } from "../jmap.ts";
import { groupBySender, executeUnsub, type Method } from "../unsub.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  mailbox?: string;
  sender?: string;
  apply?: boolean;
  then?: string;
  json?: boolean;
}

const METHOD_LABEL: Record<Method, string> = {
  "one-click": "1-click (auto)",
  email: "email (auto)",
  manual: "browser (manual)",
  none: "no method",
};

export async function unsubscribeCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const engine = new FastmailEngine(account);
    const jmap = new JmapClient(account.token);

    // Gather the candidate emails.
    const where = opts.sender
      ? `sender ${opts.sender}`
      : (opts.mailbox ?? "Inbox");
    ui.info(`Scanning ${where}…`);
    let emails = await jmap.queryEmails({
      mailbox: opts.mailbox,
      from: opts.sender,
      limit: opts.limit,
    });
    if (emails.length === 0) {
      ui.info("No emails found.");
      continue;
    }

    // In Inbox discovery mode (no explicit folder or sender), let Claude narrow
    // to newsletters/promo. A reviewed folder or an explicit sender is taken as-is.
    if (!opts.sender && !opts.mailbox) {
      ui.info(`Identifying unsubscribe candidates among ${emails.length} emails…`);
      const candidates = await findUnsubscribeCandidates(emails);
      const wanted = new Set(candidates.map((c) => c.sender_email.toLowerCase()));
      emails = emails.filter((e) => wanted.has(senderOf(e).email.toLowerCase()));
    }

    if (emails.length === 0) {
      ui.info("No unsubscribe candidates found.");
      continue;
    }

    // Look up the List-Unsubscribe method for each, grouped per sender.
    ui.info("Reading List-Unsubscribe headers…");
    const infos = await jmap.getUnsubscribeInfo(emails.map((e) => e.id));
    const senders = groupBySender(infos);

    if (opts.json) {
      console.log(JSON.stringify(senders, null, 2));
      continue;
    }

    ui.header(`Unsubscribe Candidates (${senders.length} senders)`);
    ui.table({
      head: ["Sender", "Email", "#", "Method"],
      colWidths: [24, 32, 5, 18],
      rows: senders.map((s) => [
        s.senderName || "",
        s.senderEmail,
        String(s.count),
        METHOD_LABEL[s.method],
      ]),
    });

    if (!opts.apply) {
      const auto = senders.filter((s) => s.method === "one-click" || s.method === "email").length;
      ui.info(
        `\n${auto} of ${senders.length} can be unsubscribed automatically. ` +
          `Review the list, then re-run with ${pc.bold("--apply")} to unsubscribe.`,
      );
      continue;
    }

    // --apply: actually unsubscribe.
    ui.info(pc.yellow(`\nUnsubscribing… (this contacts each sender)`));
    let ok = 0;
    let manual = 0;
    const filedIds: string[] = []; // messages from senders that unsubscribed OK
    for (const sender of senders) {
      const result = await executeUnsub(sender, engine);
      if (result.ok) {
        ok++;
        filedIds.push(...sender.ids);
        ui.info(pc.green(`  ✓ ${sender.senderEmail} — ${result.detail}`));
      } else if (sender.method === "manual") {
        manual++;
        ui.info(pc.dim(`  ↗ ${sender.senderEmail} — ${result.detail}`));
      } else {
        ui.info(pc.red(`  ✗ ${sender.senderEmail} — ${result.detail}`));
      }
    }
    ui.info(
      `\nDone: ${pc.green(`${ok} unsubscribed`)}, ${manual} need a browser, ` +
        `${senders.length - ok - manual} failed/unsupported.`,
    );

    // --then: file the existing mail of senders that successfully unsubscribed.
    if (opts.then && filedIds.length > 0) {
      const moved = await jmap.moveEmailsTo(filedIds, opts.then);
      ui.info(pc.green(`Moved ${moved} message${moved === 1 ? "" : "s"} to "${opts.then}".`));
    }
  }
}
