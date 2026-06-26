import type { Account } from "../../schemas";
import type { TokenUsage } from "../../schemas/chatgpt";
export type { TokenUsage };

// ─── Constants ────────────────────────────────────────────────────────────────

export const CHATGPT_BASE = "https://chatgpt.com";
export const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
export const CODEX_USAGE_URL = `${CHATGPT_BASE}/backend-api/wham/usage`;

const CLIENT_VERSION = "0.133.0";
const CLIENT_UA = `codex_cli_rs/${CLIENT_VERSION} (Mac OS; arm64)`;

// ─── ChatGPTClient ────────────────────────────────────────────────────────────

export class ChatGPTClient {
  constructor(private readonly account: Account) {}

  // ─── Header builders ────────────────────────────────────────────────────────

  httpHeaders(accept = "text/event-stream"): Headers {
    const h = new Headers();
    h.set("Authorization", `Bearer ${this.account.accessToken}`);
    h.set("ChatGPT-Account-Id", this.account.accountId);
    h.set("OpenAI-Beta", "responses=experimental");
    h.set("Origin", CHATGPT_BASE);
    h.set("Referer", `${CHATGPT_BASE}/`);
    h.set("Originator", "codex_cli_rs");
    h.set("Version", CLIENT_VERSION);
    h.set("User-Agent", CLIENT_UA);
    h.set("Accept", accept);
    h.set("Content-Type", "application/json");
    h.set("Accept-Encoding", "identity");
    h.set("X-Oai-Web-Search-Eligible", "true");
    return h;
  }

  wsHeaders(base?: Record<string, string>): Record<string, string> {
    const h = new Headers(base ?? {});
    h.set("Authorization", `Bearer ${this.account.accessToken}`);
    h.set("ChatGPT-Account-Id", this.account.accountId);
    h.set("chatgpt-account-id", this.account.accountId);
    h.set("OpenAI-Beta", "responses=experimental");
    h.set("Origin", CHATGPT_BASE);
    h.set("Referer", `${CHATGPT_BASE}/`);
    h.set("Originator", "codex_cli_rs");
    h.set("Version", CLIENT_VERSION);
    h.set("User-Agent", CLIENT_UA);
    h.set("X-Oai-Web-Search-Eligible", "true");
    return Object.fromEntries(h.entries());
  }

  // ─── WebSocket probe ─────────────────────────────────────────────────────────

  probe(
    upstreamUrl: string,
    base: Record<string, string> | undefined,
    original?: string | Buffer
  ): Promise<{ ok: true } | { ok: false; error: string; limitSnippet?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: true } | { ok: false; error: string; limitSnippet?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(result);
      };

      const ws = new WebSocket(upstreamUrl, {
        // @ts-ignore — Bun extension
        headers: this.wsHeaders(base),
      });
      const timeout = setTimeout(() => finish({ ok: false, error: "probe timeout" }), 20_000);

