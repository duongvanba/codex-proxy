import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const LOG_DIR = join(import.meta.dir, "..", "logs");
const LOG_FILE = join(LOG_DIR, "requests.log");

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function ts(ms = Date.now()) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 23);
}

function writeLine(line: string) {
  try {
    ensureLogDir();
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // log failures should never crash the proxy
  }
}

// ── Request log ───────────────────────────────────────────────────────────────
export function logRequest(entry: {
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
}) {
  let line = `[${ts(entry.timestamp)}] ${entry.status} ${entry.method} ${entry.path}` +
             ` ${entry.latencyMs}ms [${entry.email}]`;
  if (entry.usage) {
    const u = entry.usage;
    line += `  TOKENS: total=${u.totalTokens ?? "?"} input=${u.inputTokens ?? "?"}` +
            ` cached=${u.cachedInputTokens ?? 0} output=${u.outputTokens ?? "?"}` +
            ` reasoning=${u.reasoningTokens ?? 0}`;
  }
  if (entry.errorSnippet) {
    const snippet = entry.errorSnippet.replace(/\n/g, " ").trim().slice(0, 200);
    line += `  ERR: ${snippet}`;
  }
  if (entry.accountSwitched) {
    const sw = entry.accountSwitched;
    line += `  SWITCH: ${sw.from} → ${sw.to} [${sw.reason}]`;
  }
  writeLine(line);
}

// ── System / account events ───────────────────────────────────────────────────
export function logEvent(type: string, detail: string) {
  writeLine(`[${ts()}] EVT  ${type.toUpperCase().padEnd(16)} ${detail}`);
}
