import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AccountsService } from "./accounts";

const CODEX_DIR = join(homedir(), ".codex");
export const CODEX_AUTH = join(CODEX_DIR, "auth.json");

// ─── WatcherService ───────────────────────────────────────────────────────────

export class WatcherService {
  constructor(private readonly accounts: AccountsService) {}

  readAuth(): Record<string, any> | null {
    try {
      if (!existsSync(CODEX_AUTH)) return null;
      return JSON.parse(readFileSync(CODEX_AUTH, "utf8"));
    } catch { return null; }
  }
}
