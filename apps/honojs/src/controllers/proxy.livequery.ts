import { Hono } from "hono";
import type { ProxyService } from "../services/proxy";
import type { BroadcastService } from "../services/broadcast";
import type { LoggerService } from "../services/logger";
import { LivequeryStore } from "../services/livequery";
import type { UnsupportedRoutesService } from "../services/unsupported-routes";

// ─── ProxyController ──────────────────────────────────────────────────────────

export class ProxyController extends Hono {
  constructor(
    private readonly proxy: ProxyService,
    private readonly broadcast: BroadcastService,
    private readonly logger: LoggerService,
    private readonly livequery: LivequeryStore,
    private readonly unsupportedRoutes: UnsupportedRoutesService
  ) {
    super();
    this.all("/v1/*", (c) => this.handleProxyRoute(c));
    this.all("/backend-api/*", (c) => this.handleProxyRoute(c));
    this.all("*", (c) => this.handleFallback(c));
  }

  private async handleProxyRoute(c: any): Promise<Response> {
    const req = c.req.raw;
    const start = Date.now();

    const { response, meta } = await this.proxy.proxyRequest(
      req,
      (streamError) => {
        const entry = {
          type: "stream_error", timestamp: Date.now(), method: req.method,
          path: c.req.path, status: streamError.status, latencyMs: Date.now() - start,
          email: streamError.email, error: "stream_error", errorSnippet: streamError.errorSnippet,
        };
        this.broadcast.broadcastLog(entry);
        this.logger.logRequest(entry);
      },
      (streamUsage) => {
        const entry = {
          type: "token_usage", timestamp: Date.now(), method: req.method,
          path: c.req.path, status: streamUsage.status, latencyMs: Date.now() - start,
          email: streamUsage.email, usage: streamUsage.usage,
        };
        this.broadcast.broadcastLog(entry);
        this.logger.logRequest(entry);
      },
      (accountSwitch) => {
        this.logger.logEvent("account_switched", `${accountSwitch.from} → ${accountSwitch.to} [${accountSwitch.reason}]`);
        this.broadcast.broadcastLog({ type: "account_switched", ...accountSwitch, timestamp: Date.now() });
        this.livequery.notifyAccountsChanged();
      }
    );

    const latencyMs = Date.now() - start;
    const logEntry: Record<string, unknown> = {
      type: "request", timestamp: Date.now(), method: req.method, path: c.req.path,
      status: response.status, latencyMs, email: meta.email,
    };
    if (meta.errorSnippet)    logEntry.errorSnippet    = meta.errorSnippet;
    if (meta.accountSwitched) logEntry.accountSwitched = meta.accountSwitched;

    this.broadcast.broadcastLog(logEntry);
    this.logger.logRequest({
      timestamp: Date.now(), method: req.method, path: c.req.path,
      status: response.status, latencyMs, email: meta.email,
      errorSnippet: meta.errorSnippet, accountSwitched: meta.accountSwitched,
    });

    if (meta.accountSwitched && !meta.accountSwitchBroadcasted) {
      const sw = meta.accountSwitched;
      this.logger.logEvent("account_switched", `${sw.from} → ${sw.to} [${sw.reason}]`);
      this.broadcast.broadcastLog({ type: "account_switched", ...sw, timestamp: Date.now() });
      this.livequery.notifyAccountsChanged();
    }

    return response;
  }

  private async handleFallback(c: any): Promise<Response> {
    const req = c.req.raw;
    const reqUrl = new URL(req.url);
    // KHÔNG proxy các path nội bộ /livequery/* — nếu không khớp route thì 404 (tránh
    // đẩy nhầm lên chatgpt.com rồi trả binary 200 gây hiểu nhầm "đã xử lý").
    if (reqUrl.pathname.startsWith("/livequery/")) {
      return c.json(
        { error: { message: `LiveQuery route not found: ${req.method} ${reqUrl.pathname}`, type: "not_found" } },
        404
      );
    }
    const fallback = await this.unsupportedRoutes.proxyUnsupportedRoute(req);
    const url = new URL(req.url);

    console.warn(
      fallback.logEntry.proxied
        ? `[server] Fallback → ${fallback.logEntry.matchedTarget} (${fallback.logEntry.responseStatus})`
        : `[server] Unhandled: ${req.method} ${c.req.path}`
    );

    const fbEntry = {
      type: "request", timestamp: fallback.logEntry.timestamp, method: req.method,
      path: c.req.path + url.search, status: fallback.logEntry.responseStatus ?? 404,
      latencyMs: 0, email: "", unhandled: true,
      proxied: fallback.logEntry.proxied, target: fallback.logEntry.matchedTarget ?? "",
    };
    this.broadcast.broadcastLog(fbEntry);
    this.logger.logRequest({ ...fbEntry, timestamp: fbEntry.timestamp });

    if (fallback.response) return fallback.response;
    return c.json(
      { error: { message: `Unhandled route: ${req.method} ${c.req.path}${url.search}`, type: "proxy_error", log_file: this.unsupportedRoutes.getLogPath() } },
      404
    );
  }
}
