/**
 * Measure triage accuracy against mail that is already filed, and pick a
 * --min-confidence from the result instead of guessing.
 *
 * Each labelled folder (by default the Triage/* folders, plus any
 * `--label Folder=category`) contributes its newest emails, all labelled with
 * that folder's category. The sample runs through the same routing as triage
 * (Sent-history check → sender vs per-email jobs → TypeSafe), ignoring the
 * verdict cache and writing nothing back. Accuracy is then swept across
 * confidence thresholds.
 *
 * Triage/* folders were filed by earlier runs, so on their own they measure
 * agreement with the previous classifier. Folders you filed by hand, passed
 * with --label, are the real ground truth.
 */

import pc from "picocolors";
import { buildJobs, CATEGORIES, classifyJobs, jobEmails, type Category } from "../classify.ts";
import { resolveAccounts } from "../config.ts";
import { senderOf, type Email } from "../fastmail.ts";
import { groupBySender, looksBulk } from "../heuristics.ts";
import { JmapClient } from "../jmap.ts";
import * as ui from "../ui.ts";
import { MAILBOX_NAMES, PARENT_LABEL } from "./triage.ts";

interface Opts {
  account?: string;
  perFolder: number;
  label: string[];
  triageFolders: boolean;
  target: number;
  json?: boolean;
}

export const THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const DEFAULT_MIN_CONFIDENCE = 0.3; // triage's --min-confidence default

/** One sampled email with its folder label and the model's verdict. */
export interface Scored {
  label: Category;
  predicted: Category;
  confidence: number;
}

export interface SweepRow {
  threshold: number;
  /** Emails at or above the threshold: the ones triage would move. */
  filed: number;
  correct: number;
  /** correct / filed, or null when nothing is filed. */
  accuracy: number | null;
}

export function sweep(items: Scored[], thresholds: number[] = THRESHOLDS): SweepRow[] {
  return thresholds.map((threshold) => {
    const filed = items.filter((i) => i.confidence >= threshold);
    const correct = filed.filter((i) => i.predicted === i.label).length;
    return { threshold, filed: filed.length, correct, accuracy: filed.length ? correct / filed.length : null };
  });
}

/** Lowest threshold (so the most mail filed) whose accuracy meets the target. */
export function recommend(rows: SweepRow[], target: number): SweepRow | null {
  return rows.find((r) => r.accuracy !== null && r.accuracy >= target) ?? null;
}

export interface CategoryRow {
  category: Category;
  labelled: number;
  /** Labelled emails filed into the right folder at the threshold. */
  filedCorrectly: number;
  /** Emails filed as this category at the threshold, right or wrong. */
  filedAs: number;
}

export function perCategory(items: Scored[], threshold: number): CategoryRow[] {
  return CATEGORIES.map((category) => {
    const filed = items.filter((i) => i.confidence >= threshold);
    return {
      category,
      labelled: items.filter((i) => i.label === category).length,
      filedCorrectly: filed.filter((i) => i.label === category && i.predicted === category).length,
      filedAs: filed.filter((i) => i.predicted === category).length,
    };
  }).filter((r) => r.labelled > 0 || r.filedAs > 0);
}

/** counts[label][predicted] over every verdict, regardless of confidence. */
export function confusion(items: Scored[]): Record<Category, Record<Category, number>> {
  const zero = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const m = Object.fromEntries(CATEGORIES.map((c) => [c, zero()])) as Record<Category, Record<Category, number>>;
  for (const i of items) m[i.label][i.predicted]++;
  return m;
}

/** Parse repeated `--label Folder=category` values. */
export function parseLabels(values: string[]): Map<string, Category> {
  const out = new Map<string, Category>();
  for (const v of values) {
    const at = v.lastIndexOf("=");
    const folder = v.slice(0, at).trim();
    const category = v.slice(at + 1).trim().toLowerCase() as Category;
    if (at <= 0 || !folder) throw new Error(`--label "${v}": expected Folder=category.`);
    if (!CATEGORIES.includes(category)) {
      throw new Error(`--label "${v}": category must be one of ${CATEGORIES.join(", ")}.`);
    }
    out.set(folder, category);
  }
  return out;
}

