# fastmail-triage

AI-powered Fastmail inbox assistant. Six commands:

| Command | What it does |
|---|---|
| `triage` | Sorts mail into **Needs Reply / FYI / Offers / Newsletter / Politics / Unsubscribe / Noise** and files each email into a `Triage/` child mailbox in Fastmail. |
| `unsubscribe` | Finds newsletters & promo senders and **actually unsubscribes** via `List-Unsubscribe` (one-click POST or mailto), with a human-in-the-loop review step. |
| `stats` | Zero-token report: folder totals, the shape of a folder (unread, list, automated), top senders with their cached verdicts, and mailing lists you never open. |
| `calibrate` | Runs the classifier over mail that's already filed, measures accuracy at each confidence threshold, and recommends a `--min-confidence`. |
| `find <query>` | Pulls a thread/topic (`"what did marketing say about the Q3 launch?"`) and summarizes it. |
| `filters` | Suggests filter/label rules based on what's actually in your inbox. |

It uses [`radiosilence/fastmail-cli`](https://github.com/radiosilence/fastmail-cli) as the JMAP
engine, [TypeSafe](https://typesafe.ai)'s Jev model for the classification in `triage` and
`unsubscribe`, and [Claude](https://www.anthropic.com) for the generative work (`find`, `filters`). **Multiple Fastmail accounts**
are supported — run any command against one account or `--account all`.

## Setup (local)

Requires [Bun](https://bun.sh) and the Rust engine binary.

```bash
# 1. Install the JMAP engine (Rust)
cargo install --git https://github.com/radiosilence/fastmail-cli

# 2. Install app deps
bun install

# 3. Provide your API keys
export TYPESAFE_API_KEY=...        # triage, unsubscribe
export ANTHROPIC_API_KEY=sk-ant-... # find, filters

# 4. Add a Fastmail account (token: Settings → Privacy & Security → API tokens)
bun run src/cli.ts account add work --default
bun run src/cli.ts account add personal
```

## Usage

```bash
bun run src/cli.ts triage                    # classify + file under Triage/
bun run src/cli.ts triage --dry-run          # preview only, move nothing
bun run src/cli.ts triage --oldest           # start with the oldest mail
bun run src/cli.ts triage --mailbox Archive  # triage a specific folder (default: Inbox)
bun run src/cli.ts triage --mailbox "Lists/Vendors"  # "Parent/Child" path when leaf names are ambiguous
bun run src/cli.ts triage --all --limit 80   # include read mail
bun run src/cli.ts triage --all --unread --limit 100000  # every unread email, no cap
bun run src/cli.ts triage --include-pinned    # triage pinned (flagged) mail too
bun run src/cli.ts triage --skip-unsubscribed # already-unsubscribed senders → Unsubscribe, no model call
bun run src/cli.ts triage --no-ai             # zero tokens: header heuristics + Sent history only
bun run src/cli.ts triage --min-confidence 0.5 # hold back more uncertain verdicts (default 0.4)
bun run src/cli.ts triage --use-cache         # file senders decided in an earlier run, no model call
bun run src/cli.ts triage --account all       # every configured account
bun run src/cli.ts limits                     # show + probe Fastmail's JMAP limits (read-only)
bun run src/cli.ts stats                      # folder totals, top senders, never-opened lists (no model calls)
bun run src/cli.ts stats -m Triage/Newsletter --top 50  # which lists pile up unread in a triage folder
bun run src/cli.ts stats --all --json | jq .ignoredLists  # every never-opened list, as data

# Clean out a huge inbox (read + unread):
bun run src/cli.ts triage --all --limit 100000
bun run src/cli.ts unsubscribe                     # preview candidates in Inbox
bun run src/cli.ts unsubscribe --min-probability 0.5  # cast a wider net (default 0.7)
bun run src/cli.ts unsubscribe --mailbox Unsubscribe --apply  # unsub everyone in a reviewed folder
bun run src/cli.ts unsubscribe --mailbox "Triage/Politics" --apply  # path form targets the Triage child, not a same-named top-level folder
bun run src/cli.ts unsubscribe --sender news@store.com --apply  # one sender
bun run src/cli.ts unsubscribe --mailbox Unsubscribe --apply --then trash  # unsub + bin their mail
bun run src/cli.ts unsubscribe --mailbox Unsubscribe --apply --skip-no-header  # only senders with a List-Unsubscribe header
bun run src/cli.ts unsubscribe --mailbox Unsubscribe --all --apply --then trash  # process the whole folder
bun run src/cli.ts find "Q3 launch marketing" --after 2026-01-01
bun run src/cli.ts filters --json            # machine-readable output
```

Account management:

```bash
bun run src/cli.ts account list
bun run src/cli.ts account default personal
bun run src/cli.ts account remove work
```

Build a standalone binary:

```bash
bun run build      # → dist/fastmail-triage
```

## Docker

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY + FASTMAIL_TOKEN/FASTMAIL_ACCOUNTS
docker compose build

docker compose run --rm triage
docker compose run --rm cli find "Q3 launch marketing"
docker compose run --rm cli unsubscribe --account work
```

With `FASTMAIL_ACCOUNTS` / `FASTMAIL_TOKEN` set in `.env`, accounts are picked up
automatically — no `account add` step needed inside the container.

### Audit accuracy before a full sweep

`triage --json` prints one reviewable object per email — `{id, category, reason,
sender, subject}` — to stdout (progress goes to stderr, so it pipes cleanly into
`jq`). Sample a few hundred and eyeball the result before committing to a 98k run:

```bash
# Capture a sample (newest 300 unread), nothing is moved
bun run src/cli.ts triage --limit 300 --json > sample.json

# Category breakdown
jq -r 'group_by(.category)[] | "\(.[0].category): \(length)"' sample.json

# Spot-check one category — are these really "unsubscribe"?
jq -r '.[] | select(.category=="unsubscribe") | "\(.sender) — \(.subject)"' sample.json

# Find anything filed as reply/fyi to make sure nothing important is buried
jq -r '.[] | select(.category=="reply" or .category=="fyi")
        | "[\(.category)] \(.sender) — \(.subject)"' sample.json
```

If a sender is consistently miscategorized, tighten the `covers` / `not_for` /
`examples` of the categories involved in `CATEGORY_CRITERIA`
([src/classify.ts](src/classify.ts)) and re-sample. Or preview as grouped
tables instead of JSON with `triage --limit 300 --dry-run`.

### Tune `--min-confidence` with `calibrate`

`calibrate` samples the newest emails from labelled folders, runs them through
the same routing as `triage` (without the verdict cache, and writing nothing),
and reports accuracy at each threshold:

```bash
bun run src/cli.ts calibrate                      # Triage/* folders, 40 emails each
bun run src/cli.ts calibrate -l Shopping=offers -l "Lists/Town=newsletter"  # add hand-filed folders
bun run src/cli.ts calibrate --no-triage-folders -l Receipts=fyi   # hand-filed labels only
bun run src/cli.ts calibrate --target 0.95 --json > calib.json    # every scored email, for jq
```

It prints a threshold sweep (share filed, accuracy, wrong moves), the lowest
threshold that reaches `--target` accuracy (default 90%), per-category
recall/precision, a confusion matrix, and the most confident disagreements.

Mind what the labels mean. Mail in `Triage/*` was filed by earlier runs, so it
measures **agreement with the previous classifier**, not correctness. It is
also almost all unread, because it was filed before you saw it, which pushes
the model's engagement signal toward `unsubscribe`. Folders you filed by hand
(`--label`) are the real ground truth. Re-run after changing
`CATEGORY_CRITERIA` or the model, and pin `TYPESAFE_DEFAULT_MODEL` to the
version you calibrated.

### Run automatically (cron)

Daily 8am triage on the host, output logged however you like:

```cron
0 8 * * *  cd /path/to/fastmail-triage && docker compose run --rm triage >> /var/log/triage.log 2>&1
```

## Configuration

Env vars (or `.env`):

- `TYPESAFE_API_KEY` — required for `triage` (unless `--no-ai`) and for
  `unsubscribe`'s Inbox scan.
- `TYPESAFE_DEFAULT_MODEL` — TypeSafe model (default `jev-latest`;
  pin a versioned id such as `jev-1.13.0` once you've tuned `--min-confidence`).
- `ANTHROPIC_API_KEY` — required for `find` and `filters`.
- `FASTMAIL_TOKEN` — single account token, or
- `FASTMAIL_ACCOUNTS` — `name:token,name:token` for multiple accounts.
- `FASTMAIL_TRIAGE_MODEL` — Claude model for the non-triage commands (default
  `claude-sonnet-4-6`; `claude-haiku-4-5` is ~3x cheaper).
- `FASTMAIL_CLI_BIN` — path to the engine if not on `PATH`.
- `FASTMAIL_TRIAGE_HOME` — config/token storage dir (default `~/.config/fastmail-triage`).
- `FASTMAIL_TRIAGE_DEBUG=1` — log each TypeSafe verdict (model, input tokens,
  category, confidence) and Claude prompt-cache usage.

**State files** (under `FASTMAIL_TRIAGE_HOME`): `unsubscribed.json` — senders
already unsubscribed; `sender-verdicts.json` — cached per-sender triage
verdicts (bulk categories only), written every run and consulted only with `--use-cache`.

## How it works

```
JMAP  →  Email JSON  →  TypeSafe Jev (triage, unsubscribe) / Claude (find, filters)  →  formatted output
       per-account token isolation via XDG_CONFIG_HOME
```

`triage` is the only command that writes: it **moves** each classified email
into a `Triage/` child mailbox (`Needs Reply`, `FYI`, `Offers`, `Newsletter`,
`Politics`, `Noise`), which removes it from the source folder. The `Triage/` folders are
**created automatically** if missing (only the children actually needed for a
run). Use `--dry-run` to preview without moving, `--oldest` to process the
oldest mail first, and `--mailbox <name>` to triage a folder other than Inbox.

Everywhere a folder is named (`--mailbox`, `--then`), you can pass either a
leaf name (`Politics` — first match wins if several folders share it) or a
full `"Parent/Child"` path (`Triage/Politics`) to pin down exactly which one.

Pinned mail is left alone by default. Fastmail's pin is the JMAP `$flagged`
keyword; it's excluded in the server-side query, so pinned mail is never
fetched, classified, or moved, and doesn't count toward `--limit`. Pass
`--include-pinned` to triage it anyway.

Pass `--skip-unsubscribed` to short-circuit senders you've already unsubscribed
from (tracked in `unsubscribed.json`): their mail is filed straight into
`Triage/Unsubscribe` without a model call, so a recurring triage of a
big inbox gets cheaper as the unsubscribe list grows.

**Scale & cost.** `triage` is built for very large mailboxes (90k+ emails).
A run works through cost tiers, cheapest first:

1. **Stores (0 tokens).** Already-unsubscribed senders (`--skip-unsubscribed`)
   and, with `--use-cache`, every sender classified in a previous run
   (`sender-verdicts.json` — bulk categories only) are filed without any API
   call. Recurring triage gets cheaper every run.
2. **Sender-level classification.** Remaining mail is grouped by sender.
   Bulk-looking senders (List-Unsubscribe/List-Id/Precedence headers,
   automated/no-reply addresses, or high volume — and never written to, per a
   zero-token Sent-mailbox check) get **one verdict per sender**, applied to
   all their mail. On a big backlog this is a 20–50x request reduction vs
   per-email classification.
3. **Per-email classification.** Personal-looking mail gets one request per
   email.

Each request asks TypeSafe's Jev model one typed Choice question over the
categories and gets back a label, a probability per category, and a
confidence. Requests take ~100ms and are paced just under Jev's rate limit,
so there is no batch job to wait on. Verdicts below `--min-confidence`
(default 0.4) are **held**: listed under `--dry-run`, flagged `"held": true`
in `--json`, and left in place instead of filed. Held sender verdicts are
never cached. Tune the threshold on your own mail with `--dry-run` before a
big run. Use `--no-ai` for a fully zero-token coarse
triage: bulk mail is filed from headers alone (entirely-unread bulk from
never-written-to senders → `Unsubscribe`, other bulk → `Newsletter`, automated
notifications → `FYI`) and anything plausibly personal is left in place.

Everything is fetched up front in pages sized from Fastmail's advertised JMAP
limits, and moves happen as bulk `Email/set` calls with mixed destinations
(run `fastmail-triage limits` to see and live-probe those limits — Fastmail
advertises 4096 objects per get/set, 50 method calls per request, 10MB
bodies). Individual request failures are reported and skipped, never fatal —
re-running picks up whatever was left.

Fetching (sort order, folder selection, pagination), folder creation, and the
bulk moves all use a small direct-JMAP helper (`src/jmap.ts`), since the engine
binary exposes none of these. The engine is still used by `find` and by
`unsubscribe` (mailto: sends).

### Unsubscribe workflow (human-in-the-loop)

`triage` can route low-value mail you don't engage with into `Triage/Unsubscribe`.
Then:

0. Optionally, `stats -m Triage/Newsletter` (or any folder) lists mailing
   lists with 3+ emails that you've never opened and never written to. It's
   free, and a good source of `--sender` targets.
1. `unsubscribe` — preview candidates. In the Inbox it asks TypeSafe, once per
   sender, how likely the sender is a newsletter/marketing/promo list that's
   safe to leave. It sees the sender's bulk-mail headers, how much of its mail
   you've opened, whether you've ever written to it, and sample subjects.
   Senders at or above `--min-probability` (default 0.7) are targeted, and the
   `P` column shows each score. A folder or `--sender` is taken as-is. Shows each sender's
   method: **1-click (auto)**, **email (auto)**, **browser (manual)**, or **no method**.
   Add `--skip-no-header` to drop senders with no `List-Unsubscribe` header so the
   run only handles ones that can actually be unsubscribed.
2. Review the list.
3. `unsubscribe --mailbox Unsubscribe --apply` (or `--sender <email> --apply`;
   use a `"Triage/Unsubscribe"` path if another folder shares the leaf name) —
   actually unsubscribes: HTTPS one-click POST (RFC 8058) or a `mailto:`
   message via the engine. If that fails or the sender has no usable header
   method, it falls back to the **unsubscribe link in the email body** (link
   text or URL mentioning unsubscribe/opt-out, HTTPS only) and opens it,
   keeping cookies across redirects. If it lands on a confirmation page, it
   presses the unsubscribe/confirm button (never resubscribe, cancel, or
   update-preferences), leaves topic checkboxes unticked, and fills an empty
   email field with the address the mail was sent to. A page that still shows
   any form or button afterwards is reported as failed rather than counted as
   done. The header's own browser-only link is reported, never auto-opened.
   In a terminal, each failure with a link shows it and asks **y/n: did you
   unsubscribe in the browser?** — `y` records the sender (and files its mail
   via `--then`) like any other success. If a prompt goes unanswered for a
   minute, the run moves on and stops prompting for the rest of that run.
   One request **per unique sender**, not per email.
4. Optionally add `--then trash` / `--then archive` / `--then <folder>` to file
   the existing mail of senders that unsubscribed **successfully** (failed or
   browser-only senders are left untouched).

Successful unsubscribes are **remembered** per account (in
`$FASTMAIL_TRIAGE_HOME/unsubscribed.json`, with the link used when it came
from the body; a link already used for one sender isn't fetched again for
another). On later runs those senders are
**not contacted again** — they're marked `Prev ✓` in the preview, and under
`--apply` they're skipped but their new mail is still filed via `--then`. So a
recurring `unsubscribe --mailbox Unsubscribe --apply --then trash` keeps binning
a known sender's mail without re-sending unsubscribe requests.

`unsubscribe` only contacts senders when you pass `--apply`. `filters` is
read-only — it produces suggestions you act on yourself in Fastmail.
