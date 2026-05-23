import { proxyRequest, buildWebSocketProxyData } from "./src/proxy";
import {
  getAccounts,
  removeAccount,
  refreshCodexUsageForAccounts,
  setSelectedAccount,
} from "./src/accounts";
import { isCodexConfigPatched, patchCodexConfig, restoreCodexConfig, saveProxyState, loadProxyState } from "./src/config-patcher";
import { getUnsupportedRoutesLogPath, proxyUnsupportedRoute } from "./src/unsupported-routes";
import { watchCodexAuth } from "./src/watcher";
import { cancelLoginFlow, importCallbackUrl, isLoginInProgress, startLoginFlow } from "./src/login-flow";
import { logRequest, logEvent } from "./src/logger";
import { join } from "path";
import { existsSync } from "fs";

const PORT = parseInt(process.env.PROXY_PORT ?? "9876");
const CERTS_DIR = join(import.meta.dir, "certs");
const TLS_CERT = join(CERTS_DIR, "localhost.crt");
const TLS_KEY = join(CERTS_DIR, "localhost.key");
const USE_TLS = process.env.PROXY_TLS === "1" && existsSync(TLS_CERT) && existsSync(TLS_KEY);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const OPENAI_BASE_URL = `${PUBLIC_BASE_URL}/v1`;
const WEB_DIR = join(import.meta.dir, "src/web");

// ─── WebSocket proxy data ─────────────────────────────────────────────────────
interface WsData {
  upstreamUrl: string;
  headers: Record<string, string>;
  email: string;
  upstream?: WebSocket;
}

// ─── SSE log broadcast ────────────────────────────────────────────────────────
const logClients = new Set<(data: string) => void>();
function broadcastLog(entry: object) {
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const send of logClients) send(data);
}

async function restartCodex() {
  await Bun.$`pkill -x Codex`.nothrow();
  await Bun.sleep(600);
  Bun.$`open -a Codex`.nothrow();
}

// ─── Startup ──────────────────────────────────────────────────────────────────
logEvent("startup", `proxy port=${PORT} tls=${USE_TLS}`);

if (loadProxyState()) {
  patchCodexConfig(OPENAI_BASE_URL);
  console.log("[server] Auto-restored proxy config from saved state");
}

