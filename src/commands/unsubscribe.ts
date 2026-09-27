import { confirm, isCancel } from "@clack/prompts";
import pc from "picocolors";
import { FastmailEngine, senderOf, type Email } from "../fastmail.ts";
import { scoreUnsubscribeCandidates } from "../classify.ts";
import { resolveAccounts } from "../config.ts";
import { groupBySender as groupForModel } from "../heuristics.ts";
import { JmapClient } from "../jmap.ts";
import {
  groupBySender,
  executeUnsub,
  extractBodyUnsubUrl,
  type Method,
  type SenderUnsub,
} from "../unsub.ts";
import { followUnsubLink } from "../unsubform.ts";
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
        bodyUrl: store.urlFor(s.senderEmail),
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
      const fallback = senders.filter((s) => !store.has(s.senderEmail)).length - todo;
      ui.info(
        `\n${todo} new senders can be unsubscribed automatically` +
          (fallback ? `; ${fallback} more will try an unsubscribe link from the email body` : "") +
          (known ? `; ${known} already unsubscribed (Prev ✓) will just be filed` : "") +
          `. Re-run with ${pc.bold("--apply")} to act.`,
      );
      continue;
    }

    // --apply: unsubscribe new senders; skip ones already done in a prior run.
    ui.info(pc.yellow(`\nUnsubscribing… (this contacts each new sender)`));
    let ok = 0;
    let viaBody = 0;
    let skipped = 0;
    let manual = 0;
    let byHand = 0;
    // Offer the link for failures; one unanswered prompt turns this off for the run.
    let prompting = Boolean(process.stdin.isTTY);
    // --then: resolve the folder before contacting anyone, then file each
    // sender's mail as soon as it's unsubscribed (new or from a prior run).
    const thenId = opts.then ? await jmap.mailboxId(opts.then) : null;
    let moved = 0;
    let moveFailed = 0;
    const file = async (sender: (typeof senders)[number]) => {
      if (!thenId) return;
      try {
        const res = await jmap.moveEmailsBulk(new Map(sender.ids.map((id) => [id, thenId])));
        moved += res.moved;
        moveFailed += res.failed.length;
        if (res.failed.length > 0) {
          ui.warn(`    ${res.failed.length} message(s) from ${sender.senderEmail} could not be moved`);
        }
      } catch (err) {
        moveFailed += sender.ids.length;
        ui.warn(`    could not move mail from ${sender.senderEmail}: ${(err as Error).message}`);
      }
    };

    try {
      for (const sender of senders) {
        if (store.has(sender.senderEmail)) {
          // Already unsubscribed in a previous run — don't contact again, just file.
          skipped++;
          ui.info(pc.dim(`  • ${sender.senderEmail} — already unsubscribed, skipping`));
          await file(sender);
          continue;
        }
        let result: { ok: boolean; detail: string; url?: string } = await executeUnsub(sender, engine);
        if (!result.ok) {
          // Every header method failed or there was none: try the body's link.
          result = (await unsubscribeViaBody(jmap, store, sender)) ?? result;
        }
        if (result.ok) {
          ok++;
          if (result.url) viaBody++;
          store.record(sender.senderEmail, result.url);
          ui.info(pc.green(`  ✓ ${sender.senderEmail} — ${result.detail}`));
          await file(sender);
          continue;
        }
        const failed = `${sender.senderEmail} — ${result.detail}`;
        ui.info(sender.method === "manual" ? pc.dim(`  ↗ ${failed}`) : pc.red(`  ✗ ${failed}`));

        const link = result.url ?? (/^https:/i.test(sender.target) ? sender.target : null);
        if (link && store.hasUrl(link)) {
          // Already confirmed done for another sender sharing this link — don't ask again.
          byHand++;
          store.record(sender.senderEmail, link);
          ui.info(pc.green(`  ✓ ${sender.senderEmail} — link already done in browser`));
          await file(sender);
          continue;
        }
        if (prompting && link) {
          const answer = await askDoneInBrowser(link);
          if (answer === "timeout") {
            prompting = false;
            ui.warn("  No answer in 1 minute — not prompting again this run.");
          } else if (answer) {
            byHand++;
            store.record(sender.senderEmail, link);
            ui.info(pc.green(`  ✓ ${sender.senderEmail} — done in browser`));
            await file(sender);
            continue;
          }
        }
        if (sender.method === "manual") manual++;
      }
    } finally {
      // Persist even if a sender throws mid-loop — those already contacted
      // must not be contacted again on the next run.
      store.flush();
    }
    ui.info(
      `\nDone: ${pc.green(`${ok} unsubscribed`)}${viaBody ? ` (${viaBody} via body link)` : ""}, ` +
        (byHand ? `${pc.green(`${byHand} done in browser`)}, ` : "") +
        `${skipped} already-done, ${manual} need a browser, ` +
        `${senders.length - ok - byHand - skipped - manual} failed/unsupported.`,
    );

    if (opts.then) {
      ui.info(
        pc.green(`Moved ${moved} message${moved === 1 ? "" : "s"} to "${opts.then}".`) +
          (moveFailed ? pc.red(` ${moveFailed} could not be moved — re-run to retry.`) : ""),
      );
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

const PROMPT_TIMEOUT_MS = 60_000;

/**
 * Show a failed sender's link and ask whether the user unsubscribed by hand.
 * "timeout" when unanswered for a minute; Ctrl-C aborts the run (the store
 * is still flushed by the caller's finally).
 */
async function askDoneInBrowser(link: string): Promise<boolean | "timeout"> {
  // A cancellable timer, not AbortSignal.timeout: clack never removes its
  // abort listener, so a signal that fires after this prompt was answered
  // would close it again — turning off raw mode under the *next* prompt.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
  const answer = await confirm({
    message: `Open ${pc.cyan(link)}\n  Unsubscribed in the browser?`,
    initialValue: false,
    output: process.stderr,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  if (isCancel(answer)) {
    if (controller.signal.aborted) return "timeout";
    throw new Error("Cancelled.");
  }
  return answer;
}

/** How many of a sender's emails to search for a body unsubscribe link. */
const BODY_SCAN_LIMIT = 3;

/**
 * Fallback when the List-Unsubscribe header can't be used: find an unsubscribe
 * link in the body of one of the sender's emails, open it, and submit any
 * confirmation form (filling an empty email field with the To address). A link another
 * sender was already unsubscribed through isn't fetched again. Returns null
 * when no link is found, so the caller keeps the header result's detail.
 */
async function unsubscribeViaBody(
  jmap: JmapClient,
  store: UnsubStore,
  sender: SenderUnsub,
): Promise<{ ok: boolean; detail: string; url: string } | null> {
  for (const id of sender.ids.slice(0, BODY_SCAN_LIMIT)) {
    const { html, text, to } = await jmap.getBodies(id);
    const url = extractBodyUnsubUrl(html, text);
    if (!url) continue;
    if (store.hasUrl(url)) return { ok: true, detail: "body link already used", url };
    return { ...(await followUnsubLink(url, to)), url };
  }
  return null;
}
