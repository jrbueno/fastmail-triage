import { password, isCancel } from "@clack/prompts";
import { addAccount, removeAccount, loadConfig, saveConfig } from "../config.ts";
import * as ui from "../ui.ts";

export async function accountAdd(name: string, opts: { default?: boolean }): Promise<void> {
  // Token can come from FASTMAIL_TOKEN env or interactive prompt.
  let token = process.env.FASTMAIL_TOKEN ?? "";
  if (!token) {
    const entered = await password({
      message: `Fastmail API token for "${name}" (create one at Settings → Privacy & Security → API tokens):`,
    });
    if (isCancel(entered) || !entered) {
      ui.error("Cancelled.");
      process.exit(1);
    }
    token = entered;
  }
  addAccount(name, token, opts.default ?? false);
  ui.info(`Saved account "${name}"${opts.default ? " (default)" : ""}.`);
}

export function accountList(): void {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    ui.info("No accounts configured.");
    return;
  }
  ui.header("Configured accounts");
  ui.table({
    head: ["Name", "Default", "Token"],
    colWidths: [24, 11, 16],
    rows: config.accounts.map((a) => [
      a.name,
      a.name === config.default ? "✓" : "",
      a.token.slice(0, 6) + "…",
    ]),
  });
}

export function accountRemove(name: string): void {
  removeAccount(name);
  ui.info(`Removed account "${name}".`);
}

export function accountDefault(name: string): void {
  const config = loadConfig();
  if (!config.accounts.find((a) => a.name === name)) {
    ui.error(`Unknown account "${name}".`);
    process.exit(1);
  }
  config.default = name;
  saveConfig(config);
  ui.info(`Default account set to "${name}".`);
}