      ws.addEventListener("open", () => {
        try {
          ws.send(ChatGPTClient.buildProbeMessage(original));
        } catch (e) {
          finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      });
      ws.addEventListener("message", (ev) => {
        const limitSnippet = ChatGPTClient.findLimitSnippet(ev.data);
        if (limitSnippet) { finish({ ok: false, error: "probe limit", limitSnippet }); return; }
        if (ChatGPTClient.isSuccessPayload(ev.data)) finish({ ok: true });
      });
      ws.addEventListener("close", (ev) => {
        finish({ ok: false, error: ev.reason || `probe closed ${ev.code}` });
      });
      ws.addEventListener("error", () => {
        finish({ ok: false, error: "probe websocket error" });
      });
    });
  }

  // ─── Static: rate limit & failure detection ──────────────────────────────────

  static isRateLimit(text: string): boolean {
    return /usage[_-]?limit[_-]?reached|limit[_-]?reached|insufficient_quota|too_many_requests|rate[_-]?limit(ed)?|the usage limit has been reached|usage[_-]?limit|quota|usage_limit/i.test(text);
  }

  static isStreamFailure(text: string): boolean {
    return /event:\s*(response\.failed|error)|"type"\s*:\s*"response\.failed"|"status"\s*:\s*"failed"/i.test(text);
  }

  // ─── Static: SSE stream analysis ─────────────────────────────────────────────

  private static extractSseData(block: string): string {
    return block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
  }

  static detectError(block: string): string | null {
    const eventLine = block.match(/^event:\s*(.+)$/im)?.[1]?.trim() ?? "";
    if (/^(response\.failed|error)$/i.test(eventLine)) {
      const data = ChatGPTClient.extractSseData(block);
      return (data || block).replace(/\s+/g, " ").trim();
    }
    if (!/\b(error|failed|rate_limit|rate-limit|usage_limit|quota|limit_reached|too_many_requests)\b/i.test(block)) return null;
    const data = ChatGPTClient.extractSseData(block);
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
      } catch {}
    }
    if (/event:\s*(response\.failed|error)|"type"\s*:\s*"error"/i.test(block)) {
      return block.replace(/\s+/g, " ").trim();
    }
    return null;
  }

  static isSuccessBlock(block: string): boolean {
    return /event:\s*(response\.output_text\.delta|response\.output_text\.done|response\.completed)|"type"\s*:\s*"(response\.output_text\.delta|response\.output_text\.done|response\.completed)"/i.test(block);
  }

  static detectTokenUsage(block: string): TokenUsage | null {
    const eventLine = block.match(/^event:\s*(.+)$/im)?.[1]?.trim() ?? "";
    if (eventLine !== "response.completed") return null;
    const data = ChatGPTClient.extractSseData(block);
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
    } catch { return null; }
  }

  // ─── Static: WebSocket helpers ───────────────────────────────────────────────

  static compactPayload(value: unknown): string {
    try {
      if (typeof value === "string") return value;
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
      return String(value);
    } catch { return ""; }
  }

  static findLimitSnippet(value: unknown): string | null {
    const text = ChatGPTClient.compactPayload(value);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as Record<string, any>;
      const err = parsed.error && typeof parsed.error === "object" ? parsed.error : null;
      const statusCode = Number(parsed.status_code ?? parsed.status ?? err?.status_code ?? err?.status ?? 0);
      const errorType = String(err?.type ?? parsed.type ?? parsed.code ?? "");
      const message = String(err?.message ?? parsed.message ?? parsed.detail ?? "");
      const rateLimits = parsed.rate_limits && typeof parsed.rate_limits === "object" ? parsed.rate_limits : null;
      if (rateLimits !== null) {
        if (rateLimits.allowed === false || rateLimits.limit_reached === true)
          return JSON.stringify(err ?? parsed).slice(0, 800);
        return null;
      }
      if (statusCode === 429 || ChatGPTClient.isRateLimit(errorType) || (errorType === "error" && ChatGPTClient.isRateLimit(message)))
        return JSON.stringify(err ?? parsed).slice(0, 800);
    } catch {
      if (ChatGPTClient.isRateLimit(text)) return text.replace(/\s+/g, " ").trim().slice(0, 800);
    }
    return null;
  }

  static retryAfterMs(snippet: string): number {
    try {
      const parsed = JSON.parse(snippet);
      const retryAfter = parsed.retry_after_ms ?? parsed.retryAfterMs ?? parsed.retry_after_seconds ?? parsed.retryAfterSeconds ?? parsed.reset_after_seconds ?? parsed.resetAfterSeconds;
      const value = Number(retryAfter);
      if (Number.isFinite(value) && value > 0)
        return /seconds/i.test(JSON.stringify(parsed)) && value < 10_000 ? value * 1000 : value;
    } catch {}
    return 60_000;
  }

  static isSuccessPayload(value: unknown): boolean {
    const text = ChatGPTClient.compactPayload(value);
    if (!text) return false;
    try {
      const parsed = JSON.parse(text);
      const type = String(parsed.type ?? "");
      return /^(response\.output_text\.delta|response\.output_text\.done|response\.completed)$/.test(type);
    } catch {
      return /response\.output_text\.(delta|done)|response\.completed/.test(text);
    }
  }

  static buildProbeMessage(original?: string | Buffer): string {
    const base = ChatGPTClient.compactPayload(original ?? "");
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

  static decodeToken(token: string): { expiresAt: string; isExpired: boolean; ageMin: number } {
    try {
      const [, payload] = token.split(".");
      if (!payload) throw new Error("no payload");
      const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      if (!decoded.exp) return { expiresAt: "no_exp", isExpired: false, ageMin: 0 };
      const expMs = decoded.exp * 1000;
      const nowMs = Date.now();
      return { expiresAt: new Date(expMs).toISOString(), isExpired: nowMs > expMs, ageMin: Math.round((nowMs - expMs) / 60_000) };
    } catch { return { expiresAt: "invalid", isExpired: false, ageMin: 0 }; }
  }

  // ─── Static: factories & external communication ──────────────────────────────

  static buildCodexHttpHeaders(account: Account, accept?: string): Headers {
    return new ChatGPTClient(account).httpHeaders(accept);
  }

  static buildWebSocketHeaders(base: Record<string, string> | undefined, account: Account): Record<string, string> {
    return new ChatGPTClient(account).wsHeaders(base);
  }

  static probeWebSocketAccount(
    upstreamUrl: string,
    base: Record<string, string> | undefined,
    account: Account,
    original?: string | Buffer
  ): Promise<{ ok: true } | { ok: false; error: string; limitSnippet?: string }> {
    return new ChatGPTClient(account).probe(upstreamUrl, base, original);
  }

  /** Open the Codex responses SSE stream for an account. Returns the raw upstream Response. */
  static openResponsesStream(account: Account, body: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${CHATGPT_BASE}${CODEX_RESPONSES_PATH}`, {
      method: "POST",
      headers: new ChatGPTClient(account).httpHeaders("text/event-stream"),
      body,
      signal,
    });
  }

  /** Fetch the ChatGPT/Codex usage endpoint for an access token. Returns the raw Response. */
  static fetchUsage(accessToken: string, signal?: AbortSignal): Promise<Response> {
    return fetch(CODEX_USAGE_URL, {
      signal,
      headers: {
        accept: "*/*",
        authorization: `Bearer ${accessToken}`,
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://chatgpt.com/codex/cloud/settings/analytics",
        "x-openai-target-path": "/backend-api/wham/usage",
        "x-openai-target-route": "/backend-api/wham/usage",
        "user-agent": "Mozilla/5.0",
      },
    });
  }

  static fetchRateLimitResetCredits(account: Account, signal?: AbortSignal): Promise<Response> {
    return fetch(`${CHATGPT_BASE}/backend-api/wham/rate-limit-reset-credits`, {
      signal,
      headers: new ChatGPTClient(account).httpHeaders("application/json"),
    });
  }

  static consumeRateLimitResetCredit(
    account: Account,
    creditId: string,
    redeemRequestId: string,
    signal?: AbortSignal
  ): Promise<Response> {
    return fetch(`${CHATGPT_BASE}/backend-api/wham/rate-limit-reset-credits/consume`, {
      method: "POST",
      signal,
      headers: new ChatGPTClient(account).httpHeaders("application/json"),
      body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
    });
  }

  /** Fetch /backend-api/invoices to get subscription billing info. Returns the raw Response. */
  static fetchInvoices(accessToken: string, accountId: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${CHATGPT_BASE}/backend-api/invoices?limit=4&account_id=${accountId}`, {
      signal,
      headers: {
        accept: "*/*",
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "cache-control": "no-cache",
        pragma: "no-cache",
        origin: CHATGPT_BASE,
        referer: `${CHATGPT_BASE}/`,
        "user-agent": CLIENT_UA,
        "x-openai-target-path": "/backend-api/invoices",
        "x-openai-target-route": "/backend-api/invoices",
      },
    });
  }
}
