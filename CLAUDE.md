# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install
bun test                                   # all tests
bun test src/heuristics.test.ts            # one file
bun test -t "bulk headers detected"        # one test by name
bun run typecheck                          # tsc --noEmit (strict, noUncheckedIndexedAccess)
bun run build                              # → dist/fastmail-triage (compiled binary)
bun run src/cli.ts <subcommand>            # run the CLI
```

Running any mail command needs `ANTHROPIC_API_KEY`, a configured account
(`account add <name>`, or `FASTMAIL_TOKEN` / `FASTMAIL_ACCOUNTS=name:tok,name:tok`),
and — for `find` and `mailto:` unsubscribes only — the Rust engine binary on `PATH`
(`cargo install --git https://github.com/radiosilence/fastmail-cli`, or point
`FASTMAIL_CLI_BIN` at it).

Safe ways to exercise `triage` without touching a mailbox: `--dry-run` (grouped
tables), `--json` (one object per email on stdout), `--no-ai` (zero Claude tokens).
`limits` is read-only and needs no API key.

## Bun conventions

Default to Bun over Node.js: `bun <file>`, `bun test`, `bun install`, `bunx`.
Bun loads `.env` automatically — no `dotenv`. Prefer `Bun.file`, `Bun.spawn`,
and `Bun.$` over the `node:` equivalents (the `node:fs`/`node:path` use in
`config.ts`, `checkpoint.ts`, and the stores is deliberate: they want sync reads
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
   `SenderVerdictStore` short-circuit senders decided in an earlier run.
2. **Group by sender + Sent-history check (0 tokens)** — `groupBySender` in
   `src/heuristics.ts` aggregates per sender from RFC 2369/2919 headers; then
   `jmap.hasRepliedTo` answers "has the user ever written to this sender?" for
   bulk-looking candidates. `replied: true` is a veto — such senders are never
   bulk-classified and never auto-filed.
3. **Sender-level Claude verdicts** — `isBulkish` senders get one verdict
   applied to all their mail, with no `reason` field (output tokens cost 5x
   input). 20–50x token reduction on a backlog.
4. **Per-email Claude classification** — personal-looking mail only, `--batch`
   per request.

`--no-ai` stops after tier 2 (`classifyHeuristically`, which returns `null`
rather than guessing when headers aren't conclusive).

All Claude requests for a run are submitted as **one Message Batches API job**
(`src/batch.ts`, 50% token price). `--sync` swaps in concurrent direct calls.

### Batch checkpointing

A submitted batch keeps processing and billing server-side after the CLI dies,
so `src/checkpoint.ts` writes the batch ids **and** the request→email mapping to
`pending-batch-<account>.json` the instant the batch is created.
`resumePendingBatch` runs at the top of every `triage` invocation, reattaches,
and applies the results with the *current* run's flags before doing anything
new. Consequences for anything you change here: the mapping in the checkpoint
must stay sufficient to reconstruct classifications without re-asking Claude
(`ingestOutcome` is shared by the live path and the resume path), and the
checkpoint is discarded on unrecoverable reattach errors so runs can't wedge.

### Prompt caching invariant

`CATEGORY_RUBRIC` in `src/ai.ts` is spliced into both triage system prompts and
carries `cache_control: ephemeral`. It must stay **byte-identical across every
request in a run** for the prefix to be served from cache at ~0.1x, and long
enough to clear the model's caching minimum (~1-2k tokens) — which is part of
why the worked few-shot examples are there. Never move per-request data into the
system block. `FASTMAIL_TRIAGE_DEBUG=1` logs cache write/read/uncached tokens.

### Adding or renaming a triage category

The category set is duplicated across several files by design; a new one needs
all of:

- `src/ai.ts` — the `Category` union, `CATEGORIES`, the `CATEGORY_RUBRIC` text
  (including the "tricky boundaries" and worked-examples sections), and the
  literal category list inside both `Return ONLY a JSON array…` lines.
- `src/commands/triage.ts` — `MAILBOX_NAMES` (the Fastmail folder leaf),
  `LABELS`, `COLOR`, `emptyTotals()`.
- `src/senderstore.ts` — `CACHEABLE_CATEGORIES`, but only if the category
  describes a *sender* rather than a message. `reply` and `fyi` are excluded on
  purpose; caching them would misfile future mail.
- `src/heuristics.ts` — `HeuristicCategory`, only if headers alone can prove it.

Model output is untrusted: `parseTriageResults` / `parseSenderVerdicts` tolerate
fences and prose and silently drop entries with unknown categories, so a new
category that isn't in `CATEGORIES` fails as "unclassified", not as an error.

### Conventions worth preserving

- **stdout is data, stderr is progress.** All `ui.info/warn/error` go to stderr
  so `triage --json | jq` pipes cleanly. Only `--json` payloads, tables, and
  summaries use `console.log`.
- **Folder selectors accept a leaf name or a `"Parent/Child"` path.** Leaf names
  are first-match-wins; paths disambiguate (a top-level `Politics` vs
  `Triage/Politics`). `resolveMailbox`/`pathOf` in `jmap.ts` implement this, and
  it applies everywhere a folder is named — `--mailbox`, `--then`.
- **Partial failure never aborts a run.** `moveEmailsBulk` returns `failed` ids
  instead of throwing; a bad Claude request is counted as `untouched` and
  reported. Re-running picks up whatever was left.
- **Stores buffer in memory and `flush()` once.** `UnsubStore.flush()` is called
  from a `finally` — senders already contacted must not be contacted twice.
- **`unsubscribe` only contacts anyone under `--apply`.** Browser-only
  (`manual`) links are reported, never auto-opened; `--then` files mail only for
  senders that actually unsubscribed.

### State (all under `FASTMAIL_TRIAGE_HOME`, default `~/.config/fastmail-triage`)

`config.json` (accounts + default), `unsubscribed.json`, `sender-verdicts.json`,
`pending-batch-<account>.json`, `engine/<account>/` (engine tokens). All written
`0o600`. Env-provided accounts override same-named file accounts.

## Docker

Two-stage build (Rust engine → Bun app) with `FASTMAIL_TRIAGE_HOME=/data` on a
volume, so state survives runs. `docker compose run --rm cli <subcommand> …`, or
the `triage`/`unsubscribe`/`filters` convenience services.
