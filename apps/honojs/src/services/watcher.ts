import { watch, existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AccountsService } from "./accounts";

const CODEX_DIR = join(homedir(), ".codex");
export const CODEX_AUTH = join(CODEX_DIR, "auth.json");

export type WatchEvent = { email: string; isNew: boolean };

// ─── WatcherService ───────────────────────────────────────────────────────────

export class WatcherService {
  constructor(private readonly accounts: AccountsService) {}

  readAuth(): Record<string, any> | null {
    try {
      if (!existsSync(CODEX_AUTH)) return null;
      return JSON.parse(readFileSync(CODEX_AUTH, "utf8"));
    } catch { return null; }
  }

  watchCodexAuth(onImport: (event: WatchEvent) => void): void {
    let lastToken = "";
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const tryImport = (_event?: string, filename?: string | null) => {
      if (filename && filename !== "auth.json") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const auth = this.readAuth();
        if (!auth?.tokens?.access_token) return;
        if (auth.tokens.access_token === lastToken) return;
        lastToken = auth.tokens.access_token;

        const existingIds = new Set(this.accounts.getAccounts().map((a) => a.id));
        const account = this.accounts.importFromTokens(auth.tokens);
        if (!account) return;

        const isNew = !existingIds.has(account.id);
        console.log(`[watcher] auth.json changed → ${isNew ? "NEW" : "TOKEN REFRESH"}: ${account.email}`);
        onImport({ email: account.email, isNew });
      }, 200);
    };

    tryImport();

    if (!existsSync(CODEX_DIR)) {
      console.warn(`[watcher] ~/.codex not found — skipping watch`);
      return;
    }
    try {
      watch(CODEX_DIR, { persistent: false }, tryImport);
      console.log(`[watcher] Watching directory ${CODEX_DIR} for auth.json changes`);
    } catch (e) {
      console.warn(`[watcher] Could not set up file watcher: ${e}`);
    }
  }
}
