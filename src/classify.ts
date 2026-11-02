/**
 * Mail judgments on TypeSafe's System One model (Jev): triage categories and
 * unsubscribe candidates.
 *
 * Each email or bulk sender becomes one small request: a structured `state`
 * describing just that item, and one Choice question over the triage
 * categories. The answer is typed (a category label, never prose to parse)
 * and carries a probability per category plus a `confidence`, which triage
 * uses to leave uncertain mail in place instead of guessing.
 *
 * Deterministic facts (bulk headers, read status, Sent history) are computed
 * in code and handed over as named fields; counts are bucketed into words
 * because the model judges semantics far better than numbers.
 */

import { choice, noul, TypeSafeClient, type ChoiceResponse, type JsonValue } from "@typesafe-ai/sdk";
import { senderOf, type Email } from "./fastmail.ts";
import { isBulkish, isUnread, type SenderGroup } from "./heuristics.ts";

export type Category =
  | "reply"
  | "fyi"
  | "offers"
  | "newsletter"
  | "politics"
  | "career"
  | "unsubscribe"
  | "noise";
export const CATEGORIES: Category[] = [
  "reply",
  "fyi",
  "offers",
  "newsletter",
  "politics",
  "career",
  "unsubscribe",
  "noise",
];

let client: TypeSafeClient | null = null;
function getClient(): TypeSafeClient {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error("TYPESAFE_API_KEY is not set.");
  }
  // Model: TYPESAFE_DEFAULT_MODEL, else jev-latest. Pin a versioned id (e.g.
  // jev-1.13.0) once --min-confidence is tuned so an alias move can't shift it.
  client ??= new TypeSafeClient({ retry: { maxRetries: 5 } });
  return client;
}

const DEBUG = process.env.FASTMAIL_TRIAGE_DEBUG === "1";

// ── Question ────────────────────────────────────────────────────────────────

// One description per category: what it covers, which neighbour takes the
// look-alikes, and a few examples. Shared verbatim by the email and sender
// questions so both judge against the same boundaries.
const CATEGORY_CRITERIA = {
  reply: {
    covers: "A specific person is waiting on an answer, decision, or action from the user: a direct question, a meeting invite needing accept/decline, a document to approve.",
    not_for: "Automated or 'do not reply' mail, which is never 'reply'. Informational personal notes that ask nothing are 'fyi'.",
    examples: [
      "Maria Chen <maria@acme.com>: 'Can you review the Q3 deck before Thursday?'",
      "Calendar <invite@calendar.com>: 'Invitation: Design sync @ Fri 2pm'",
    ],
  },
  fyi: {
    covers: "Mail the user would want to have seen even though no reply is needed: receipts, shipping and delivery updates, security alerts, bills, statements, confirmations, personal-but-informational notes.",
    not_for: "Automated chatter with no lasting value, which is 'noise'. Job-application confirmations and status updates ('career').",
    examples: [
      "Amazon <ship@amazon.com>: 'Your package has shipped'",
      "Chase <alerts@chase.com>: 'Your statement is ready'",
      "Google <no-reply@accounts.google.com>: 'Security alert: new sign-in'",
    ],
  },
  offers: {
    covers: "Mail whose primary purpose is a sale, discount, coupon, or limited-time deal from a retailer or brand the user may still want to hear from.",
    not_for: "Editorial or digest content that ends with a small promo ('newsletter'). Political fundraising asks ('politics'). Unopened mass-marketing from an unfamiliar sender ('unsubscribe').",
    examples: [
      "Pottery Barn <sale@potterybarn.com>: 'Final hours: 50% off bedding'",
      "REI <news@rei.com>: 'Member deals + trail tips for spring' (read)",
    ],
  },
  newsletter: {
    covers: "Recurring editorial or digest content the user subscribed to: articles, roundups, product updates. Includes general news publications that cover politics.",
    not_for: "Mail pushing a sale ('offers'). Digests from campaigns or advocacy groups ('politics'). Job-listing digests and job alerts ('career'). Unopened low-value blasts ('unsubscribe').",
    examples: [
      "Stratechery <ben@stratechery.com>: 'The Weekly Article: Platform shifts' (read)",
      "GitHub <noreply@github.com>: 'Your weekly digest of repository activity'",
    ],
  },
  politics: {
    covers: "Mail from political campaigns, candidates, parties, PACs, or advocacy groups trying to mobilize, persuade, or fundraise: donation asks, petitions, voter outreach, action alerts. Applies whether or not the user reads it.",
    not_for: "News publications that merely report on politics, which are 'newsletter'.",
    examples: [
      "Team Rivera <info@riveraforsenate.com>: 'We're begging: $5 before the FEC deadline'",
      "Sierra Club <action@sierraclub.org>: 'Tell your senator: vote NO on the drilling bill'",
    ],
  },
  career: {
    covers: "Job-search mail: job alerts and job-board listing digests, 'jobs you may be interested in' recommendations, recruiter and staffing-agency outreach, and automated application confirmations or status updates from employers and applicant-tracking systems. Applies whether or not the user reads it.",
    not_for: "A specific recruiter or hiring manager personally waiting on the user, such as scheduling an interview or answering an offer ('reply'). Generic professional-network pings like profile views or connection suggestions ('noise'). Industry news newsletters that merely mention hiring ('newsletter').",
    examples: [
      "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>: '30+ new jobs for Senior Software Engineer'",
      "Indeed <alert@indeed.com>: 'New product manager jobs in Austin, TX'",
      "Acme Careers <no-reply@greenhouse.io>: 'Thank you for applying to Acme'",
    ],
  },
  unsubscribe: {
    covers: "Low-value recurring bulk, promotional, or newsletter mail the user is not engaging with and should stop receiving. Strongest when the mail is left unopened, the sender is generic mass-marketing, and the user has never written to it.",
    not_for: "Promos or newsletters from a brand or publication the user plausibly cares about, or that the user has opened ('offers' / 'newsletter'). Political mail ('politics'). Job alerts and recruiter mail, even unopened ('career').",
    examples: [
      "RandomBoutique <promo@shopxyz.com>: 'Dear friend, 70% off everything!!!' (unopened)",
      "DealsDaily <blast@dealsdaily.net>: 'You won't believe these prices' (unopened)",
    ],
  },
  noise: {
    covers: "Automated notifications or spam that fit none of the other folders and are safe to ignore: social pings, 'someone viewed your profile', app nudges.",
    not_for: "Receipts, alerts, bills, and other notices worth having seen ('fyi'). Job alerts, job recommendations, and recruiter messages ('career').",
    examples: [
      "LinkedIn <notify@linkedin.com>: 'You appeared in 9 searches this week'",
      "Nextdoor <digest@nextdoor.com>: 'New replies in your neighborhood'",
    ],
  },
} satisfies Record<Category, { covers: string; not_for: string; examples: string[] }>;

