import {
  getActiveAccount,
  getSwitchCandidates,
  markRateLimited,
  markExpired,
  recordRequest,
  setSelectedAccount,
} from "./accounts";
import { readAuth } from "./watcher";
import type { Account } from "./types";

// Route based on path prefix
type Route = { prefix: string; target: string; rewrite?: (pathname: string) => string };
const ROUTES: Route[] = [
  {
    prefix: "/v1/responses",
    target: "https://chatgpt.com",
    rewrite: (pathname) => pathname.replace(/^\/v1\/responses/, "/backend-api/codex/responses"),
  },
  { prefix: "/v1/", target: "https://api.openai.com" },
  { prefix: "/backend-api/", target: "https://chatgpt.com" },
];

const MAX_RETRIES = 3;
const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
const STRIP_UPSTREAM_HEADERS = [
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-ew-via",
  "cf-warp-tag-id",
  "connection",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-original-forwarded-for",
  "x-real-ip",
  "x-request-id",
  "x-request-start",
];

function resolveRoute(pathname: string): Route | null {
  for (const route of ROUTES) {
    if (pathname.startsWith(route.prefix)) return route;
  }
  return null;
}

function stripUpstreamHeaders(headers: Headers) {
  for (const name of STRIP_UPSTREAM_HEADERS) headers.delete(name);
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("cf-")) headers.delete(name);
  }
}

function isLimitErrorText(text: string): boolean {
  return /rate[_-]?limit|limit[_-]?reached|usage[_-]?limit|quota|insufficient_quota|usage_limit|too_many_requests/i.test(text);
}

function isStreamFailureBody(text: string): boolean {
  return /event:\s*(response\.failed|error)|"type"\s*:\s*"response\.failed"|"status"\s*:\s*"failed"/i.test(text);
}

function codexHeadersForAccount(account: Account, accept = "text/event-stream"): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${account.accessToken}`);
  headers.set("ChatGPT-Account-Id", account.accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("Origin", "https://chatgpt.com");
  headers.set("Referer", "https://chatgpt.com/");
  headers.set("Originator", "codex_cli_rs");
  headers.set("Version", "0.133.0");
  headers.set("User-Agent", "codex_cli_rs/0.133.0 (Mac OS; arm64)");
  headers.set("Accept", accept);
  headers.set("Content-Type", "application/json");
  headers.set("Accept-Encoding", "identity");
  headers.set("X-Oai-Web-Search-Eligible", "true");
  return headers;
}

// Decode JWT exp field for diagnostics — no crypto needed, just base64
function tokenInfo(token: string): { expiresAt: string; isExpired: boolean; ageMin: number } {
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
      ageMin: Math.round((nowMs - expMs) / 60_000), // positive = expired N min ago
    };
  } catch {
    return { expiresAt: "invalid", isExpired: false, ageMin: 0 };
  }
}

// Metadata attached to every proxied request — used by index.ts for SSE + file logs
export type ProxyMeta = {
  email: string;
  errorSnippet?: string;
  accountSwitched?: { from: string; to: string; reason: "rate_limit" | "expired" };
  accountSwitchBroadcasted?: boolean;
};

export type StreamErrorEvent = {
  email: string;
  status: number;
  errorSnippet: string;
};

export type TokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type StreamUsageEvent = {
  email: string;
  status: number;
  usage: TokenUsage;
};

export type AccountSwitchEvent = {
  from: string;
  to: string;
  reason: "rate_limit" | "expired";
};

type StreamErrorCallback = (event: StreamErrorEvent) => void;
type StreamUsageCallback = (event: StreamUsageEvent) => void;
type AccountSwitchCallback = (event: AccountSwitchEvent) => void;

function extractSseData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
}

function detectStreamError(block: string): string | null {
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

function isSseSuccessBlock(block: string): boolean {
  return /event:\s*(response\.output_text\.delta|response\.output_text\.done|response\.completed)|"type"\s*:\s*"(response\.output_text\.delta|response\.output_text\.done|response\.completed)"/i.test(block);
}

function detectTokenUsage(block: string): TokenUsage | null {
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

async function probeAccount(account: Account): Promise<{ ok: boolean; error?: string; status?: number }> {
  const body = JSON.stringify({
    model: "gpt-5.5",
    store: false,
    stream: true,
    instructions: "Reply with OK only.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
  });

  try {
    const res = await fetch(`https://chatgpt.com${CODEX_RESPONSES_PATH}`, {
      method: "POST",
      headers: codexHeadersForAccount(account),
      body,
    });
    const text = await res.text();

    if (res.status === 401) {
      markExpired(account.id);
      return { ok: false, status: res.status, error: "probe 401" };
    }

    if (res.status === 429) {
      const retryAfterMs = parseInt(res.headers.get("retry-after") ?? "60") * 1000;
      markRateLimited(account.id, retryAfterMs);
      return { ok: false, status: res.status, error: "probe 429" };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 200) || `probe HTTP ${res.status}` };
    }

    if (isStreamFailureBody(text)) {
      if (isLimitErrorText(text)) markRateLimited(account.id);
      return { ok: false, status: res.status, error: text.slice(0, 200) || "probe stream failed" };
    }

    if (!/event:\s*response\.completed|"type"\s*:\s*"response\.completed"/i.test(text)) {
      return { ok: false, status: res.status, error: "probe did not complete" };
    }

    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function findVerifiedSwitchAccount(excludeAccountId: string): Promise<Account | null> {
  for (const candidate of getSwitchCandidates(excludeAccountId)) {
    console.log(`[proxy] probing switch candidate: ${candidate.email}`);
    const probe = await probeAccount(candidate);
    if (probe.ok) {
      setSelectedAccount(candidate.id);
      console.log(`[proxy] probe OK, switching to ${candidate.email}`);
      return candidate;
    }
    console.warn(
      `[proxy] probe failed for ${candidate.email}: ${probe.status ?? "no_status"} ${probe.error ?? ""}`
    );
  }
  return null;
}

