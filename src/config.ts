/**
 * Multi-account configuration for fastmail-triage.
 *
 * Stored at $FASTMAIL_TRIAGE_CONFIG or ~/.config/fastmail-triage/config.json
 *
 * Accounts can also be supplied purely via environment variables (useful for
 * Docker / CI), bypassing the on-disk config entirely:
 *   FASTMAIL_TOKEN              single default account
 *   FASTMAIL_ACCOUNTS           "work:tok_aaa,personal:tok_bbb"
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Account {
  name: string;
  token: string;
}

export interface Config {
  accounts: Account[];
  default?: string;
}

export function configDir(): string {
  if (process.env.FASTMAIL_TRIAGE_HOME) return process.env.FASTMAIL_TRIAGE_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "fastmail-triage");
}

function configPath(): string {
  return process.env.FASTMAIL_TRIAGE_CONFIG || join(configDir(), "config.json");
}

/** Accounts injected purely through environment variables. */
function accountsFromEnv(): Account[] {
  const accounts: Account[] = [];
  if (process.env.FASTMAIL_ACCOUNTS) {
    for (const pair of process.env.FASTMAIL_ACCOUNTS.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const token = pair.slice(idx + 1).trim();
      if (name && token) accounts.push({ name, token });
    }
  }
  if (process.env.FASTMAIL_TOKEN) {
    accounts.push({ name: "default", token: process.env.FASTMAIL_TOKEN });
  }
  return accounts;
}

export function loadConfig(): Config {
  const fromEnv = accountsFromEnv();
  let fileConfig: Config = { accounts: [] };

  const path = configPath();
  if (existsSync(path)) {
    try {
      fileConfig = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse config at ${path}: ${(err as Error).message}`);
    }
  }

  // Env accounts win over file accounts of the same name.
  const byName = new Map<string, Account>();
  for (const a of fileConfig.accounts ?? []) byName.set(a.name, a);
  for (const a of fromEnv) byName.set(a.name, a);

  return {
    accounts: [...byName.values()],
    default: fileConfig.default ?? fromEnv[0]?.name,
  };
}

export function saveConfig(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Resolve which accounts a command should run against.
 * @param selector  --account flag value: a name, "all", or undefined (=default)
 */
export function resolveAccounts(selector?: string): Account[] {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    throw new Error(
      "No Fastmail accounts configured. Run `fastmail-triage account add <name>` " +
        "or set FASTMAIL_TOKEN / FASTMAIL_ACCOUNTS.",
    );
  }

  if (selector === "all") return config.accounts;

  if (selector) {
    const match = config.accounts.find((a) => a.name === selector);
    if (!match) {
      const names = config.accounts.map((a) => a.name).join(", ");
      throw new Error(`Unknown account "${selector}". Available: ${names}`);
    }
    return [match];
  }

  const first = config.accounts[0]!;
  const name = config.default ?? first.name;
  const def = config.accounts.find((a) => a.name === name) ?? first;
  return [def];
}

export function addAccount(name: string, token: string, makeDefault = false): void {
  const config = existsSync(configPath())
    ? JSON.parse(readFileSync(configPath(), "utf8"))
    : { accounts: [] };
  config.accounts = (config.accounts ?? []).filter((a: Account) => a.name !== name);
  config.accounts.push({ name, token });
  if (makeDefault || !config.default) config.default = name;
  saveConfig(config);
}

export function removeAccount(name: string): void {
  if (!existsSync(configPath())) return;
  const config: Config = JSON.parse(readFileSync(configPath(), "utf8"));
  config.accounts = (config.accounts ?? []).filter((a) => a.name !== name);
  if (config.default === name) config.default = config.accounts[0]?.name;
  saveConfig(config);
}
