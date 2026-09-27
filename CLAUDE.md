# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Running any mail command needs an API key — `TYPESAFE_API_KEY` for `triage` /
`unsubscribe`, `ANTHROPIC_API_KEY` for `find` / `filters` — a configured account
(`account add <name>`, or `FASTMAIL_TOKEN` / `FASTMAIL_ACCOUNTS=name:tok,name:tok`),
and — for `find` and `mailto:` unsubscribes only — the Rust engine binary on `PATH`
(`cargo install --git https://github.com/radiosilence/fastmail-cli`, or point
`FASTMAIL_CLI_BIN` at it).

Safe ways to exercise `triage` without touching a mailbox: `--dry-run` (grouped
tables), `--json` (one object per email on stdout), `--no-ai` (zero model calls).
`limits` and `stats` are read-only and need no model API key (`stats` reads
folder counts, headers, Sent history, and the local stores).

## Bun conventions

Default to Bun over Node.js: `bun <file>`, `bun test`, `bun install`, `bunx`.
Bun loads `.env` automatically — no `dotenv`. Prefer `Bun.file`, `Bun.spawn`,
and `Bun.$` over the `node:` equivalents (the `node:fs`/`node:path` use in
`config.ts` and the stores is deliberate: they want sync reads
and `mode: 0o600` on token files).

## Architecture

A Commander CLI (`src/cli.ts`) with one module per subcommand in `src/commands/`.
Every command follows the same shape: `resolveAccounts(opts.account)` →
loop over accounts (`ui.accountBanner` when more than one) → build a client per
account. `--account all` fans out; errors bubble to the single `run()` wrapper in
`cli.ts`, which prints and exits 1.

### Two mail backends, deliberately

- **`src/jmap.ts` (`JmapClient`)** — direct JMAP over `fetch`. Does everything
  the engine binary can't: sort order, folder selection, pagination, mailbox
  creation, bulk moves, raw header fetches, Sent-history queries. It reads the
  server's advertised core limits from the JMAP session (`limits()`) and sizes
  every bulk operation from them, so a 90k-email run never exceeds what
  Fastmail accepts. `triage` and `unsubscribe`'s scanning both run entirely
  through this.
- **`src/fastmail.ts` (`FastmailEngine`)** — subprocess wrapper around the
  `fastmail-cli` Rust binary, used only by `find` (text search + body fetch) and
  by `unsubscribe` for `mailto:` sends. Account isolation works by pointing
  `XDG_CONFIG_HOME` at `<configDir>/engine/<account>` per account, so tokens
  never clobber each other.

New JMAP capability belongs in `JmapClient`, not in the engine wrapper.

### The triage cost pipeline

`triage` is built for 90k+ mailboxes, so `src/commands/triage.ts` works through
cost tiers cheapest-first. Understanding this order is the key to the file:

1. **Stores (0 tokens)** — `UnsubStore` (`--skip-unsubscribed`) and
   `SenderVerdictStore` (`--use-cache`) short-circuit senders decided in an
   earlier run. Both are opt-in; verdicts are still recorded every run.
2. **Group by sender + Sent-history check (0 tokens)** — `groupBySender` in
   `src/heuristics.ts` aggregates per sender from RFC 2369/2919 headers; then
   `jmap.hasRepliedTo` answers "has the user ever written to this sender?" for
   bulk-looking candidates. `replied: true` is a veto — such senders are never
   bulk-classified and never auto-filed.
3. **Sender-level verdicts** — `isBulkish` senders get one request whose
   verdict applies to all their mail. 20–50x fewer requests on a backlog.
4. **Per-email verdicts** — personal-looking mail only, one request each.