function retryAfterMs(headers: Headers, fallbackMs = 60_000): number {
  const raw = headers.get("retry-after");
  if (!raw) return fallbackMs;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  return fallbackMs;
}

async function retryWithSwitchedAccount(
  req: Request,
  body: ArrayBuffer | null,
  meta: ProxyMeta,
  account: Account,
  reason: "rate_limit" | "expired",
  retries: number,
  onStreamError?: StreamErrorCallback,
  onStreamUsage?: StreamUsageCallback,
  onAccountSwitch?: AccountSwitchCallback
): Promise<Response | null> {
  if (retries >= MAX_RETRIES) return null;

  const nextAccount = await findVerifiedSwitchAccount(account.id);
  if (!nextAccount || nextAccount.id === account.id) return null;

  const label = reason === "rate_limit" ? "Rate limited" : "Token expired (401)";
  console.log(
    `[proxy] ${label} on ${account.email} → switching to ${nextAccount.email} (retry ${retries + 1}/${MAX_RETRIES})`
  );
  meta.accountSwitched = { from: account.email, to: nextAccount.email, reason };
  meta.accountSwitchBroadcasted = true;
  onAccountSwitch?.(meta.accountSwitched);

  const retryReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: body ?? undefined,
  });
  return proxyRequestInner(retryReq, meta, onStreamError, onStreamUsage, onAccountSwitch, retries + 1);
}

