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
import { AccountService } from "./src/services/account-service";
import { InternalAuthService } from "./src/services/internal-auth";
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
import { AuthController } from "./src/controllers/auth.livequery";
import type { LivequeryDeps } from "./src/controllers/_livequery";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT ?? "9878");
const LIVEQUERY_WS_PORT = parseInt(process.env.LIVEQUERY_WS_PORT ?? "9879"); // kept for fallback; unused when external mode active
const CERTS_DIR = join(import.meta.dir, "certs");
const TLS_CERT = join(CERTS_DIR, "localhost.crt");
const TLS_KEY = join(CERTS_DIR, "localhost.key");
const USE_TLS = process.env.PROXY_TLS === "1" && existsSync(TLS_CERT) && existsSync(TLS_KEY);
const DEFAULT_PUBLIC_BASE_URL = `${USE_TLS ? "https" : "http"}://localhost:${PORT}`;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
const OPENAI_BASE_URL = `${PUBLIC_BASE_URL}/v1`;
const FRONTEND_DEV_ORIGIN = (process.env.FRONTEND_DEV_ORIGIN ?? "http://127.0.0.1:9000").replace(/\/+$/, "");

// ─── Composition root: instantiate every service + wire dependencies ───────────
const logger = new LoggerService();
const broadcast = new BroadcastService();
const configPatcher = new ConfigPatcherService();
const auth = new AuthService();
const authGate = new AuthGateService();
const internalAuth = new InternalAuthService();
const upstream = new UpstreamProxy();
const codexApi = new CodexApiService();
const sseStream = new SseStreamService();

// LiveQuery WebSocket Gateway — chạy "external" mode, Bun.serve sẽ inject WS trực tiếp
// vào gateway qua attachBunUpgrade/getBunWebsocketHandlers, không mở port riêng 9879.
const websocketGateway = new WebsocketGateway("external");

const accounts = new AccountsService(auth);
const watcher = new WatcherService(accounts);
const enrollment = new EnrollmentService(accounts);
// AccountService = front-door domain account (list / fetchQuota / switch / pickForProxy) + tự sync vào WS.
const accountService = new AccountService(accounts, enrollment, websocketGateway);
const loginFlow = new LoginFlowService(accounts, logger);
const dailyRoutine = new DailyRoutineService(accounts);
const registry = new RemoteControlRegistry(enrollment);
const unsupportedRoutes = new UnsupportedRoutesService(accountService, upstream);
const proxy = new ProxyService(accountService, accounts, watcher, upstream);
const lqStore = createLivequeryStore({ accounts, codexApi, registry, enrollment, configPatcher, accountService });

// Wire circular dependency: broadcast → store (broadcast cannot import livequery)
broadcast.onReport((entry) => lqStore.addReport(entry as any));

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

// Tự refresh access token nền cho account sắp hết hạn (mặc định mỗi 60s).
const TOKEN_AUTO_REFRESH_INTERVAL_MS = Math.max(10, Number(process.env.ACCOUNT_TOKEN_AUTO_REFRESH_INTERVAL_SECONDS ?? 60)) * 1000;
const tokenAutoRefresh = accountService.startTokenAutoRefresh(TOKEN_AUTO_REFRESH_INTERVAL_MS);
// Tự reload quota nền cho mọi account (mặc định mỗi 30s) để UI/selection không lệ thuộc thao tác tay.
const QUOTA_AUTO_RELOAD_INTERVAL_MS = Math.max(10, Number(process.env.ACCOUNT_QUOTA_AUTO_RELOAD_INTERVAL_SECONDS ?? 30)) * 1000;
const quotaAutoReload = accountService.startQuotaAutoReload(QUOTA_AUTO_RELOAD_INTERVAL_MS);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log("\n[server] Shutting down...");
  logger.logEvent("shutdown", signal);
  dailyRoutineScheduler.stop();
  tokenAutoRefresh.stop();
  quotaAutoReload.stop();
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

// ─── Static file serving (production mode) ───────────────────────────────────
const STATIC_DIR = process.env.STATIC_DIR ?? "";

