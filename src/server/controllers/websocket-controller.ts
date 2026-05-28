import {
  getAccounts,
  isUsableAccount,
  markRateLimited,
  recordRequest,
  setSelectedAccount,
} from "../services/accounts";
import { broadcastLog } from "../services/broadcast";
import { logRequest, logEvent } from "../services/logger";
import { notifyAccountsChanged } from "../services/livequery";
import {
  buildWebSocketHeaders,
  findWebSocketLimitSnippet,
  probeWebSocketAccount,
  retryAfterMsFromSnippet,
} from "../libs/chatgpt";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

// ─── WsData ───────────────────────────────────────────────────────────────────
export interface WsData {
  kind?: "codex" | "livequery";
  upstreamUrl?: string;
  headers?: Record<string, string>;
  email?: string;
  accountId?: string;
  upstream?: WebSocket;
  firstMessage?: string | Buffer;
  isNewPrompt?: boolean;
  limitReported?: boolean;
  switchingAccount?: boolean;
  suppressNextClose?: boolean;
  switchAttemptedAccountIds?: Set<string>;
  livequeryClientId?: string;
  livequeryRefs?: Set<string>;
}

const WS_RESPONSE_LOG_FILE = join(import.meta.dir, "../../../logs", "websocket-responses.ndjson");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeWebSocketResponseLog(entry: Record<string, unknown>) {
  try {
    mkdirSync(join(import.meta.dir, "../../../logs"), { recursive: true });
    appendFileSync(WS_RESPONSE_LOG_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // diagnostic only
  }
}

export function serializeWebSocketPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { payloadType: "text", payload: value, byteLength: new TextEncoder().encode(value).byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { payloadType: "binary", payloadBase64: Buffer.from(value).toString("base64"), byteLength: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return { payloadType: "binary", payloadBase64: bytes.toString("base64"), byteLength: value.byteLength };
  }
  const payload = String(value);
  return { payloadType: "text", payload, byteLength: new TextEncoder().encode(payload).byteLength };
}

function logWebSocketUpstreamResponse(ws: { data: WsData }, payload: unknown, latencyMs: number) {
  writeWebSocketResponseLog({
    type: "ws_upstream_message",
    timestamp: Date.now(),
    email: ws.data.email ?? "",
    accountId: ws.data.accountId ?? "",
    upstreamUrl: ws.data.upstreamUrl ?? "",
    latencyMs,
    ...serializeWebSocketPayload(payload),
  });
}

function logWebSocketUpstreamClose(ws: { data: WsData }, code: number, reason: string, latencyMs: number) {
  writeWebSocketResponseLog({
    type: "ws_upstream_close",
    timestamp: Date.now(),
    email: ws.data.email ?? "",
    accountId: ws.data.accountId ?? "",
    upstreamUrl: ws.data.upstreamUrl ?? "",
    code,
    reason,
    latencyMs,
  });
}

function reportWebSocketLimit(ws: { data: WsData }, snippet: string, latencyMs: number) {
  if (ws.data.limitReported || !ws.data.accountId) return;
  ws.data.limitReported = true;
  const retryAfterMs = retryAfterMsFromSnippet(snippet);
  markRateLimited(ws.data.accountId, retryAfterMs);
  const entry = {
    type: "ws_limit",
    timestamp: Date.now(),
    email: ws.data.email,
    status: 429,
    latencyMs,
    errorSnippet: snippet,
  };
  console.warn(`[ws] limit detected [${ws.data.email}] ${snippet.slice(0, 200)}`);
  broadcastLog(entry);
  logRequest({
    timestamp: entry.timestamp,
    method: "WS",
    path: ws.data.upstreamUrl ? new URL(ws.data.upstreamUrl).pathname : "/v1/responses",
    status: 429,
    latencyMs,
    email: ws.data.email ?? "",
    errorSnippet: snippet,
  });
  notifyAccountsChanged();
}

function getWebSocketSwitchCandidates(ws: { data: WsData }) {
  const attempted = ws.data.switchAttemptedAccountIds ?? new Set<string>();
  const currentId = ws.data.accountId;
  return getAccounts().filter((account) =>
    account.id !== currentId &&
    !attempted.has(account.id) &&
    isUsableAccount(account) &&
    Boolean(account.accessToken && account.accountId)
  );
}

function sendWebSocketProxyError(ws: { send(data: string): void; close(code?: number, reason?: string): void }, message: string) {
  try {
    ws.send(JSON.stringify({ type: "error", error: { type: "proxy_error", message }, status_code: 429 }));
  } catch {}
  try { ws.close(1013, "no switchable account"); } catch {}
}

async function handleWebSocketLimit(
  ws: { send(data: string | ArrayBuffer): void; close(code?: number, reason?: string): void; data: WsData },
  snippet: string,
  latencyMs: number
) {
  reportWebSocketLimit(ws, snippet, latencyMs);
  if (ws.data.switchingAccount) return;
  ws.data.switchingAccount = true;
  ws.data.switchAttemptedAccountIds ??= new Set<string>();
  if (ws.data.accountId) ws.data.switchAttemptedAccountIds.add(ws.data.accountId);

  try {
    ws.data.suppressNextClose = true;
    try { ws.data.upstream?.close(1000, "switching account"); } catch {}
    ws.data.upstream = undefined;

    const upstreamUrl = ws.data.upstreamUrl;
    if (!upstreamUrl) { sendWebSocketProxyError(ws, "Cannot switch account for this request."); return; }

    for (const candidate of getWebSocketSwitchCandidates(ws)) {
      ws.data.switchAttemptedAccountIds.add(candidate.id);
      console.log(`[ws] probing switch candidate: ${candidate.email}`);
      const probe = await probeWebSocketAccount(upstreamUrl, ws.data.headers, candidate, ws.data.firstMessage);
      if (!probe.ok) {
        console.warn(`[ws] probe failed for ${candidate.email}: ${probe.error}`);
        if (probe.limitSnippet) markRateLimited(candidate.id, retryAfterMsFromSnippet(probe.limitSnippet));
        notifyAccountsChanged();
        continue;
      }
      const from = ws.data.email ?? "";
      setSelectedAccount(candidate.id);
      ws.data.email = candidate.email;
      ws.data.accountId = candidate.id;
      ws.data.headers = buildWebSocketHeaders(ws.data.headers, candidate);
      ws.data.limitReported = false;
      ws.data.switchingAccount = false;
      logEvent("account_switched", `${from} → ${candidate.email} [rate_limit]`);
      broadcastLog({ type: "account_switched", from, to: candidate.email, reason: "rate_limit", timestamp: Date.now() });
      notifyAccountsChanged();
      try {
        ws.send(JSON.stringify({
          type: "response.failed",
          response: { status: "failed", error: { code: "connection_reset", message: "Upstream account switched, please retry." } },
        }));
      } catch {}
      return;
    }
    sendWebSocketProxyError(ws, "All candidate accounts are limited or failed the WebSocket probe.");
  } finally {
    ws.data.switchingAccount = false;
  }
}

function openCodexUpstream(
  ws: { send(data: string | ArrayBuffer): void; close(code?: number, reason?: string): void; data: WsData },
  message: string | Buffer
) {
  const upstream = new WebSocket(ws.data.upstreamUrl!, {
    // @ts-ignore — Bun extension
    headers: ws.data.headers!,
  });
  ws.data.upstream = upstream;
  const wsStart = Date.now();

  upstream.addEventListener("open", () => {
    console.log(`[ws] upstream open [${ws.data.email}] new_prompt=${Boolean(ws.data.isNewPrompt)}`);
    if (ws.data.isNewPrompt && ws.data.accountId) recordRequest(ws.data.accountId);
    broadcastLog({ type: "ws_open", email: ws.data.email, timestamp: Date.now() });
    try { upstream.send(message); } catch {}
  });
  upstream.addEventListener("message", (ev) => {
    try {
      logWebSocketUpstreamResponse(ws, ev.data, Date.now() - wsStart);
      const data = ev.data instanceof ArrayBuffer ? ev.data : String(ev.data);
      if (typeof data === "string") console.log(`[ws←up] [${ws.data.email}] ${data.slice(0, 200)}`);
      const limitSnippet = findWebSocketLimitSnippet(data);
      if (limitSnippet) { void handleWebSocketLimit(ws, limitSnippet, Date.now() - wsStart); return; }
      ws.send(data);
    } catch {}
  });
  upstream.addEventListener("close", (ev) => {
    const latencyMs = Date.now() - wsStart;
    console.log(`[ws] upstream closed: ${ev.code} ${ev.reason ?? ""} [${ws.data.email}]`);
    logWebSocketUpstreamClose(ws, ev.code, ev.reason ?? "", latencyMs);
    if (ws.data.suppressNextClose) { ws.data.suppressNextClose = false; return; }
    const limitSnippet = ev.reason ? findWebSocketLimitSnippet(ev.reason) : null;
    if (limitSnippet) { void handleWebSocketLimit(ws, limitSnippet, latencyMs); return; }
    broadcastLog({ type: "ws_close", email: ws.data.email, code: ev.code, latencyMs, timestamp: Date.now() });
    try { ws.close(ev.code || 1000, ev.reason); } catch {}
  });
  upstream.addEventListener("error", () => {
    console.error(`[ws] upstream error [${ws.data.email}]`);
    broadcastLog({ type: "ws_error", email: ws.data.email, timestamp: Date.now() });
    if (!ws.data.switchingAccount) { try { ws.close(1011, "upstream error"); } catch {} }
  });
}

// ─── Public WebSocket handlers ────────────────────────────────────────────────

export function handleWsOpen(_ws: { data: WsData }) {
  // codex kind: just log connection
  console.log(`[ws] client connected [${_ws.data.email}]`);
}

export function handleWsMessage(
  ws: { send(data: string | ArrayBuffer): void; close(code?: number, reason?: string): void; data: WsData },
  message: string | Buffer | ArrayBuffer
) {
  const snippet = typeof message === "string" ? message.slice(0, 200) : `[binary ${(message as ArrayBuffer).byteLength ?? 0}b]`;
  console.log(`[ws→up] [${ws.data.email}] ${snippet}`);

  if (!ws.data.upstream) {
    let isNewPrompt = true;
    if (typeof message === "string") {
      try {
        const data = JSON.parse(message);
        if (data?.previous_response_id) isNewPrompt = false;
        else if (Array.isArray(data?.input)) {
          const hasToolOutput = data.input.some((i: any) =>
            i?.type === "function_call_output" || i?.type === "computer_call_output"
          );
          if (hasToolOutput) isNewPrompt = false;
        }
      } catch {}
    }
    ws.data.firstMessage = message as any;
    ws.data.isNewPrompt = isNewPrompt;
    openCodexUpstream(ws, message as any);
    return;
  }

  if (ws.data.upstream.readyState === WebSocket.OPEN) {
    ws.data.upstream.send(message as any);
  }
}

export function handleWsClose(
  ws: { data: WsData },
  code: number,
  reason: string
) {
  console.log(`[ws] client disconnected: ${code} ${reason ?? ""} [${ws.data.email}]`);
  try { ws.data.upstream?.close(); } catch {}
}