const GUIDANCE = [
  "Judge by the primary purpose of the mail, not its format.",
  "Political content outranks format: a political fundraising ask is 'politics', not 'offers'.",
  "Job-search content outranks format: a job-alert digest is 'career', not 'newsletter' or 'noise'.",
];

const emailQuestion = choice(
  {
    question: "Which inbox folder should `email` be filed in?",
    guidance: GUIDANCE,
  },
  CATEGORY_CRITERIA,
);

const senderQuestion = choice(
  {
    question: "Which inbox folder should all mail from `sender` be filed in?",
    guidance: [
      ...GUIDANCE,
      "Every email from this sender will be filed together, so judge the sender's typical mail from `sender.sample_subjects`.",
      "Choose 'reply' only if a person at this sender is personally waiting on the user, which is rare for these senders.",
    ],
  },
  CATEGORY_CRITERIA,
);

// ── State ───────────────────────────────────────────────────────────────────

function emailState(e: Email, g: SenderGroup | undefined): Record<string, JsonValue> {
  const { name, email } = senderOf(e);
  return {
    email: {
      from_name: name || "(none)",
      from_address: email,
      subject: e.subject ?? "(no subject)",
      preview: (e.preview ?? "").slice(0, 400),
      status: isUnread(e) ? "unopened" : "opened",
      // Only asserted when known: the Sent-history check runs for bulk-looking
      // senders, and per-email mail from them is exactly the replied ones.
      ...(g?.replied ? { user_has_written_to_sender: "yes" } : {}),
    },
  };
}

function volumeBucket(n: number): string {
  if (n === 1) return "1 email";
  if (n < 5) return "a few emails";
  if (n < 25) return "many emails";
  return "a very large number of emails";
}

function openedBucket(g: SenderGroup): string {
  if (g.unread === g.emails.length) return "none opened";
  if (g.unread === 0) return "all opened";
  return "some opened";
}

function senderState(g: SenderGroup): Record<string, JsonValue> {
  return {
    sender: {
      address: g.email,
      display_name: g.name || "(none)",
      kind: g.bulk ? "mailing list" : g.automated ? "automated notifications" : "high-volume sender",
      volume_in_mailbox: volumeBucket(g.emails.length),
      engagement: openedBucket(g),
      // Callers fill `replied` from the Sent-history check before asking.
      user_has_written_to_sender: g.replied ? "yes" : "no",
      sample_subjects: g.emails.slice(0, 3).map((e) => (e.subject ?? "").slice(0, 100)),
    },
  };
}

// ── Running ─────────────────────────────────────────────────────────────────

// Jev's published limit is 1,200 requests/min; pace starts just under it so
// 429s are rare (the SDK still retries them with backoff).
const REQUESTS_PER_SECOND = 18;
const CONCURRENCY = 12;

interface Paced<R> {
  results: Map<string, R>;
  errors: Map<string, string>;
  inputTokens: number;
}

/**
 * Run one TypeSafe request per entry with bounded concurrency and a
 * request-rate pace. A failed request lands in `errors` under its key — one
 * bad request never aborts the run.
 */
