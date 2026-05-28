import { Hono } from "hono";
import { validateClientJwt } from "./src/server/services/auth-gate";
import { createWebController } from "./src/server/controllers/web-controller";
import { createProxyController } from "./src/server/controllers/proxy-controller";
import { createLivequeryController } from "./src/server/controllers/livequery-controller";
import {
  handleWsOpen,
  handleWsMessage,
  handleWsClose,
  type WsData,
} from "./src/server/controllers/websocket-controller";
import {
  openLivequerySocket,
  messageLivequerySocket,
  closeLivequerySocket,
} from "./src/server/controllers/livequery-controller";
import {
  LIVEQUERY_SOCKET_PATH,
  closeLivequery,
  getLivequeryRealtimeUrl,
  addReport,
  notifyAccountsChanged,
} from "./src/server/services/livequery";
import { watchCodexAuth } from "./src/server/services/watcher";
import { logEvent } from "./src/server/services/logger";
import { startDailyRoutineScheduler } from "./src/server/services/daily-routine";
import { patchCodexConfig, loadProxyState } from "./src/server/services/config-patcher";
import { buildWebSocketProxyData } from "./src/server/services/proxy";
import { broadcastLog } from "./src/server/services/broadcast";
import { join } from "path";
import { existsSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT ?? "9878");
const CERTS_DIR = join(import.meta.dir, "certs");
const TLS_CERT = join(CERTS_DIR, "localhost.crt");
const TLS_KEY = join(CERTS_DIR, "localhost.key");
const USE_TLS = process.env.PROXY_TLS === "1" && existsSync(TLS_CERT) && existsSync(TLS_KEY);
const DEFAULT_PUBLIC_BASE_URL = `${USE_TLS ? "https" : "http"}://localhost:${PORT}`;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
const OPENAI_BASE_URL = `${PUBLIC_BASE_URL}/v1`;
const WEB_DIR = join(import.meta.dir, "src/web");
const WEB_BUILD_DIR = join(import.meta.dir, ".livequery-web");

// ─── Startup ──────────────────────────────────────────────────────────────────
logEvent("startup", `proxy port=${PORT} tls=${USE_TLS}`);

if (loadProxyState()) {
  console.log("[server] Saved proxy state is enabled; not auto-patching config on startup");
}

const dailyRoutineScheduler = startDailyRoutineScheduler((entry) => {
  addReport(entry as any);
  notifyAccountsChanged();
});

await Bun.build({
  entrypoints: [join(WEB_DIR, "app.tsx")],
  outdir: WEB_BUILD_DIR,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
});

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
  dailyRoutineScheduler.stop();
  closeLivequery();
  process.exit(0);
}
process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

// ─── restartCodex ─────────────────────────────────────────────────────────────
async function restartCodex() {
  await Bun.$`pkill -x Codex`.nothrow();
  await Bun.sleep(600);
  Bun.$`open -a Codex`.nothrow();
}

// ─── Hono App ─────────────────────────────────────────────────────────────────
const app = new Hono();

// JWT gate middleware
const jwtMiddleware = async (c: any, next: any) => {
  const gate = await validateClientJwt(c.req.raw);
  if (!gate.ok) {
    console.warn(`[gate] DENY ${c.req.method} ${c.req.path} → ${gate.status} ${gate.error}`);
    return c.json({ error: { message: gate.error, type: "forbidden" } }, gate.status as any);
  }
  console.log(`[gate] ALLOW ${c.req.method} ${c.req.path} ← ${gate.email} (${gate.planType})`);
  return next();
};

app.use("/v1/*", async (c, next) => {
  if (c.req.path === "/v1/models") return next();
  return jwtMiddleware(c, next);
});
app.use("/backend-api/*", jwtMiddleware);

// Mount controllers
app.route("/", createWebController());
app.route("/", createLivequeryController({ restartCodex }));
app.route("/", createProxyController());

// ─── Bun.serve ────────────────────────────────────────────────────────────────
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

    // LiveQuery WebSocket upgrade (no JWT needed)
    if (path === LIVEQUERY_SOCKET_PATH && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const upgraded = server.upgrade(req, { data: { kind: "livequery" } });
      if (upgraded) return;
      return new Response("LiveQuery WebSocket upgrade failed", { status: 400 });
    }

    // Codex WebSocket proxy upgrade (JWT gated)
    if (
      (path.startsWith("/v1/") || path.startsWith("/backend-api/")) &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const gate = await validateClientJwt(req);
      if (!gate.ok) {
        console.warn(`[gate] DENY WS ${path} → ${gate.status} ${gate.error}`);
        return Response.json({ error: { message: gate.error, type: "forbidden" } }, { status: gate.status });
      }
      const wsData = buildWebSocketProxyData(req);
      if (!wsData) {
        return Response.json({ error: { message: "No active account", type: "proxy_error" } }, { status: 503 });
      }
      const upgraded = server.upgrade(req, { data: { ...wsData, kind: "codex" } });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // All HTTP requests → Hono
    return app.fetch(req);
  },

  websocket: {
    open(ws) {
      if (ws.data.kind === "livequery") {
        openLivequerySocket(ws as any);
        return;
      }
      handleWsOpen(ws as any);
    },
    message(ws, message) {
      if (ws.data.kind === "livequery") {
        messageLivequerySocket(ws as any, message as any);
        return;
      }
      handleWsMessage(ws as any, message as any);
    },
    close(ws, code, reason) {
      if (ws.data.kind === "livequery") {
        closeLivequerySocket(ws as any);
        return;
      }
      handleWsClose(ws as any, code, reason);
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
