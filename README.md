# fastmail-triage

AI-powered Fastmail inbox assistant. Four commands:

| Command | What it does |
|---|---|
| `triage` | Sorts mail into **Needs Reply / FYI / Offers / Newsletter / Unsubscribe / Noise** and files each email into a `Triage/` child mailbox in Fastmail. |
| `unsubscribe` | Finds newsletters & promo senders and **actually unsubscribes** via `List-Unsubscribe` (one-click POST or mailto), with a human-in-the-loop review step. |
| `find <query>` | Pulls a thread/topic (`"what did marketing say about the Q3 launch?"`) and summarizes it. |
| `filters` | Suggests filter/label rules based on what's actually in your inbox. |

It uses [`radiosilence/fastmail-cli`](https://github.com/radiosilence/fastmail-cli) as the JMAP
engine and [Claude](https://www.anthropic.com) for the analysis. **Multiple Fastmail accounts**
are supported — run any command against one account or `--account all`.

## Setup (local)

Requires [Bun](https://bun.sh) and the Rust engine binary.

```bash
# 1. Install the JMAP engine (Rust)
cargo install --git https://github.com/radiosilence/fastmail-cli

# 2. Install app deps
bun install

# 3. Provide your Claude key
export ANTHROPIC_API_KEY=sk-ant-...

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
bun run src/cli.ts triage --all --limit 80   # include read mail
bun run src/cli.ts triage --all --unread --limit 100000  # every unread email, no cap
bun run src/cli.ts triage --account all       # every configured account

# Clean out a huge inbox (read + unread), 40 per Claude call:
bun run src/cli.ts triage --all --limit 100000 --batch 40
bun run src/cli.ts unsubscribe                     # preview candidates in Inbox
bun run src/cli.ts unsubscribe --mailbox Unsubscribe --apply  # unsub everyone in a reviewed folder
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

If a sender is consistently miscategorized, add or tweak a worked example in
`TRIAGE_SYSTEM` in [src/ai.ts](src/ai.ts) and re-sample. Or preview as grouped
tables instead of JSON with `triage --limit 300 --dry-run`.

### Run automatically (cron)

Daily 8am triage on the host, output logged however you like:

```cron
0 8 * * *  cd /path/to/fastmail-triage && docker compose run --rm triage >> /var/log/triage.log 2>&1
```

## Configuration

Env vars (or `.env`):

- `ANTHROPIC_API_KEY` — required.
- `FASTMAIL_TOKEN` — single account token, or
- `FASTMAIL_ACCOUNTS` — `name:token,name:token` for multiple accounts.
- `FASTMAIL_TRIAGE_MODEL` — Claude model (default `claude-sonnet-4-6`).
- `FASTMAIL_CLI_BIN` — path to the engine if not on `PATH`.
- `FASTMAIL_TRIAGE_HOME` — config/token storage dir (default `~/.config/fastmail-triage`).
- `FASTMAIL_TRIAGE_DEBUG=1` — log Claude prompt-cache usage (write/read/uncached tokens).

**Prompt caching.** Each task's stable instructions live in a cached `system`
prompt (`cache_control: ephemeral`); the per-request email data goes in the user
message. The triage rubric includes worked few-shot examples, which both sharpen
classification and push the cached prefix over the model's minimum — so across a
large batched run the prefix is served from cache at ~0.1x input cost.

## How it works

```
fastmail-cli (JMAP)  →  Email JSON  →  Claude (Sonnet)  →  formatted output
       per-account token isolation via XDG_CONFIG_HOME
```

`triage` is the only command that writes: it **moves** each classified email
into a `Triage/` child mailbox (`Needs Reply`, `FYI`, `Offers`, `Newsletter`,
`Noise`), which removes it from the source folder. The `Triage/` folders are
**created automatically** if missing (only the children actually needed for a
run). Use `--dry-run` to preview without moving, `--oldest` to process the
oldest mail first, and `--mailbox <name>` to triage a folder other than Inbox.

**Scale.** `triage` processes mail in batches (`--batch`, default 40) — each
batch is one Claude call, then a single bulk JMAP move per category. It loops,
draining the mailbox until `--limit` is reached or nothing is left, so it
handles very large inboxes (tens of thousands). Because filed mail leaves the
source folder, you can stop (Ctrl-C) and resume anytime — re-running just
continues with what's left.

Fetching (sort order, folder selection, pagination), folder creation, and the
bulk moves all use a small direct-JMAP helper (`src/jmap.ts`), since the engine
binary exposes none of these. The engine is still used by `find` and by
`unsubscribe` (mailto: sends).

### Unsubscribe workflow (human-in-the-loop)

`triage` can route low-value mail you don't engage with into `Triage/Unsubscribe`.
Then:

1. `unsubscribe` — preview candidates (in the Inbox it uses Claude to pick
   newsletters/promo; a folder or `--sender` is taken as-is). Shows each sender's
   method: **1-click (auto)**, **email (auto)**, **browser (manual)**, or **no method**.
   Add `--skip-no-header` to drop senders with no `List-Unsubscribe` header so the
   run only handles ones that can actually be unsubscribed.
2. Review the list.
3. `unsubscribe --mailbox Unsubscribe --apply` (or `--sender <email> --apply`) —
   actually unsubscribes: HTTPS one-click POST (RFC 8058) or a `mailto:`
   message via the engine. Browser-only links are reported, never auto-opened.
   One request **per unique sender**, not per email.
4. Optionally add `--then trash` / `--then archive` / `--then <folder>` to file
   the existing mail of senders that unsubscribed **successfully** (failed or
   browser-only senders are left untouched).

Successful unsubscribes are **remembered** per account (in
`$FASTMAIL_TRIAGE_HOME/unsubscribed.json`). On later runs those senders are
**not contacted again** — they're marked `Prev ✓` in the preview, and under
`--apply` they're skipped but their new mail is still filed via `--then`. So a
recurring `unsubscribe --mailbox Unsubscribe --apply --then trash` keeps binning
a known sender's mail without re-sending unsubscribe requests.

`unsubscribe` only contacts senders when you pass `--apply`. `filters` is
read-only — it produces suggestions you act on yourself in Fastmail.
