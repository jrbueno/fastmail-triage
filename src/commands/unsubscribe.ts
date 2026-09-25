import pc from "picocolors";
import { FastmailEngine, senderOf, type Email } from "../fastmail.ts";
import { scoreUnsubscribeCandidates } from "../classify.ts";
import { resolveAccounts } from "../config.ts";
import { groupBySender as groupForModel } from "../heuristics.ts";
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
  minProbability: number;
  json?: boolean;
}

/** Fetch emails for the scope: a single page (--limit), or all of them (--all). */
async function fetchEmails(jmap: JmapClient, opts: Opts, withHeaders: boolean): Promise<Email[]> {
  const page = opts.limit || 100;
  if (!opts.all) {
    const { emails } = await jmap.queryEmails({
      mailbox: opts.mailbox,
      from: opts.sender,
      limit: page,
      withHeaders,
    });
    return emails;
  }
  const out: Email[] = [];
  let offset = 0;
  while (out.length < 10000) {
    const { emails: batch } = await jmap.queryEmails({
      mailbox: opts.mailbox,
      from: opts.sender,
      limit: page,
      offset,
      withHeaders,
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
  if (!(opts.minProbability >= 0 && opts.minProbability <= 1)) {
    throw new Error("--min-probability must be a number between 0 and 1.");
  }
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const engine = new FastmailEngine(account);
    const jmap = new JmapClient(account.token);

    // Gather the candidate emails.
    const where = opts.sender
      ? `sender ${opts.sender}`
      : (opts.mailbox ?? "Inbox");
    // Inbox discovery mode (no explicit folder or sender) asks the model which
    // senders to target; a reviewed folder or an explicit sender is taken as-is.
    const discover = !opts.sender && !opts.mailbox;
    ui.info(`Scanning ${where}${opts.all ? " (all)" : ""}…`);
    // Discovery needs the bulk-mail headers that feed the model's sender state.
    let emails = await fetchEmails(jmap, opts, discover);
    if (emails.length === 0) {
      ui.info("No emails found.");
      continue;
    }

    let scores: Map<string, number> | null = null;
    if (discover) {
      scores = await pickCandidates(jmap, emails);
      const wanted = new Set(
        [...scores].filter(([, p]) => p >= opts.minProbability).map(([sender]) => sender),
      );
      emails = emails.filter((e) => wanted.has(senderOf(e).email.toLowerCase()));
    }

    if (emails.length === 0) {
      ui.info("No unsubscribe candidates found.");
      continue;
    }

    // Look up the List-Unsubscribe method for each, grouped per sender
    // (getUnsubscribeInfo chunks to the server's maxObjectsInGet internally).
    ui.info("Reading List-Unsubscribe headers…");
    const infos = await jmap.getUnsubscribeInfo(emails.map((e) => e.id));
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

    const probability = (s: { senderEmail: string }) =>
      scores?.get(s.senderEmail.toLowerCase()) ?? null;

    if (opts.json) {
      const annotated = senders.map((s) => ({
        ...s,
        probability: probability(s),
        alreadyUnsubscribed: store.has(s.senderEmail),
      }));
      console.log(JSON.stringify(annotated, null, 2));
      continue;
    }

    ui.header(`Unsubscribe Candidates (${senders.length} senders)`);
    ui.table({
      head: ["Sender", "Email", "#", ...(scores ? ["P"] : []), "Method", "Prev?"],
      colWidths: [22, 30, 5, ...(scores ? [6] : []), 18, 7],
      rows: senders.map((s) => [
        s.senderName || "",
        s.senderEmail,
        String(s.count),
        ...(scores ? [probability(s)?.toFixed(2) ?? "?"] : []),
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

    try {
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
    } finally {
      // Persist even if a sender throws mid-loop — those already contacted
      // must not be contacted again on the next run.
      store.flush();
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

/**
 * Ask TypeSafe, once per sender, how likely it is to be a list the user can
 * safely leave. Returns sender address → probability; senders whose request
 * failed are absent, so they're never targeted.
 */
async function pickCandidates(jmap: JmapClient, emails: Email[]): Promise<Map<string, number>> {
  const groups = [...groupForModel(emails).values()];
  const replied = await jmap.hasRepliedTo(groups.map((g) => g.email));
  for (const g of groups) g.replied = replied.has(g.email);

  ui.info(`Identifying unsubscribe candidates among ${groups.length} senders…`);
  const { results, errors } = await scoreUnsubscribeCandidates(groups);
  let shown = 0;
  for (const [sender, err] of errors) {
    if (shown++ < 5) ui.warn(`Request for ${sender} failed: ${err}`);
  }
  if (errors.size > 5) ui.warn(`…and ${errors.size - 5} more failed requests.`);
  return results;
}
