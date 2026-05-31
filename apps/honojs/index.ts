import { Hono } from "hono";
import { WebsocketGateway } from "@livequery/core";
import { join } from "path";
import { existsSync } from "fs";

// ─── Service / lib classes (composition root — only place that `new`s) ─────────
import { LoggerService } from "./src/services/logger";
import { BroadcastService } from "./src/services/broadcast";
import { ConfigPatcherService } from "./src/services/config-patcher";
import { WatcherService } from "./src/services/watcher";
import { AccountsService } from "./src/services/accounts";
import { SseStreamService } from "./src/services/sse-stream";
import { UnsupportedRoutesService } from "./src/services/unsupported-routes";
import { ProxyService } from "./src/services/proxy";
import { createLivequeryStore } from "./src/services/livequery";
import { AuthService, AuthGateService, EnrollmentService, LoginFlowService } from "./src/libs/openai";
import { CodexApiService, DailyRoutineService } from "./src/libs/chatgpt";
import { RemoteControlRegistry } from "./src/libs/codex-remote-control";
import { UpstreamProxy } from "./src/libs/upstream";

// ─── Controllers ──────────────────────────────────────────────────────────────
import { WebController } from "./src/controllers/web.livequery";
import { ProxyController } from "./src/controllers/proxy.livequery";
import { WebsocketController } from "./src/controllers/websocket.livequery";
import type { WsData } from "./src/controllers/websocket.livequery";
import { AccountsController } from "./src/controllers/accounts.livequery";
import { ReportsController } from "./src/controllers/reports.livequery";
import { HostsController } from "./src/controllers/hosts.livequery";
import { ProjectsController } from "./src/controllers/projects.livequery";
import { ChatsController } from "./src/controllers/chats.livequery";
import { TurnsController } from "./src/controllers/turns.livequery";
import { RuntimeController } from "./src/controllers/runtime.livequery";
import type { LivequeryDeps } from "./src/controllers/_livequery";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT ?? "9878");
const LIVEQUERY_WS_PORT = parseInt(process.env.LIVEQUERY_WS_PORT ?? "9879");
const CERTS_DIR = join(import.meta.dir, "certs");
const TLS_CERT = join(CERTS_DIR, "localhost.crt");
const TLS_KEY = join(CERTS_DIR, "localhost.key");
const USE_TLS = process.env.PROXY_TLS === "1" && existsSync(TLS_CERT) && existsSync(TLS_KEY);
const DEFAULT_PUBLIC_BASE_URL = `${USE_TLS ? "https" : "http"}://localhost:${PORT}`;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
const OPENAI_BASE_URL = `${PUBLIC_BASE_URL}/v1`;

// ─── Composition root: instantiate every service + wire dependencies ───────────
const logger = new LoggerService();
const broadcast = new BroadcastService();
const configPatcher = new ConfigPatcherService();
const auth = new AuthService();
const authGate = new AuthGateService();
const upstream = new UpstreamProxy();
const codexApi = new CodexApiService();
const sseStream = new SseStreamService();

const accounts = new AccountsService(auth);
const watcher = new WatcherService(accounts);
const enrollment = new EnrollmentService(accounts);
const loginFlow = new LoginFlowService(accounts, logger);
const dailyRoutine = new DailyRoutineService(accounts);
const registry = new RemoteControlRegistry(enrollment);
const unsupportedRoutes = new UnsupportedRoutesService(accounts, upstream);
const proxy = new ProxyService(accounts, watcher, upstream);
const lqStore = createLivequeryStore({ accounts, codexApi, registry, enrollment, configPatcher });

// Wire circular dependency: broadcast → store (broadcast cannot import livequery)
broadcast.onReport((entry) => lqStore.addReport(entry as any));

// ─── LiveQuery WebSocket Gateway (dedicated port) ─────────────────────────────
const websocketGateway = new WebsocketGateway(LIVEQUERY_WS_PORT);
lqStore.initWebsocketGateway(websocketGateway);

// ─── Startup ──────────────────────────────────────────────────────────────────
logger.logEvent("startup", `proxy port=${PORT} livequery_ws_port=${LIVEQUERY_WS_PORT} tls=${USE_TLS}`);

if (configPatcher.loadProxyState()) {
  console.log("[server] Saved proxy state is enabled; not auto-patching config on startup");
}