async function runPaced<J, R>(
  jobs: Map<string, J>,
  call: (ts: TypeSafeClient, job: J) => Promise<{ result: R; model: string; inputTokens: number }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Paced<R>> {
  const ts = getClient();
  const results = new Map<string, R>();
  const errors = new Map<string, string>();
  const entries = [...jobs];
  let inputTokens = 0;
  let next = 0;
  let done = 0;
  let nextStart = Date.now();
  const gap = 1000 / REQUESTS_PER_SECOND;

  async function worker(): Promise<void> {
    while (next < entries.length) {
      const [key, job] = entries[next++]!;
      const wait = nextStart - Date.now();
      nextStart = Math.max(nextStart, Date.now()) + gap;
      if (wait > 0) await Bun.sleep(wait);
      try {
        const res = await call(ts, job);
        results.set(key, res.result);
        inputTokens += res.inputTokens;
        if (DEBUG) {
          console.error(
            `[typesafe] ${key} model=${res.model} in=${res.inputTokens} ${JSON.stringify(res.result)}`,
          );
        }
      } catch (err) {
        errors.set(key, (err as Error).message);
      }
      done++;
      onProgress?.(done, entries.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()),
  );
  return { results, errors, inputTokens };
}

// ── Triage ──────────────────────────────────────────────────────────────────

export interface Verdict {
  category: Category;
  confidence: number;
  /** Next-most-likely category and its probability, for display. */
  runnerUp: { category: Category; p: number } | null;
}

export type Job =
  | { kind: "email"; email: Email; group?: SenderGroup }
  | { kind: "sender"; group: SenderGroup };

/**
 * Route each group the way triage does: bulk-ish senders get one sender-level
 * job (`s:<email>`), everyone else one job per email (`e:<id>`). Fill
 * `replied` first — it is what keeps engaged senders per-email.
 */
export function buildJobs(groups: Iterable<SenderGroup>): Map<string, Job> {
  const jobs = new Map<string, Job>();
  for (const g of groups) {
    if (isBulkish(g)) jobs.set(`s:${g.email}`, { kind: "sender", group: g });
    else for (const e of g.emails) jobs.set(`e:${e.id}`, { kind: "email", email: e, group: g });
  }
  return jobs;
}

/** The emails a job's verdict applies to. */
export function jobEmails(job: Job): Email[] {
  return job.kind === "sender" ? job.group.emails : [job.email];
}

function toVerdict(a: ChoiceResponse<typeof CATEGORY_CRITERIA>): Verdict {
  const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
  const second = ranked.find(([c]) => c !== a.choice);
  return {
    category: a.choice,
    confidence: a.confidence,
    runnerUp: second ? { category: second[0] as Category, p: second[1] } : null,
  };
}

/** Classify every triage job into a category verdict. */
export async function classifyJobs(
  jobs: Map<string, Job>,
  onProgress?: (done: number, total: number) => void,
): Promise<Paced<Verdict>> {
  return runPaced(
    jobs,
    async (ts, job) => {
      const res =
        job.kind === "email"
          ? await ts.systemOne({
              state: emailState(job.email, job.group),
              questions: { category: emailQuestion },
            })
          : await ts.systemOne({
              state: senderState(job.group),
              questions: { category: senderQuestion },
            });
      return {
        result: toVerdict(res.answers.category),
        model: res.model,
        inputTokens: res.usage.input_tokens,
      };
    },
    onProgress,
  );
}

/** Short human-readable explanation of a verdict for tables and --json. */
export function describeVerdict(v: Verdict): string {
  const alt =
    v.runnerUp && v.runnerUp.p >= 0.15
      ? `, else ${v.runnerUp.category} ${v.runnerUp.p.toFixed(2)}`
      : "";
  return `confidence ${v.confidence.toFixed(2)}${alt}`;
}

// ── Unsubscribe candidates ──────────────────────────────────────────────────

const unsubscribeQuestion = noul(
  {
    question:
      "Is `sender` a newsletter, marketing list, or promotional sender that the user could safely unsubscribe from?",
    guidance: [
      "Judge the sender's typical mail from `sender.sample_subjects`.",
      "Political campaign and advocacy mailing lists count as safe to unsubscribe from.",
    ],
  },
  {
    true: "Recurring bulk mail such as newsletters, digests, marketing, promotions, or political fundraising, where stopping future mail loses nothing the user needs.",
    false: "A person, or a sender of transactional or account mail the user needs: receipts, shipping updates, bills, statements, security alerts, password resets, calendar invites.",
  },
);

/**
 * Probability (0-1) that each sender is safe to unsubscribe from, keyed by
 * sender address. `replied` on each group must already be filled in.
 */
export async function scoreUnsubscribeCandidates(
  groups: SenderGroup[],
  onProgress?: (done: number, total: number) => void,
): Promise<Paced<number>> {
  return runPaced(
    new Map(groups.map((g) => [g.email, g])),
    async (ts, g) => {
      const res = await ts.systemOne({
        state: senderState(g),
        questions: { unsubscribe: unsubscribeQuestion },
      });
      return {
        result: res.answers.unsubscribe.noul,
        model: res.model,
        inputTokens: res.usage.input_tokens,
      };
    },
    onProgress,
  );
}