function replayStream(
  bufferedChunks: Uint8Array[],
  reader: any,
  upstreamDone: boolean
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < bufferedChunks.length) {
        controller.enqueue(bufferedChunks[index++]);
        return;
      }

      if (upstreamDone) {
        controller.close();
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function preflightCodexStream(
  body: ReadableStream<Uint8Array> | null,
  account: Account
): Promise<
  | { kind: "body"; body: ReadableStream<Uint8Array> | null }
  | { kind: "limit_error"; snippet: string }
> {
  if (!body) return { kind: "body", body };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: Uint8Array[] = [];
  let buffer = "";
  let upstreamDone = false;
  let blockCount = 0;
  const deadline = Date.now() + 1500;

  while (Date.now() < deadline && bufferedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) < 64_000) {
    const { done, value } = await reader.read();
    if (done) {
      upstreamDone = true;
      break;
    }

    bufferedChunks.push(value);
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      blockCount++;
      const snippet = detectStreamError(block);
      if (snippet && isLimitErrorText(snippet)) {
        markRateLimited(account.id);
        await reader.cancel().catch(() => {});
        return { kind: "limit_error", snippet: snippet.slice(0, 800) };
      }
      if (snippet || isSseSuccessBlock(block) || blockCount >= 12) {
        return { kind: "body", body: replayStream(bufferedChunks, reader, upstreamDone) };
      }
    }
  }

  return { kind: "body", body: replayStream(bufferedChunks, reader, upstreamDone) };
}

function streamWithErrorTap(
  body: ReadableStream<Uint8Array> | null,
  account: Account,
  status: number,
  onStreamError?: StreamErrorCallback,
  onStreamUsage?: StreamUsageCallback
): ReadableStream<Uint8Array> | null {
  if (!body || (!onStreamError && !onStreamUsage)) return body;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reportedError = false;
  let reportedUsage = false;
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (closed) return;
        const { done, value } = await reader.read();
        if (done) {
          if (buffer && !reportedError && onStreamError) {
            const snippet = detectStreamError(buffer);
            if (snippet) {
              reportedError = true;
              if (isLimitErrorText(snippet)) markRateLimited(account.id);
              onStreamError({ email: account.email, status, errorSnippet: snippet.slice(0, 800) });
            }
          }
          if (buffer && !reportedUsage && onStreamUsage) {
            const usage = detectTokenUsage(buffer);
            if (usage) {
              reportedUsage = true;
              onStreamUsage({ email: account.email, status, usage });
            }
          }
          closed = true;
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";

        if ((!reportedError && onStreamError) || (!reportedUsage && onStreamUsage)) {
          for (const block of blocks) {
            if (!reportedError && onStreamError) {
              const snippet = detectStreamError(block);
              if (snippet) {
                reportedError = true;
                if (isLimitErrorText(snippet)) markRateLimited(account.id);
                onStreamError({ email: account.email, status, errorSnippet: snippet.slice(0, 800) });
              }
            }

            if (!reportedUsage && onStreamUsage) {
              const usage = detectTokenUsage(block);
              if (usage) {
                reportedUsage = true;
                onStreamUsage({ email: account.email, status, usage });
              }
            }

            if (reportedError && reportedUsage) {
              break;
            }
          }
        }

        if (buffer.length > 64_000) buffer = buffer.slice(-16_000);
        try {
          controller.enqueue(value);
        } catch {
          closed = true;
          await reader.cancel().catch(() => {});
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (closed || /controller is already closed|invalid state/i.test(msg)) return;
        if (!reportedError && onStreamError) {
          reportedError = true;
          onStreamError({
            email: account.email,
            status,
            errorSnippet: `Stream read error: ${msg}`,
          });
        }
        controller.error(error);
      }
    },
    cancel(reason) {
      closed = true;
      return reader.cancel(reason);
    },
  });
}