const dailyRoutineScheduler = dailyRoutine.startDailyRoutineScheduler((entry) => {
  lqStore.addReport(entry as any);
  lqStore.notifyAccountsChanged();
});

watcher.watchCodexAuth(({ email, isNew }) => {
  const evtType = isNew ? "account_added" : "account_updated";
  console.log(`[server] auth.json → ${isNew ? "NEW account" : "token refresh"}: ${email}`);
  logger.logEvent(evtType, email);
  broadcast.broadcastLog({ type: evtType, email, timestamp: Date.now() });
  lqStore.notifyAccountsChanged();
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log("\n[server] Shutting down...");
  logger.logEvent("shutdown", signal);
  dailyRoutineScheduler.stop();
  lqStore.close();
  websocketGateway.close();
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

const jwtMiddleware = async (c: any, next: any) => {
  const gate = await authGate.validateClientJwt(c.req.raw);
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

const lqDeps: LivequeryDeps = { websocketGateway, openaiBaseUrl: OPENAI_BASE_URL, restartCodex };

const webController = new WebController(lqStore, enrollment);
const proxyController = new ProxyController(proxy, broadcast, logger, lqStore, unsupportedRoutes);
const websocketController = new WebsocketController(accounts, broadcast, logger, lqStore);

// Mount: web → từng LiveQuery collection controller → proxy (fallback "*" phải nằm cuối)
app.route("/", webController);
app.route("/", new AccountsController(lqStore, accounts, enrollment, loginFlow, logger, configPatcher, codexApi, registry, lqDeps));
app.route("/", new ReportsController(lqStore, lqDeps));
app.route("/", new HostsController(lqStore, accounts, registry, lqDeps));
app.route("/", new ProjectsController(lqStore, accounts, registry, lqDeps));
app.route("/", new ChatsController(lqStore, accounts, codexApi, registry, lqDeps));
app.route("/", new TurnsController(lqStore, accounts, codexApi, registry, sseStream, lqDeps));
app.route("/", new RuntimeController(lqStore, configPatcher, loginFlow, lqDeps));
app.route("/", proxyController);

// ─── Bun.serve (HTTP + Codex WebSocket proxy) ─────────────────────────────────
Bun.serve<WsData>({
  port: PORT,
  hostname: process.env.PROXY_HOST ?? "0.0.0.0",
  idleTimeout: 120,
  ...(USE_TLS && {
    tls: { cert: Bun.file(TLS_CERT), key: Bun.file(TLS_KEY) },
  }),

  async fetch(req, server) {
    const path = new URL(req.url).pathname;

    if (
      (path.startsWith("/v1/") || path.startsWith("/backend-api/")) &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      const gate = await authGate.validateClientJwt(req);
      if (!gate.ok) {
        console.warn(`[gate] DENY WS ${path} → ${gate.status} ${gate.error}`);
        return Response.json({ error: { message: gate.error, type: "forbidden" } }, { status: gate.status });
      }
      const wsData = proxy.buildWebSocketProxyData(req);
      if (!wsData) {
        return Response.json({ error: { message: "No active account", type: "proxy_error" } }, { status: 503 });
      }
      const upgraded = server.upgrade(req, { data: { ...wsData, kind: "codex" } });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return app.fetch(req);
  },

  websocket: {
    open(ws) { websocketController.handleWsOpen(ws as any); },
    message(ws, message) { websocketController.handleWsMessage(ws as any, message as any); },
    close(ws, code, reason) { websocketController.handleWsClose(ws as any, code, reason); },
  },
});

const scheme = USE_TLS ? "https" : "http";
console.log(`
╔══════════════════════════════════════════╗
║         Codex Proxy Manager              ║
╠══════════════════════════════════════════╣
║  API    : ${OPENAI_BASE_URL}
║  LQ WS  : ws://localhost:${LIVEQUERY_WS_PORT}/livequery/realtime-updates
║  Web UI : http://localhost:3000 (Remix)
║  TLS    : ${USE_TLS ? "✓ enabled" : "✗ disabled (HTTP only)"}
╚══════════════════════════════════════════╝
`);
console.log(`[server] Listening on port ${PORT} (${scheme.toUpperCase()})`);
