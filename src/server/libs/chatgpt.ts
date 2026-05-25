import type { Account } from "../types";

// ─── Endpoints & version ──────────────────────────────────────────────────────
export const CHATGPT_BASE = "https://chatgpt.com";
export const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
export const CODEX_USAGE_URL = `${CHATGPT_BASE}/backend-api/wham/usage`;

const CODEX_VERSION = "0.133.0";
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_VERSION} (Mac OS; arm64)`;

// ─── Types ────────────────────────────────────────────────────────────────────
export type TokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

// ─── Rate limit & failure detection ──────────────────────────────────────────
export function isRateLimitText(text: string): boolean {
  return /usage[_-]?limit[_-]?reached|limit[_-]?reached|insufficient_quota|too_many_requests|rate[_-]?limit(ed)?|the usage limit has been reached|usage[_-]?limit|quota|usage_limit/i.test(text);
}

export function isStreamFailureBody(text: string): boolean {
  return /event:\s*(response\.failed|error)|"type"\s*:\s*"response\.failed"|"status"\s*:\s*"failed"/i.test(text);
}

// ─── Header builders ──────────────────────────────────────────────────────────
export function buildCodexHttpHeaders(account: Account, accept = "text/event-stream"): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${account.accessToken}`);
  headers.set("ChatGPT-Account-Id", account.accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("Origin", CHATGPT_BASE);
  headers.set("Referer", `${CHATGPT_BASE}/`);
  headers.set("Originator", "codex_cli_rs");
  headers.set("Version", CODEX_VERSION);
  headers.set("User-Agent", CODEX_USER_AGENT);
  headers.set("Accept", accept);
  headers.set("Content-Type", "application/json");
  headers.set("Accept-Encoding", "identity");
  headers.set("X-Oai-Web-Search-Eligible", "true");
  return headers;
}

export function buildWebSocketHeaders(
  baseHeaders: Record<string, string> | undefined,
  account: Account
): Record<string, string> {
  const headers = new Headers(baseHeaders ?? {});
  headers.set("Authorization", `Bearer ${account.accessToken}`);
  headers.set("ChatGPT-Account-Id", account.accountId);
  headers.set("chatgpt-account-id", account.accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("Origin", CHATGPT_BASE);
  headers.set("Referer", `${CHATGPT_BASE}/`);
  headers.set("Originator", "codex_cli_rs");
  headers.set("Version", CODEX_VERSION);
  headers.set("User-Agent", CODEX_USER_AGENT);
  headers.set("X-Oai-Web-Search-Eligible", "true");
  return Object.fromEntries(headers.entries());
}

// ─── Token ────────────────────────────────────────────────────────────────────
export function decodeTokenInfo(token: string): { expiresAt: string; isExpired: boolean; ageMin: number } {
  try {
    const [, payload] = token.split(".");
    if (!payload) throw new Error("no payload");
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    );
    if (!decoded.exp) return { expiresAt: "no_exp", isExpired: false, ageMin: 0 };
    const expMs = decoded.exp * 1000;
    const nowMs = Date.now();
    return {
      expiresAt: new Date(expMs).toISOString(),
      isExpired: nowMs > expMs,
      ageMin: Math.round((nowMs - expMs) / 60_000),
    };
  } catch {
    return { expiresAt: "invalid", isExpired: false, ageMin: 0 };
  }
}

// ─── SSE stream analysis ──────────────────────────────────────────────────────
function extractSseData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

export function detectStreamError(block: string): string | null {
  const eventLine = block.match(/^event:\s*(.+)$/im)?.[1]?.trim() ?? "";
  if (/^(response\.failed|error)$/i.test(eventLine)) {
    const data = extractSseData(block);
    return (data || block).replace(/\s+/g, " ").trim();
  }

  if (!/\b(error|failed|rate_limit|rate-limit|usage_limit|quota|limit_reached|too_many_requests)\b/i.test(block)) return null;

  const data = extractSseData(block);
  if (data && data !== "[DONE]") {
    try {
      const parsed = JSON.parse(data);
      const type = String(parsed.type ?? parsed.error?.type ?? "");
      const nestedError = parsed.error ?? parsed.response?.error ?? null;
      const message = nestedError?.message ?? parsed.message;
      const status = parsed.response?.status ?? parsed.status;
      const failedType = type.includes("failed") || type.includes("error");
      if (nestedError || failedType || /rate[_-]?limit/i.test(JSON.stringify(nestedError ?? ""))) {
        return JSON.stringify({ type: type || undefined, status, error: nestedError ?? message ?? parsed });
      }
      return null;
    } catch {
      // Fall through to a compact raw SSE block when upstream sends non-JSON errors.
    }
  }

  if (/event:\s*(response\.failed|error)|"type"\s*:\s*"error"/i.test(block)) {
    return block.replace(/\s+/g, " ").trim();
  }

  return null;
}

