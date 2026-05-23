import { proxyRequest, buildWebSocketProxyData } from "./src/proxy";
import {
  recordRequest,
} from "./src/accounts";
import { patchCodexConfig, restoreCodexConfig, loadProxyState } from "./src/config-patcher";
import { getUnsupportedRoutesLogPath, proxyUnsupportedRoute } from "./src/unsupported-routes";
import { watchCodexAuth } from "./src/watcher";
import { logRequest, logEvent } from "./src/logger";
import {
  LIVEQUERY_SOCKET_PATH,
  addReport,
  closeLivequerySocket,
  closeLivequery,
  getLivequeryRealtimeUrl,
  handleLivequeryRequest,
  messageLivequerySocket,
  notifyAccountsChanged,
  openLivequerySocket,
} from "./src/livequery";
import { join } from "path";
import { existsSync } from "fs";

const PORT = parseInt(process.env.PROXY_PORT ?? "9878");
const CERTS_DIR = join(import.meta.dir, "certs");
const TLS_CERT = join(CERTS_DIR, "localhost.crt");
const TLS_KEY = join(CERTS_DIR, "localhost.key");
const USE_TLS = process.env.PROXY_TLS === "1" && existsSync(TLS_CERT) && existsSync(TLS_KEY);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");
const OPENAI_BASE_URL = `${PUBLIC_BASE_URL}/v1`;
const WEB_DIR = join(import.meta.dir, "src/web");
const WEB_BUILD_DIR = join(import.meta.dir, ".livequery-web");
const WEB_BUNDLE = join(WEB_BUILD_DIR, "app.js");

// ─── WebSocket proxy data ─────────────────────────────────────────────────────
interface WsData {
  kind?: "codex" | "livequery";
  upstreamUrl?: string;
  headers?: Record<string, string>;
  email?: string;
  accountId?: string;
  upstream?: WebSocket;
  livequeryClientId?: string;
  livequeryRefs?: Set<string>;
}

// ─── SSE log broadcast ────────────────────────────────────────────────────────
const logClients = new Set<(data: string) => void>();
function broadcastLog(entry: object) {
  addReport(entry as any);
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
  console.log("[server] Saved proxy state is enabled; not auto-patching config on startup");
}

await Bun.build({
  entrypoints: [join(WEB_DIR, "app.tsx")],
  outdir: WEB_BUILD_DIR,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
});

// ─── Watch ~/.codex/auth.json — auto-import whenever Codex writes new tokens ─
watchCodexAuth(({ email, isNew }) => {
  const evtType = isNew ? "account_added" : "account_updated";
  console.log(`[server] auth.json → ${isNew ? "NEW account" : "token refresh"}: ${email}`);
  logEvent(evtType, email);
  broadcastLog({ type: evtType, email, timestamp: Date.now() });
  notifyAccountsChanged();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log("\n[server] Shutting down...");
  logEvent("shutdown", signal);
  closeLivequery();
  process.exit(0);
}
process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// ─── HTTP Server ──────────────────────────────────────────────────────────────
Bun.serve<WsData>({
  port: PORT,
  hostname: process.env.PROXY_HOST ?? "0.0.0.0",
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
      const realtimeUrl = getLivequeryRealtimeUrl(url.origin);
      const html = await Bun.file(join(WEB_DIR, "index.html")).text();
      return new Response(html.replace("__LIVEQUERY_WS_URL_VALUE__", realtimeUrl), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/app.js") {
      return new Response(Bun.file(WEB_BUNDLE), {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }

    if (path === "/app.js.map") {
      return new Response(Bun.file(`${WEB_BUNDLE}.map`), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (path === "/app.css") {
      return new Response(Bun.file(join(WEB_BUILD_DIR, "app.css")), {
        headers: { "Content-Type": "text/css; charset=utf-8" },
      });
    }

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (
      path === LIVEQUERY_SOCKET_PATH &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const upgraded = server.upgrade(req, { data: { kind: "livequery" } });
      if (upgraded) return;
      return new Response("LiveQuery WebSocket upgrade failed", { status: 400 });
    }

    if (path.startsWith("/livequery/")) {
      return handleLivequeryRequest(req, {
        openaiBaseUrl: OPENAI_BASE_URL,
        publicBaseUrl: PUBLIC_BASE_URL,
        restartCodex,
      });
    }

    // ── Stub /v1/models — ChatGPT OAuth tokens lack api.model.read scope ─────
    if (path === "/v1/models" && req.method === "GET") {
      const models = ["gpt-5.5", "gpt-5.5-turbo", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3", "o4-mini"].map((id) => ({
        id, object: "model", created: 1700000000, owned_by: "openai",
      }));
      return Response.json({ object: "list", data: models });
    }

    if (path.startsWith("/api/")) {
      return Response.json(
        {
          error: {
            message: `Legacy API route removed after LiveQuery migration: ${path}`,
            type: "livequery_migration",
          },
        },
        { status: 410 }
      );
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
      const upgraded = server.upgrade(req, { data: { ...wsData, kind: "codex" } });
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
          notifyAccountsChanged();
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
        notifyAccountsChanged();
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
      if (ws.data.kind === "livequery") {
        openLivequerySocket(ws as any);
        return;
      }
      console.log(`[ws] client connected [${ws.data.email}]`);
      // Upstream is connected lazily on first message to avoid chatgpt.com's
      // tight first-message timeout closing the connection before Codex sends.
    },
    message(ws, message) {
      if (ws.data.kind === "livequery") {
        messageLivequerySocket(ws as any, message as any);
        return;
      }
      const snippet = typeof message === "string" ? message.slice(0, 200) : `[binary ${message.byteLength}b]`;
      console.log(`[ws→up] [${ws.data.email}] ${snippet}`);

      if (!ws.data.upstream) {
        // Determine if this is a NEW prompt vs a tool-call continuation.
        // Continuations have previous_response_id set OR input contains tool outputs.
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

        // First message: open upstream now and send immediately on open
        const upstream = new WebSocket(ws.data.upstreamUrl!, {
          // @ts-ignore — Bun extension: headers supported in WebSocket constructor
          headers: ws.data.headers!,
        });
        ws.data.upstream = upstream;
        const wsStart = Date.now();

        upstream.addEventListener("open", () => {
          console.log(`[ws] upstream open [${ws.data.email}] new_prompt=${isNewPrompt}`);
          if (isNewPrompt && ws.data.accountId) recordRequest(ws.data.accountId);
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
      if (ws.data.kind === "livequery") {
        closeLivequerySocket(ws as any);
        return;
      }
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
║  Web UI: ${scheme}://0.0.0.0:${PORT}          ║
║  LQ WS : ${LIVEQUERY_SOCKET_PATH}             ║
║  Log   : logs/requests.log               ║
║  TLS   : ${USE_TLS ? "✓ enabled (certs/localhost.crt)" : "✗ disabled (HTTP only)"}  ║
╚══════════════════════════════════════════╝
`);
console.log(`[server] Listening on port ${PORT} (${USE_TLS ? "HTTPS" : "HTTP"})`);