// ─── Watch ~/.codex/auth.json — auto-import whenever Codex writes new tokens ─
watchCodexAuth(({ email, isNew }) => {
  const evtType = isNew ? "account_added" : "account_updated";
  console.log(`[server] auth.json → ${isNew ? "NEW account" : "token refresh"}: ${email}`);
  logEvent(evtType, email);
  broadcastLog({ type: evtType, email, timestamp: Date.now() });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log("\n[server] Shutting down...");
  logEvent("shutdown", signal);
  const changed = restoreCodexConfig();
  if (changed) await restartCodex();
  process.exit(0);
}
process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// ─── HTTP Server ──────────────────────────────────────────────────────────────
Bun.serve<WsData>({
  port: PORT,
  idleTimeout: 120,
  ...(USE_TLS && {
    tls: {
      cert: Bun.file(TLS_CERT),
      key: Bun.file(TLS_KEY),
    },
  }),

  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Web UI ────────────────────────────────────────────────────────────────
    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(join(WEB_DIR, "index.html")), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // ── Stub /v1/models — ChatGPT OAuth tokens lack api.model.read scope ─────
    if (path === "/v1/models" && req.method === "GET") {
      const models = ["gpt-5.5", "gpt-5.5-turbo", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3", "o4-mini"].map((id) => ({
        id, object: "model", created: 1700000000, owned_by: "openai",
      }));
      return Response.json({ object: "list", data: models });
    }

    // ── API: list accounts ────────────────────────────────────────────────────
    if (path === "/api/accounts" && req.method === "GET") {
      await refreshCodexUsageForAccounts();
      return Response.json(getAccounts());
    }

    // ── API: force refresh Codex usage ────────────────────────────────────────
    if (path === "/api/usage/refresh" && req.method === "POST") {
      await refreshCodexUsageForAccounts(true);
      return Response.json({ ok: true, accounts: getAccounts() });
    }

    // ── API: start OAuth login flow on callback port 1455 ────────────────────
    if (path === "/api/login" && req.method === "POST") {
      const sendLoginEvent = (entry: object) => {
        broadcastLog({ ...entry, timestamp: Date.now() });
      };
      const result = startLoginFlow(
        (email) => {
          logEvent("login_success", email);
          broadcastLog({ type: "login_success", email, timestamp: Date.now() });
        },
        (error) => {
          logEvent("login_error", error);
          broadcastLog({ type: "login_error", error, timestamp: Date.now() });
        },
        sendLoginEvent
      );
      if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
      logEvent("login_started", "callback port=1455");
      broadcastLog({ type: "login_started", timestamp: Date.now() });
      return Response.json({ ok: true, authorizeUrl: result.authorizeUrl });
    }

    // ── API: login status ────────────────────────────────────────────────────
    if (path === "/api/login/status" && req.method === "GET") {
      return Response.json({ inProgress: isLoginInProgress() });
    }

    // ── API: cancel OAuth login flow and close callback port 1455 ────────────
    if (path === "/api/login/cancel" && req.method === "POST") {
      const cancelled = cancelLoginFlow("cancelled from Web UI");
      if (cancelled) {
        broadcastLog({ type: "login_cancelled", timestamp: Date.now() });
      }
      return Response.json({ ok: true, cancelled, inProgress: isLoginInProgress() });
    }

    // ── API: import pasted OAuth callback URL into the active login flow ─────
    if (path === "/api/login/import-callback" && req.method === "POST") {
      let callbackUrl = "";
      try {
        const body = await req.json() as { callbackUrl?: unknown };
        callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : "";
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      if (!callbackUrl) return Response.json({ error: "Missing callbackUrl" }, { status: 400 });

      const result = await importCallbackUrl(callbackUrl);
      if (!result.ok) {
        const error = result.error ?? "Import callback failed";
        logEvent("login_import_error", error);
        broadcastLog({ type: "login_import_error", error, timestamp: Date.now() });
        return Response.json({ error }, { status: 400 });
      }

      return Response.json({ ok: true, email: result.email, accounts: getAccounts() });
    }

    // ── API: Codex config proxy switch status ────────────────────────────────
    if (path === "/api/config/status" && req.method === "GET") {
      return Response.json({ enabled: isCodexConfigPatched(OPENAI_BASE_URL) });
    }

    // ── API: enable/disable Codex config proxy and restart Codex ─────────────
    if (path === "/api/config" && req.method === "POST") {
      let enabled = false;
      try {
        const body = await req.json() as { enabled?: unknown };
        enabled = Boolean(body?.enabled);
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const caller = req.headers.get("user-agent") ?? "unknown";
      const origin = req.headers.get("origin") ?? req.headers.get("referer") ?? "unknown";
      console.log(`[config] POST /api/config enabled=${enabled} caller="${caller}" origin="${origin}"`);

      if (enabled) {
        patchCodexConfig(OPENAI_BASE_URL);
      } else {
        restoreCodexConfig();
      }
      saveProxyState(enabled);
      await restartCodex();

      const state = isCodexConfigPatched(OPENAI_BASE_URL);
      logEvent("config_proxy", state ? "enabled" : "disabled");
      broadcastLog({ type: "config_proxy", enabled: state, timestamp: Date.now() });
      return Response.json({ ok: true, enabled: state });
    }

    // ── API: switch active account ────────────────────────────────────────────
    if (path.startsWith("/api/accounts/") && path.endsWith("/select") && req.method === "POST") {
      const id = path.split("/")[3];
      if (!id) return Response.json({ error: "Missing account id" }, { status: 400 });
      const result = setSelectedAccount(id);
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      const account = getAccounts().find((a) => a.id === id);
      const email = account?.email ?? id;
      logEvent("account_selected", email);
      broadcastLog({ type: "account_selected", email, timestamp: Date.now() });
      return Response.json({ ok: true });
    }

    // ── API: delete account ───────────────────────────────────────────────────
    if (path.startsWith("/api/accounts/") && req.method === "DELETE") {
      const id = path.split("/")[3];
      if (!id) return Response.json({ error: "Missing account id" }, { status: 400 });
      const result = removeAccount(id);
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      logEvent("account_removed", id);
      return Response.json({ ok: true });
    }

    // ── API: SSE real-time log stream ─────────────────────────────────────────
    if (path === "/api/logs/stream") {
      let send: (data: string) => void;
      const stream = new ReadableStream({
        start(controller) {
          send = (data) => controller.enqueue(new TextEncoder().encode(data));
          logClients.add(send);
          send(`data: ${JSON.stringify({ type: "logs_connected", timestamp: Date.now() })}\n\n`);
        },
        cancel() {
          logClients.delete(send);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Unknown local API routes must not be proxied to ChatGPT ──────────────
    if (path.startsWith("/api/")) {
      return Response.json({ error: `Unknown API route: ${path}` }, { status: 404 });
    }

    // ── WebSocket proxy (Codex uses /v1/responses as WebSocket) ──────────────
    if (
      (path.startsWith("/v1/") || path.startsWith("/backend-api/")) &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const wsData = buildWebSocketProxyData(req);
      if (!wsData) {
        return Response.json(
          { error: { message: "No active account", type: "proxy_error" } },
          { status: 503 }
        );
      }
      const upgraded = server.upgrade(req, { data: wsData });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── OpenAI / ChatGPT API Proxy ────────────────────────────────────────────
    if (path.startsWith("/v1/") || path.startsWith("/backend-api/")) {
      const start = Date.now();
      const { response, meta } = await proxyRequest(
        req,
        (streamError) => {
          const entry = {
            type: "stream_error",
            timestamp: Date.now(),
            method: req.method,
            path,
            status: streamError.status,
            latencyMs: Date.now() - start,
            email: streamError.email,
            error: "stream_error",
            errorSnippet: streamError.errorSnippet,
          };
          broadcastLog(entry);
          logRequest(entry);
        },
        (streamUsage) => {
          const entry = {
            type: "token_usage",
            timestamp: Date.now(),
            method: req.method,
            path,
            status: streamUsage.status,
            latencyMs: Date.now() - start,
            email: streamUsage.email,
            usage: streamUsage.usage,
          };
          broadcastLog(entry);
          logRequest(entry);
        },
        (accountSwitch) => {
          logEvent("account_switched", `${accountSwitch.from} → ${accountSwitch.to} [${accountSwitch.reason}]`);
          broadcastLog({ type: "account_switched", ...accountSwitch, timestamp: Date.now() });
        }
      );
      const latencyMs = Date.now() - start;

      const logEntry: Record<string, unknown> = {
        type: "request",
        timestamp: Date.now(),
        method: req.method,
        path,
        status: response.status,
        latencyMs,
        email: meta.email,
      };
      if (meta.errorSnippet)    logEntry.errorSnippet    = meta.errorSnippet;
      if (meta.accountSwitched) logEntry.accountSwitched = meta.accountSwitched;

      broadcastLog(logEntry);
      logRequest({
        timestamp: Date.now(),
        method: req.method,
        path,
        status: response.status,
        latencyMs,
        email: meta.email,
        errorSnippet: meta.errorSnippet,
        accountSwitched: meta.accountSwitched,
      });

      if (meta.accountSwitched && !meta.accountSwitchBroadcasted) {
        const sw = meta.accountSwitched;
        logEvent("account_switched", `${sw.from} → ${sw.to} [${sw.reason}]`);
        broadcastLog({ type: "account_switched", ...sw, timestamp: Date.now() });
      }

      return response;
    }

    // ── Fallback: try to proxy unknown routes ─────────────────────────────────
    const fallback = await proxyUnsupportedRoute(req);
    console.warn(
      fallback.logEntry.proxied
        ? `[server] Fallback → ${fallback.logEntry.matchedTarget} (${fallback.logEntry.responseStatus})`
        : `[server] Unhandled: ${req.method} ${path}`
    );

    const fbEntry = {
      type: "request",
      timestamp: fallback.logEntry.timestamp,
      method: req.method,
      path: path + url.search,
      status: fallback.logEntry.responseStatus ?? 404,
      latencyMs: 0,
      email: "",
      unhandled: true,
      proxied: fallback.logEntry.proxied,
      target: fallback.logEntry.matchedTarget ?? "",
    };
    broadcastLog(fbEntry);
    logRequest({ ...fbEntry, timestamp: fbEntry.timestamp });

    if (fallback.response) return fallback.response;

    return Response.json(
      {
        error: {
          message: `Unhandled route: ${req.method} ${path}${url.search}`,
          type: "proxy_error",
          log_file: getUnsupportedRoutesLogPath(),
        },
      },
      { status: 404 }
    );
  },

  websocket: {
    open(ws) {
      console.log(`[ws] client connected [${ws.data.email}]`);
      // Upstream is connected lazily on first message to avoid chatgpt.com's
      // tight first-message timeout closing the connection before Codex sends.
    },
    message(ws, message) {
      const snippet = typeof message === "string" ? message.slice(0, 200) : `[binary ${(message as ArrayBuffer).byteLength}b]`;
      console.log(`[ws→up] [${ws.data.email}] ${snippet}`);

      if (!ws.data.upstream) {
        // First message: open upstream now and send immediately on open
        const upstream = new WebSocket(ws.data.upstreamUrl, {
          // @ts-ignore — Bun extension: headers supported in WebSocket constructor
          headers: ws.data.headers,
        });
        ws.data.upstream = upstream;
        const wsStart = Date.now();

        upstream.addEventListener("open", () => {
          console.log(`[ws] upstream open [${ws.data.email}]`);
          broadcastLog({ type: "ws_open", email: ws.data.email, timestamp: Date.now() });
          try { upstream.send(message); } catch {}
        });
        upstream.addEventListener("message", (ev) => {
          try {
            const data = ev.data instanceof ArrayBuffer ? ev.data : String(ev.data);
            if (typeof data === "string") console.log(`[ws←up] [${ws.data.email}] ${data.slice(0, 200)}`);
            ws.send(data);
          } catch {}
        });
        upstream.addEventListener("close", (ev) => {
          const latencyMs = Date.now() - wsStart;
          console.log(`[ws] upstream closed: ${ev.code} ${ev.reason ?? ""} [${ws.data.email}]`);
          broadcastLog({ type: "ws_close", email: ws.data.email, code: ev.code, latencyMs, timestamp: Date.now() });
          try { ws.close(ev.code || 1000, ev.reason); } catch {}
        });
        upstream.addEventListener("error", () => {
          console.error(`[ws] upstream error [${ws.data.email}]`);
          broadcastLog({ type: "ws_error", email: ws.data.email, timestamp: Date.now() });
          try { ws.close(1011, "upstream error"); } catch {}
        });
        return;
      }

      // Subsequent messages: forward directly
      if (ws.data.upstream.readyState === WebSocket.OPEN) {
        ws.data.upstream.send(message);
      }
    },
    close(ws, code, reason) {
      console.log(`[ws] client disconnected: ${code} ${reason ?? ""} [${ws.data.email}]`);
      try { ws.data.upstream?.close(); } catch {}
    },
  },
});

const scheme = USE_TLS ? "https" : "http";
console.log(`
╔══════════════════════════════════════════╗
║         Codex Proxy Manager              ║
╠══════════════════════════════════════════╣
║  Proxy : ${OPENAI_BASE_URL}     ║
║  Web UI: ${scheme}://localhost:${PORT}        ║
║  Log   : logs/requests.log               ║
║  TLS   : ${USE_TLS ? "✓ enabled (certs/localhost.crt)" : "✗ disabled (HTTP only)"}  ║
╚══════════════════════════════════════════╝
`);
console.log(`[server] Listening on port ${PORT} (${USE_TLS ? "HTTPS" : "HTTP"})`);