async function serveStatic(pathname: string): Promise<Response> {
  // strip query string, decode URI
  const clean = decodeURIComponent(pathname.split("?")[0]);
  // try exact path, then index.html fallback (SPA)
  for (const candidate of [clean, "/index.html"]) {
    const file = Bun.file(join(STATIC_DIR, candidate));
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          ...(candidate !== clean ? {} : {
            "Cache-Control": clean.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
          }),
        },
      });
    }
  }
  // fallback to index.html for SPA routing
  const index = Bun.file(join(STATIC_DIR, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "Content-Type": "text/html" } });
  return new Response("Not found", { status: 404 });
}

function proxyFrontendRequest(req: Request): Promise<Response> {
  if (STATIC_DIR) return serveStatic(new URL(req.url).pathname);
  const url = new URL(req.url);
  const target = `${FRONTEND_DEV_ORIGIN}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  return fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
}

function shouldProxyFrontendPath(path: string): boolean {
  return !(
    path === "/health" ||
    path === "/favicon.ico" ||
    path.startsWith("/v1/") ||
    path.startsWith("/backend-api/") ||
    path.startsWith("/livequery/") ||
    path.startsWith("/auth-api/") ||
    path.startsWith("/api/") ||
    path.startsWith("/enroll/")
  );
}

// Mount: web → từng LiveQuery collection controller → proxy (fallback "*" phải nằm cuối)
app.route("/", webController);
app.route("/", new AuthController(accounts, internalAuth));
// User auth đã gỡ: các LiveQuery API không còn yêu cầu internal JWT (đăng nhập thẳng).
app.route("/", new AccountsController(lqStore, accounts, accountService, enrollment, loginFlow, logger, configPatcher, codexApi, registry, lqDeps));
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
    const url = new URL(req.url);
    const path = url.pathname;
    const isWebSocketUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (path === "/livequery/realtime-updates" && isWebSocketUpgrade) {
      const upgraded = websocketGateway.attachBunUpgrade(req, server);
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (
      (path.startsWith("/v1/") || path.startsWith("/backend-api/")) &&
      isWebSocketUpgrade
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

    if (!STATIC_DIR && isWebSocketUpgrade && shouldProxyFrontendPath(path)) {
      const frontendUrl = new URL(FRONTEND_DEV_ORIGIN);
      const upstreamUrl = `${frontendUrl.protocol === "https:" ? "wss:" : "ws:"}//${frontendUrl.host}${url.pathname}${url.search}`;
      const upgraded = server.upgrade(req, { data: { kind: "frontend", upstreamUrl } });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (shouldProxyFrontendPath(path)) {
      return proxyFrontendRequest(req);
    }

    const response = await app.fetch(req);
    if (response.status !== 404) return response;
    return proxyFrontendRequest(req);
  },

  websocket: {
    open(ws) {
      const lqHandlers = websocketGateway.getBunWebsocketHandlers();
      if ((ws.data as any)?._livequery) { lqHandlers.open(ws); return; }
      websocketController.handleWsOpen(ws as any);
    },
    message(ws, message) {
      const lqHandlers = websocketGateway.getBunWebsocketHandlers();
      if ((ws.data as any)?._livequery) { lqHandlers.message(ws, message as any); return; }
      websocketController.handleWsMessage(ws as any, message as any);
    },
    close(ws, code, reason) {
      const lqHandlers = websocketGateway.getBunWebsocketHandlers();
      if ((ws.data as any)?._livequery) { lqHandlers.close(ws); return; }
      websocketController.handleWsClose(ws as any, code, reason);
    },
  },
});

const scheme = USE_TLS ? "https" : "http";
console.log(`
╔══════════════════════════════════════════╗
║         Codex Proxy Manager              ║
╠══════════════════════════════════════════╣
║  API    : ${OPENAI_BASE_URL}
║  LQ WS  : ws://localhost:${PORT}/livequery/realtime-updates
║  Web UI : http://localhost:9000 (Remix)
║  TLS    : ${USE_TLS ? "✓ enabled" : "✗ disabled (HTTP only)"}
╚══════════════════════════════════════════╝
`);
console.log(`[server] Listening on port ${PORT} (${scheme.toUpperCase()})`);