interface Sample extends Scored {
  id: string;
  folder: string;
  from: string;
  subject: string;
  level: "sender" | "email";
  runnerUp: { category: Category; p: number } | null;
}

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

const SHORT: Record<Category, string> = {
  reply: "reply",
  fyi: "fyi",
  offers: "offer",
  newsletter: "newsl",
  politics: "polit",
  unsubscribe: "unsub",
  noise: "noise",
};

export async function calibrateCommand(opts: Opts): Promise<void> {
  if (!(opts.perFolder > 0)) throw new Error("--per-folder must be a positive number.");
  if (!(opts.target > 0 && opts.target <= 1)) throw new Error("--target must be a number between 0 and 1.");
  const extra = parseLabels(opts.label);
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);

    // ── 1. Labelled folders: Triage/* defaults, then --label overrides ──────
    const labels = new Map<string, Category>();
    if (opts.triageFolders) {
      for (const c of CATEGORIES) labels.set(`${PARENT_LABEL}/${MAILBOX_NAMES[c]}`, c);
    }
    for (const [folder, c] of extra) labels.set(folder, c);
    if (labels.size === 0) throw new Error("No labelled folders: pass --label Folder=category.");

    // Match by full path or leaf, case-insensitively, as --mailbox does.
    const boxes = await jmap.mailboxesWithPaths();
    const found = (sel: string) => {
      const lower = sel.toLowerCase();
      return lower.includes("/")
        ? boxes.find((b) => b.path.toLowerCase() === lower)
        : boxes.find((b) => b.name.toLowerCase() === lower);
    };

    // ── 2. Sample the newest emails of each folder ──────────────────────────
    const labelOf = new Map<string, { label: Category; folder: string }>();
    const conflicted = new Set<string>();
    const emails: Email[] = [];
    for (const [folder, label] of labels) {
      const box = found(folder);
      if (!box) {
        if (extra.has(folder)) throw new Error(`Mailbox "${folder}" not found.`);
        ui.info(pc.dim(`  ${folder}: no such folder, skipped`));
        continue;
      }
      const { emails: batch } = await jmap.queryEmails({ mailbox: box.path, limit: opts.perFolder, withHeaders: true });
      ui.info(pc.dim(`  ${box.path} → ${label}: ${batch.length} emails`));
      for (const e of batch) {
        const prior = labelOf.get(e.id);
        if (prior) {
          if (prior.label !== label) conflicted.add(e.id);
          continue;
        }
        labelOf.set(e.id, { label, folder: box.path });
        emails.push(e);
      }
    }
    // An email in two folders with different categories has no single label.
    const sample = emails.filter((e) => !conflicted.has(e.id));
    if (conflicted.size > 0) ui.info(pc.dim(`  ${conflicted.size} emails in conflicting folders dropped`));
    if (sample.length === 0) {
      ui.info("No labelled emails to calibrate on.");
      continue;
    }

    // ── 3. Same routing as triage, minus the verdict cache ──────────────────
    const groups = groupBySender(sample);
    const candidates = [...groups.values()].filter(looksBulk);
    const replied = await jmap.hasRepliedTo(candidates.map((g) => g.email));
    for (const g of candidates) g.replied = replied.has(g.email);
    const jobs = buildJobs(groups.values());

    ui.info(`Classifying ${sample.length} labelled emails in ${jobs.size} TypeSafe request(s)…`);
    const step = Math.max(50, Math.ceil(jobs.size / 10));
    const { results, errors, inputTokens } = await classifyJobs(jobs, (done, total) => {
      if (done % step === 0 || done === total) ui.info(pc.dim(`  ${done}/${total} requests done`));
    });

    const items: Sample[] = [];
    for (const [key, job] of jobs) {
      const v = results.get(key);
      if (!v) continue;
      for (const e of jobEmails(job)) {
        const { label, folder } = labelOf.get(e.id)!;
        const from = senderOf(e);
        items.push({
          id: e.id,
          folder,
          from: from.email,
          subject: e.subject ?? "",
          level: job.kind,
          label,
          predicted: v.category,
          confidence: v.confidence,
          runnerUp: v.runnerUp,
        });
      }
    }
    if (errors.size > 0) ui.warn(`${errors.size} request(s) failed; their emails are left out.`);

    const rows = sweep(items);
    const pick = recommend(rows, opts.target);
    const model = process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest";

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            account: account.name,
            model,
            inputTokens,
            target: opts.target,
            recommended: pick?.threshold ?? null,
            sweep: rows,
            perCategory: perCategory(items, pick?.threshold ?? DEFAULT_MIN_CONFIDENCE),
            items,
          },
          null,
          2,
        ),
      );
      continue;
    }

    ui.header(`Calibration: ${items.length} emails, ${jobs.size} requests, ${inputTokens.toLocaleString()} input tokens (${model})`);
    if (opts.triageFolders) {
      ui.info("Triage/* folders were filed by earlier runs, so they measure agreement, not ground truth.");
    }

    ui.header("Accuracy by --min-confidence");
    ui.table({
      head: ["Threshold", "Filed", "Accuracy", "Wrong moves", ""],
      colWidths: [11, 13, 10, 13, 16],
      rows: rows.map((r) => {
        const tag = [
          r.threshold === pick?.threshold ? pc.green("recommended") : "",
          r.threshold === DEFAULT_MIN_CONFIDENCE ? pc.dim("default") : "",
        ].filter(Boolean).join(" ");
        return [
          r.threshold.toFixed(1),
          `${r.filed} (${pct(r.filed / items.length)})`,
          pct(r.accuracy),
          String(r.filed - r.correct),
          tag,
        ];
      }),
    });
    if (pick) {
      console.log(
        `  ${pc.green(`Use --min-confidence ${pick.threshold.toFixed(1)}`)}: files ${pct(pick.filed / items.length)} of this ` +
          `sample at ${pct(pick.accuracy)} accuracy (target ${pct(opts.target)}).`,
      );
    } else {
      const best = Math.max(...rows.map((r) => r.accuracy ?? 0));
      console.log(`  ${pc.yellow(`No threshold reaches ${pct(opts.target)} accuracy`)} (best ${pct(best)}). Review the mistakes below.`);
    }

    const at = pick?.threshold ?? DEFAULT_MIN_CONFIDENCE;
    ui.header(`Per category at ${at.toFixed(1)}`);
    ui.table({
      head: ["Category", "Labelled", "Filed correctly", "Filed as", "Precision"],
      colWidths: [13, 10, 17, 10, 11],
      rows: perCategory(items, at).map((r) => [
        r.category,
        String(r.labelled),
        r.labelled ? `${r.filedCorrectly} (${pct(r.filedCorrectly / r.labelled)})` : "—",
        String(r.filedAs),
        r.filedAs ? pct(r.filedCorrectly / r.filedAs) : "—",
      ]),
    });

    ui.header("Confusion (rows: folder label, columns: model's pick, all confidences)");
    const m = confusion(items);
    const present = CATEGORIES.filter((c) => items.some((i) => i.label === c));
    ui.table({
      head: ["", ...CATEGORIES.map((c) => SHORT[c])],
      colWidths: [9, ...CATEGORIES.map(() => 7)],
      rows: present.map((label) => [
        SHORT[label],
        ...CATEGORIES.map((p) => {
          const n = m[label][p];
          if (n === 0) return pc.dim("·");
          return p === label ? pc.green(String(n)) : String(n);
        }),
      ]),
    });

    const mistakes = items
      .filter((i) => i.predicted !== i.label)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
    if (mistakes.length > 0) {
      ui.header("Most confident disagreements");
      ui.table({
        head: ["Conf", "Folder → model", "From", "Subject"],
        colWidths: [6, 20, 28, 40],
        rows: mistakes.map((i) => [
          i.confidence.toFixed(2),
          `${SHORT[i.label]} → ${SHORT[i.predicted]}`,
          ui.truncate(i.from, 26),
          ui.truncate(i.subject, 38),
        ]),
      });
      ui.info(
        "High-confidence disagreements are often mis-filed mail or a category boundary " +
          "that CATEGORY_CRITERIA doesn't draw — worth reading before trusting the numbers.",
      );
    }
  }
}
