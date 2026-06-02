import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const LOG_DIR = join(import.meta.dir, "..", "..", "logs");
const LOG_FILE = join(LOG_DIR, "requests.log");

// ─── LoggerService ────────────────────────────────────────────────────────────

export class LoggerService {
  private ensureDir(): void {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  }

  private ts(ms = Date.now()): string {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 23);
  }

  private writeLine(line: string): void {
    try {
      this.ensureDir();
      appendFileSync(LOG_FILE, line + "\n");
    } catch {
      // log failures should never crash the proxy
    }
  }

  logRequest(entry: {
    timestamp: number;
    method: string;
    path: string;
    status: number;
    latencyMs: number;
    email: string;
    usage?: {
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
    };
    errorSnippet?: string;
    accountSwitched?: { from: string; to: string; reason: string };
  }): void {
    let line = `[${this.ts(entry.timestamp)}] ${entry.status} ${entry.method} ${entry.path}` +
               ` ${entry.latencyMs}ms [${entry.email}]`;
    if (entry.usage) {
      const u = entry.usage;
      line += `  TOKENS: total=${u.totalTokens ?? "?"} input=${u.inputTokens ?? "?"}` +
              ` cached=${u.cachedInputTokens ?? 0} output=${u.outputTokens ?? "?"}` +
              ` reasoning=${u.reasoningTokens ?? 0}`;
    }
    if (entry.errorSnippet) {
      line += `  ERR: ${entry.errorSnippet.replace(/\n/g, " ").trim().slice(0, 200)}`;
    }
    if (entry.accountSwitched) {
      const sw = entry.accountSwitched;
      line += `  SWITCH: ${sw.from} → ${sw.to} [${sw.reason}]`;
    }
    this.writeLine(line);
  }

  logEvent(type: string, detail: string): void {
    this.writeLine(`[${this.ts()}] EVT  ${type.toUpperCase().padEnd(16)} ${detail}`);
  }
}
