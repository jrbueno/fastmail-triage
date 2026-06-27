# fastmail-triage

AI-powered Fastmail inbox assistant. Four commands:

| Command | What it does |
|---|---|
| `triage` | Sorts unread/recent mail into **Needs Reply / FYI / Noise** and labels each email under a `Triage/` parent label in Fastmail (kept in Inbox). |
| `unsubscribe` | Finds newsletters & promo senders cluttering your inbox so you can cut them in one pass. |
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
bun run src/cli.ts triage                    # classify + label under Triage/
bun run src/cli.ts triage --dry-run          # preview only, apply no labels
bun run src/cli.ts triage --all --limit 80   # include read mail
bun run src/cli.ts triage --account all       # every configured account
bun run src/cli.ts unsubscribe
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

## How it works

```
fastmail-cli (JMAP)  →  Email JSON  →  Claude (Sonnet)  →  formatted output
       per-account token isolation via XDG_CONFIG_HOME
```

`triage` is the only command that writes: it creates a `Triage/` label tree
(`Needs Reply`, `FYI`, `Noise`) and **adds** the matching label to each email
while keeping it in the Inbox — nothing is moved, deleted, or sent. Use
`--dry-run` to preview without applying. Labeling uses a small direct-JMAP
client (`src/jmap.ts`) since the engine binary can't create mailboxes.

`unsubscribe` and `filters` are read-only — they produce suggestions you act on
yourself in Fastmail.
