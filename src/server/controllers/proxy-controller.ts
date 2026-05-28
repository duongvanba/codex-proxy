import { Hono } from "hono";
import { proxyRequest } from "../services/proxy";
import { broadcastLog } from "../services/broadcast";
import { logRequest, logEvent } from "../services/logger";
import { notifyAccountsChanged } from "../services/livequery";
import { proxyUnsupportedRoute, getUnsupportedRoutesLogPath } from "../services/unsupported-routes";

async function handleProxyRoute(c: any) {
  const req = c.req.raw;
  const start = Date.now();
  const { response, meta } = await proxyRequest(
    req,
    (streamError) => {
      const entry = {
        type: "stream_error", timestamp: Date.now(), method: req.method, path: c.req.path,
        status: streamError.status, latencyMs: Date.now() - start, email: streamError.email,
        error: "stream_error", errorSnippet: streamError.errorSnippet,
      };
      broadcastLog(entry);
      logRequest(entry);
    },
    (streamUsage) => {
      const entry = {
        type: "token_usage", timestamp: Date.now(), method: req.method, path: c.req.path,
        status: streamUsage.status, latencyMs: Date.now() - start, email: streamUsage.email,
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
    type: "request", timestamp: Date.now(), method: req.method, path: c.req.path,
    status: response.status, latencyMs, email: meta.email,
  };
  if (meta.errorSnippet)    logEntry.errorSnippet    = meta.errorSnippet;
  if (meta.accountSwitched) logEntry.accountSwitched = meta.accountSwitched;
  broadcastLog(logEntry);
  logRequest({ timestamp: Date.now(), method: req.method, path: c.req.path, status: response.status, latencyMs, email: meta.email, errorSnippet: meta.errorSnippet, accountSwitched: meta.accountSwitched });
  if (meta.accountSwitched && !meta.accountSwitchBroadcasted) {
    const sw = meta.accountSwitched;
    logEvent("account_switched", `${sw.from} → ${sw.to} [${sw.reason}]`);
    broadcastLog({ type: "account_switched", ...sw, timestamp: Date.now() });
    notifyAccountsChanged();
  }
  return response;
}

export function createProxyController() {
  const app = new Hono();

  app.all("/v1/*", handleProxyRoute);
  app.all("/backend-api/*", handleProxyRoute);

  app.all("*", async (c) => {
    const req = c.req.raw;
    const fallback = await proxyUnsupportedRoute(req);
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
    broadcastLog(fbEntry);
    logRequest({ ...fbEntry, timestamp: fbEntry.timestamp });
    if (fallback.response) return fallback.response;
    return c.json(
      { error: { message: `Unhandled route: ${req.method} ${c.req.path}${url.search}`, type: "proxy_error", log_file: getUnsupportedRoutesLogPath() } },
      404
    );
  });

  return app;
}
