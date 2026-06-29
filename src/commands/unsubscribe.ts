import pc from "picocolors";
import { FastmailEngine, senderOf, type Email } from "../fastmail.ts";
import { findUnsubscribeCandidates } from "../ai.ts";
import { resolveAccounts } from "../config.ts";
import { JmapClient } from "../jmap.ts";
import { groupBySender, executeUnsub, type Method } from "../unsub.ts";
import { UnsubStore } from "../unsubstore.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  limit: number;
  all?: boolean;
  mailbox?: string;
  sender?: string;
  apply?: boolean;
  then?: string;
  skipNoHeader?: boolean;
  json?: boolean;
}

/** Fetch emails for the scope: a single page (--limit), or all of them (--all). */
async function fetchEmails(jmap: JmapClient, opts: Opts): Promise<Email[]> {
  const page = opts.limit || 100;
  if (!opts.all) {
    return jmap.queryEmails({ mailbox: opts.mailbox, from: opts.sender, limit: page });
  }
  const out: Email[] = [];
  let offset = 0;
  while (out.length < 10000) {
    const batch = await jmap.queryEmails({
      mailbox: opts.mailbox,
      from: opts.sender,
      limit: page,
      offset,
    });
    out.push(...batch);
    if (batch.length < page) break;
    offset += batch.length;
  }
  return out;
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
    ui.info(`Scanning ${where}${opts.all ? " (all)" : ""}…`);
    let emails = await fetchEmails(jmap, opts);
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

    // Look up the List-Unsubscribe method for each, grouped per sender
    // (chunked so a large folder doesn't build one oversized JMAP request).
    ui.info("Reading List-Unsubscribe headers…");
    const ids = emails.map((e) => e.id);
    const infos = [];
    for (let i = 0; i < ids.length; i += 200) {
      infos.push(...(await jmap.getUnsubscribeInfo(ids.slice(i, i + 200))));
    }
    let senders = groupBySender(infos);
    const store = new UnsubStore(account.name);

    // Optionally drop senders with no List-Unsubscribe header so the run
    // focuses on the ones that can actually be unsubscribed.
    if (opts.skipNoHeader) {
      const before = senders.length;
      senders = senders.filter((s) => s.method !== "none");
      const dropped = before - senders.length;
      if (dropped > 0) ui.info(pc.dim(`Skipping ${dropped} sender(s) with no List-Unsubscribe header.`));
    }

    if (senders.length === 0) {
      ui.info("No senders to process.");
      continue;
    }

    if (opts.json) {
      const annotated = senders.map((s) => ({ ...s, alreadyUnsubscribed: store.has(s.senderEmail) }));
      console.log(JSON.stringify(annotated, null, 2));
      continue;
    }

    ui.header(`Unsubscribe Candidates (${senders.length} senders)`);
    ui.table({
      head: ["Sender", "Email", "#", "Method", "Prev?"],
      colWidths: [22, 30, 5, 18, 7],
      rows: senders.map((s) => [
        s.senderName || "",
        s.senderEmail,
        String(s.count),
        METHOD_LABEL[s.method],
        store.has(s.senderEmail) ? "✓" : "",
      ]),
    });

    if (!opts.apply) {
      const todo = senders.filter(
        (s) => !store.has(s.senderEmail) && (s.method === "one-click" || s.method === "email"),
      ).length;
      const known = senders.filter((s) => store.has(s.senderEmail)).length;
      ui.info(
        `\n${todo} new senders can be unsubscribed automatically` +
          (known ? `; ${known} already unsubscribed (Prev ✓) will just be filed` : "") +
          `. Re-run with ${pc.bold("--apply")} to act.`,
      );
      continue;
    }

    // --apply: unsubscribe new senders; skip ones already done in a prior run.
    ui.info(pc.yellow(`\nUnsubscribing… (this contacts each new sender)`));
    let ok = 0;
    let skipped = 0;
    let manual = 0;
    const filedIds: string[] = []; // messages to file via --then

    for (const sender of senders) {
      if (store.has(sender.senderEmail)) {
        // Already unsubscribed in a previous run — don't contact again, just file.
        skipped++;
        filedIds.push(...sender.ids);
        ui.info(pc.dim(`  • ${sender.senderEmail} — already unsubscribed, skipping`));
        continue;
      }
      const result = await executeUnsub(sender, engine);
      if (result.ok) {
        ok++;
        store.record(sender.senderEmail);
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
      `\nDone: ${pc.green(`${ok} unsubscribed`)}, ${skipped} already-done, ` +
        `${manual} need a browser, ${senders.length - ok - skipped - manual} failed/unsupported.`,
    );

    // --then: file the existing mail of senders that are unsubscribed (new + prior).
    if (opts.then && filedIds.length > 0) {
      const moved = await jmap.moveEmailsTo(filedIds, opts.then);
      ui.info(pc.green(`Moved ${moved} message${moved === 1 ? "" : "s"} to "${opts.then}".`));
    }
  }
}