async function proxyRequestInner(
  req: Request,
  meta: ProxyMeta,
  onStreamError?: StreamErrorCallback,
  onStreamUsage?: StreamUsageCallback,
  onAccountSwitch?: AccountSwitchCallback,
  retries = 0
): Promise<Response> {
  const account = getActiveAccount();
  if (!account) {
    return new Response(
      JSON.stringify({
        error: { message: "No active account. Login to Codex to add one.", type: "proxy_error" },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  meta.email = account.email;

  const url = new URL(req.url);
  const route = resolveRoute(url.pathname);
  if (!route) return new Response("Not found", { status: 404 });

  const targetPath = route.rewrite ? route.rewrite(url.pathname) : url.pathname;
  const targetUrl = route.target + targetPath + url.search;

  // ── Replace Authorization with the active account's REAL credential ──────
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${account.accessToken}`);
  if (targetPath.startsWith("/backend-api/codex/")) {
    headers.set("ChatGPT-Account-Id", account.accountId);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("Origin", "https://chatgpt.com");
    headers.set("Referer", "https://chatgpt.com/");
    headers.set("Originator", "codex_cli_rs");
    headers.set("Version", "0.133.0");
    headers.set("User-Agent", "codex_cli_rs/0.133.0 (Mac OS; arm64)");
    headers.set("Accept", "text/event-stream");
    headers.set("X-Oai-Web-Search-Eligible", "true");
  }
  headers.set("Accept-Encoding", "identity");
  stripUpstreamHeaders(headers);

  let body: ArrayBuffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  // ── Log outgoing request ─────────────────────────────────────────────────
  const tokenSnippet = account.accessToken.slice(-12);
  console.log(`\n[proxy →] ${req.method} ${targetUrl}`);
  console.log(`  account : ${account.email}`);
  console.log(`  token   : ...${tokenSnippet}`);
  console.log(`  req-headers:`);
  for (const [k, v] of headers.entries()) {
    const val = k.toLowerCase() === "authorization" ? `Bearer ...${v.slice(-12)}` : v;
    console.log(`    ${k}: ${val}`);
  }
  if (body && body.byteLength > 0) {
    const bodySnippet = new TextDecoder().decode(body.slice(0, 500));
    console.log(`  body[0:500]: ${bodySnippet}`);
  }

  const start = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: `Proxy upstream error: ${e}`, type: "proxy_error" } }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  const latencyMs = Date.now() - start;
  console.log(`[proxy ←] ${upstream.status} (${latencyMs}ms)`);
  console.log(`  res-headers:`);
  for (const [k, v] of upstream.headers.entries()) {
    console.log(`    ${k}: ${v}`);
  }

  // ── Handle expired tokens and quota errors with automatic account failover ─
  if (upstream.status === 401 || upstream.status === 429) {
    let errorText = "";
    try { errorText = await upstream.text(); } catch {}
    meta.errorSnippet = (errorText || `HTTP ${upstream.status} ${upstream.statusText}`).slice(0, 400);

    const reason: "rate_limit" | "expired" = upstream.status === 429 ? "rate_limit" : "expired";

    if (upstream.status === 401) {
      // ── Diagnostic: decode token to understand why 401 happened ───────────
      const info = tokenInfo(account.accessToken);
      console.error(`[proxy] 401 on ${account.email}`);
      console.error(`  token_exp : ${info.expiresAt}`);
      console.error(`  is_expired: ${info.isExpired}${info.isExpired ? ` (${info.ageMin}m ago)` : ""}`);
      console.error(`  401 body  : ${errorText}`);

      // ── Try reading a fresher token straight from auth.json ───────────────
      // Race condition: Codex may have refreshed its token milliseconds ago
      // but the watcher hasn't fired yet. Check auth.json directly.
      if (retries === 0) {
        const freshAuth = readAuth();
        const freshToken = freshAuth?.tokens?.access_token;
        if (freshToken && freshToken !== account.accessToken) {
          console.log(`[proxy] auth.json has a fresher token — using it directly`);
          const { importFromTokens } = await import("./accounts");
          importFromTokens(freshAuth!.tokens); // update DB
          const retryReq = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: body ?? undefined,
          });
          return proxyRequestInner(retryReq, meta, onStreamError, onStreamUsage, onAccountSwitch, retries + 1);
        }
      }

      markExpired(account.id);
    } else {
      markRateLimited(account.id, retryAfterMs(upstream.headers));
    }

    const switched = await retryWithSwitchedAccount(
      req,
      body,
      meta,
      account,
      reason,
      retries,
      onStreamError,
      onStreamUsage,
      onAccountSwitch
    );
    if (switched) return switched;

    // Max retries exhausted
    const errHeaders = new Headers(upstream.headers);
    errHeaders.delete("content-encoding");
    return new Response(errorText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: errHeaders,
    });
  }

  // ── Other 4xx/5xx: capture snippet for log ────────────────────────────────
  if (upstream.status >= 400) {
    try {
      const text = await upstream.clone().text();
      meta.errorSnippet = (text || `HTTP ${upstream.status} ${upstream.statusText}`).slice(0, 400);
      if (isLimitErrorText(text)) {
        markRateLimited(account.id, retryAfterMs(upstream.headers));
        const switched = await retryWithSwitchedAccount(
          req,
          body,
          meta,
          account,
          "rate_limit",
          retries,
          onStreamError,
          onStreamUsage,
          onAccountSwitch
        );
        if (switched) return switched;
      }
    } catch {
      meta.errorSnippet = `HTTP ${upstream.status} ${upstream.statusText}`;
    }
  }

  if (upstream.status < 400) recordRequest(account.id);

  // ── Stream response back ──────────────────────────────────────────────────
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  let responseBody = upstream.body;
  if (targetPath.startsWith(CODEX_RESPONSES_PATH)) {
    const preflight = await preflightCodexStream(upstream.body, account);
    if (preflight.kind === "limit_error") {
      meta.errorSnippet = preflight.snippet;
      const switched = await retryWithSwitchedAccount(
        req,
        body,
        meta,
        account,
        "rate_limit",
        retries,
        onStreamError,
        onStreamUsage,
        onAccountSwitch
      );
      if (switched) return switched;

      return new Response(
        JSON.stringify({ error: { message: preflight.snippet, type: "proxy_error" } }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    responseBody = preflight.body as typeof responseBody;
  }

  const bodyWithErrorTap = streamWithErrorTap(
    responseBody,
    account,
    upstream.status,
    onStreamError,
    onStreamUsage
  );
  return new Response(bodyWithErrorTap, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

// Public API — returns Response + rich metadata for SSE and file logging
export async function proxyRequest(
  req: Request,
  onStreamError?: StreamErrorCallback,
  onStreamUsage?: StreamUsageCallback,
  onAccountSwitch?: AccountSwitchCallback
): Promise<{ response: Response; meta: ProxyMeta }> {
  const meta: ProxyMeta = { email: "" };
  const response = await proxyRequestInner(req, meta, onStreamError, onStreamUsage, onAccountSwitch);
  return { response, meta };
}

// Build data needed to proxy a WebSocket upgrade request
export function buildWebSocketProxyData(req: Request): {
  upstreamUrl: string;
  headers: Record<string, string>;
  email: string;
  accountId: string;
} | null {
  const account = getActiveAccount();
  if (!account) return null;

  const url = new URL(req.url);
  const route = resolveRoute(url.pathname);
  if (!route) return null;

  const targetPath = route.rewrite ? route.rewrite(url.pathname) : url.pathname;
  const wsTarget = route.target.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  const upstreamUrl = wsTarget + targetPath + url.search;

  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${account.accessToken}`);
  if (targetPath.startsWith("/backend-api/codex/")) {
    headers.set("ChatGPT-Account-Id", account.accountId);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("Origin", "https://chatgpt.com");
    headers.set("Referer", "https://chatgpt.com/");
    headers.set("Originator", "codex_cli_rs");
    headers.set("Version", "0.133.0");
    headers.set("User-Agent", "codex_cli_rs/0.133.0 (Mac OS; arm64)");
    headers.set("X-Oai-Web-Search-Eligible", "true");
  }
  stripUpstreamHeaders(headers);
  if (account.accountId) headers.set("chatgpt-account-id", account.accountId);

  console.log(`\n[ws →] ${url.pathname} [${account.email}]`);
  console.log(`  upstream: ${upstreamUrl}`);
  console.log(`  token   : ...${account.accessToken.slice(-12)}`);

  return {
    upstreamUrl,
    headers: Object.fromEntries(headers.entries()),
    email: account.email,
    accountId: account.id,
  };
}