export function isSseSuccessBlock(block: string): boolean {
  return /event:\s*(response\.output_text\.delta|response\.output_text\.done|response\.completed)|"type"\s*:\s*"(response\.output_text\.delta|response\.output_text\.done|response\.completed)"/i.test(block);
}

export function detectTokenUsage(block: string): TokenUsage | null {
  const eventLine = block.match(/^event:\s*(.+)$/im)?.[1]?.trim() ?? "";
  if (eventLine !== "response.completed") return null;

  const data = extractSseData(block);
  if (!data || data === "[DONE]") return null;

  try {
    const parsed = JSON.parse(data);
    const usage = parsed.response?.usage ?? parsed.usage;
    if (!usage) return null;

    return {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
      totalTokens: usage.total_tokens,
    };
  } catch {
    return null;
  }
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────
export function compactWebSocketPayload(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
    if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
    return String(value);
  } catch {
    return "";
  }
}

export function findWebSocketLimitSnippet(value: unknown): string | null {
  const text = compactWebSocketPayload(value);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const root = parsed as Record<string, any>;
    const err = root.error && typeof root.error === "object" ? root.error : null;
    const statusCode = Number(root.status_code ?? root.status ?? err?.status_code ?? err?.status ?? 0);
    const errorType = String(err?.type ?? root.type ?? root.code ?? "");
    const message = String(err?.message ?? root.message ?? root.detail ?? "");
    const rateLimits = root.rate_limits && typeof root.rate_limits === "object" ? root.rate_limits : null;

    // If the message carries an explicit rate_limits object, trust its fields over
    // the event-type name (e.g. "codex.rate_limits" with allowed:true is just an
    // info frame, not a real quota hit).
    if (rateLimits !== null) {
      if (rateLimits.allowed === false || rateLimits.limit_reached === true) {
        return JSON.stringify(err ?? root).slice(0, 800);
      }
      return null;
    }

    if (
      statusCode === 429 ||
      isRateLimitText(errorType) ||
      (errorType === "error" && isRateLimitText(message))
    ) {
      return JSON.stringify(err ?? root).slice(0, 800);
    }
  } catch {
    if (isRateLimitText(text)) return text.replace(/\s+/g, " ").trim().slice(0, 800);
  }

  return null;
}

export function retryAfterMsFromSnippet(snippet: string): number {
  try {
    const parsed = JSON.parse(snippet);
    const retryAfter =
      parsed.retry_after_ms ??
      parsed.retryAfterMs ??
      parsed.retry_after_seconds ??
      parsed.retryAfterSeconds ??
      parsed.reset_after_seconds ??
      parsed.resetAfterSeconds;
    const value = Number(retryAfter);
    if (Number.isFinite(value) && value > 0) {
      return /seconds/i.test(JSON.stringify(parsed)) && value < 10_000 ? value * 1000 : value;
    }
  } catch {}
  return 60_000;
}

export function isWebSocketSuccessPayload(value: unknown): boolean {
  const text = compactWebSocketPayload(value);
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    const type = String(parsed.type ?? "");
    return /^(response\.output_text\.delta|response\.output_text\.done|response\.completed)$/.test(type);
  } catch {
    return /response\.output_text\.(delta|done)|response\.completed/.test(text);
  }
}

export function buildProbeMessage(originalMessage?: string | Buffer): string {
  const base = compactWebSocketPayload(originalMessage ?? "");
  try {
    const parsed = JSON.parse(base);
    delete parsed.previous_response_id;
    return JSON.stringify({
      ...parsed,
      type: "response.create",
      store: false,
      stream: true,
      instructions: "Reply OK only.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
  } catch {
    return JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      store: false,
      stream: true,
      instructions: "Reply OK only.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
    });
  }
}

export async function probeWebSocketAccount(
  upstreamUrl: string,
  baseHeaders: Record<string, string> | undefined,
  account: Account,
  originalMessage: string | Buffer | undefined
): Promise<{ ok: true } | { ok: false; error: string; limitSnippet?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; error: string; limitSnippet?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { probe.close(); } catch {}
      resolve(result);
    };

    const probe = new WebSocket(upstreamUrl, {
      // @ts-ignore — Bun extension: headers supported in WebSocket constructor
      headers: buildWebSocketHeaders(baseHeaders, account),
    });
    const timeout = setTimeout(() => finish({ ok: false, error: "probe timeout" }), 20_000);

    probe.addEventListener("open", () => {
      try {
        probe.send(buildProbeMessage(originalMessage));
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    probe.addEventListener("message", (ev) => {
      const limitSnippet = findWebSocketLimitSnippet(ev.data);
      if (limitSnippet) {
        finish({ ok: false, error: "probe limit", limitSnippet });
        return;
      }
      if (isWebSocketSuccessPayload(ev.data)) finish({ ok: true });
    });
    probe.addEventListener("close", (ev) => {
      finish({ ok: false, error: ev.reason || `probe closed ${ev.code}` });
    });
    probe.addEventListener("error", () => {
      finish({ ok: false, error: "probe websocket error" });
    });
  });
}