`--no-ai` stops after tier 2 (`classifyHeuristically`, which returns `null`
rather than guessing when headers aren't conclusive).

### Classification on TypeSafe (`src/classify.ts`)

Tiers 3–4 call TypeSafe's Jev model (`@typesafe-ai/sdk`), not Claude. Each
request is one item's `state` plus one `choice()` question whose criteria are
`CATEGORY_CRITERIA`, so the answer is a typed `Category` with a probability
per label. Nothing is parsed from prose. Things to preserve:

- **Code computes facts; the model judges.** Read status, bulk/automated
  kind, and Sent history are computed in code and passed as named state
  fields. Counts are bucketed into words (`volumeBucket`, `openedBucket`)
  because Jev is weak at numbers. Keep dates and arithmetic out of state.
- **One item per request, lean state.** Jev loses accuracy on large state full
  of irrelevant detail, so emails are not packed together. Throughput comes
  from `classifyJobs`' concurrency plus a pace just under the 1,200 req/min
  limit; the SDK retries 429s.
- **Confidence gates action.** Verdicts below `--min-confidence` go to
  `held`: shown, never moved, never cached in `SenderVerdictStore`. The
  default (0.4, `DEFAULT_MIN_CONFIDENCE` in `triage.ts`) is a starting point, not a calibrated value; `calibrate`
  (`src/commands/calibrate.ts`) measures it on labelled folders. It must keep
  using `buildJobs` and `looksBulk` so it scores the same routing triage runs.
  Pin a versioned model via `TYPESAFE_DEFAULT_MODEL` once it's tuned.
- **Keep criteria shared.** The email and sender questions differ only in
  `instructions`. Put boundary rules in `CATEGORY_CRITERIA`'s `not_for`
  fields so both questions judge against the same definitions.

`unsubscribe`'s Inbox scan uses the same module: one `noul()` per sender over
the same `senderState`, with `replied` filled from Sent history first. Senders
at or above `--min-probability` (default 0.7) are targeted. That threshold is
deliberately higher than triage's because `--apply` contacts the sender. A
Noul probability isn't comparable to a Choice confidence, so never share
thresholds between the two. Both paths go through `runPaced`.

`FASTMAIL_TRIAGE_DEBUG=1` logs model, input tokens, and result per request.
`src/ai.ts` still uses Claude for the generative commands (`find`
summaries, `filters` suggestions).

### Adding or renaming a triage category

The category set is duplicated across several files by design — use the
`add-triage-category` skill for the full checklist.

### Conventions worth preserving

- **stdout is data, stderr is progress.** All `ui.info/warn/error` go to stderr
  so `triage --json | jq` pipes cleanly. Only `--json` payloads, tables, and
  summaries use `console.log`.
- **Folder selectors accept a leaf name or a `"Parent/Child"` path.** Leaf names
  are first-match-wins; paths disambiguate (a top-level `Politics` vs
  `Triage/Politics`). `resolveMailbox`/`pathOf` in `jmap.ts` implement this, and
  it applies everywhere a folder is named — `--mailbox`, `--then`.
- **Partial failure never aborts a run.** `moveEmailsBulk` returns `failed` ids
  instead of throwing; a failed TypeSafe request is counted as `untouched` and
  reported. Re-running picks up whatever was left.
- **Stores buffer in memory and `flush()` once.** `UnsubStore.flush()` is called
  from a `finally` — senders already contacted must not be contacted twice.
- **`unsubscribe` only contacts anyone under `--apply`.** Browser-only
  (`manual`) header links are reported, never auto-opened. When every header
  method fails, `unsubscribeViaBody` follows an unsubscribe link from the
  body and stores it with the sender in `UnsubStore`. `src/unsubform.ts`
  submits a confirmation form only through a control reading as
  unsubscribe/confirm (never resubscribe/keep/preferences); a page still
  showing any form or button after that counts as failed. On a TTY, each
  failure with a link gets a y/n "done it in the browser?" prompt
  (`askDoneInBrowser`); one that times out (60s) turns prompting off for the
  rest of the run. `--then` files mail only for
  senders that actually unsubscribed.

### State (all under `FASTMAIL_TRIAGE_HOME`, default `~/.config/fastmail-triage`)

`config.json` (accounts + default), `unsubscribed.json`, `sender-verdicts.json`,
`engine/<account>/` (engine tokens). All written
`0o600`. Env-provided accounts override same-named file accounts.

## Docker

Two-stage build (Rust engine → Bun app) with `FASTMAIL_TRIAGE_HOME=/data` on a
volume, so state survives runs. `docker compose run --rm cli <subcommand> …`, or
the `triage`/`unsubscribe`/`filters` convenience services.
