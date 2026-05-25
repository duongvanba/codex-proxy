import {
  LivequeryRequestParser,
  type LivequeryContext,
} from "@livequery/core";
import type { Account } from "./types";
import {
  getAccounts,
  refreshCodexUsageForAccounts,
  removeAccount,
  setSelectedAccount,
} from "./accounts";
import {
  cancelLoginFlow,
  importCallbackUrl,
  isLoginInProgress,
  startLoginFlow,
} from "./login-flow";
import {
  isCodexConfigPatched,
  patchCodexConfig,
  restoreCodexConfig,
  saveProxyState,
} from "./config-patcher";
import { logEvent } from "./logger";

export type ReportDocument = {
  id: string;
  timestamp: number;
  type: string;
  [key: string]: unknown;
};

export type AccountDocument = Omit<Account, "accessToken" | "refreshToken" | "idToken">;

type LivequeryResult<T> =
  | { data: T }
  | { error: { code: string; message: string } };

type LivequeryCollectionResponse<T extends { id: string }> = {
  items: T[];
  summary?: Record<string, unknown>;
  count: { prev: number; next: number; total: number; current: number };
  has: { prev: boolean; next: boolean };
  cursor: { first: string; last: string };
};

const REPORT_LIMIT = 250;
const LIVEQUERY_PATH_PREFIX = "/livequery";
export const LIVEQUERY_SOCKET_PATH = "/livequery/realtime-updates";
const parser = new LivequeryRequestParser();
const reports: ReportDocument[] = [];
const realtimeGatewayId = crypto.randomUUID();
const realtimeClients = new Map<string, { send: (data: string) => void; refs: Set<string> }>();
const realtimeRefs = new Map<string, Set<string>>();
let accountsUsageRefresh: Promise<void> | null = null;
let knownAccountIds = new Set(getAccounts().map((a) => a.id));

function json<T>(payload: LivequeryResult<T>, init?: ResponseInit): Response {
  return Response.json(payload, init);
}

export function collectionResponse<T extends { id: string }>(
  items: T[],
  summary: Record<string, unknown> = {}
): LivequeryCollectionResponse<T> {
  return {
    items,
    summary,
    count: {
      prev: 0,
      next: 0,
      total: items.length,
      current: items.length,
    },
    has: {
      prev: false,
      next: false,
    },
    cursor: {
      first: items[0]?.id ?? "",
      last: items[items.length - 1]?.id ?? "",
    },
  };
}

function error(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, { status });
}

function headersToMap(headers: Headers): Map<string, string> {
  return new Map(Array.from(headers.entries()));
}

async function bodyFromRequest(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const text = await req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function queryFromUrl(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const current = query[key];
    if (Array.isArray(current)) current.push(value);
    else if (current !== undefined) query[key] = [current, value];
    else query[key] = value;
  }
  return query;
}

async function parseContext(req: Request): Promise<LivequeryContext> {
  const url = new URL(req.url);
  const body = await bodyFromRequest(req);
  const ref = routeRef(url.pathname);
  const ctx: LivequeryContext = {
    request: {
      path: url.pathname,
      ref,
      method: req.method,
      body,
      params: {},
      query: queryFromUrl(url),
      headers: headersToMap(req.headers),
    },
  };
  parser.handle(ctx);
  registerLivequerySubscription(ctx);
  return ctx;
}

function routeRef(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  const actionless = normalized.split("/~")[0] ?? normalized;
  const rel = actionless.replace(/^\/livequery\/?/, "");
  const parts = rel.split("/").filter(Boolean);
  const collection = parts[0] ?? "";
  if (parts.length <= 1) return `${LIVEQUERY_PATH_PREFIX}/${collection}`;
  return `${LIVEQUERY_PATH_PREFIX}/${collection}/:id`;
}

function getAction(pathname: string): string | null {
  const marker = "/~";
  const index = pathname.indexOf(marker);
  if (index < 0) return null;
  return decodeURIComponent(pathname.slice(index + marker.length));
}

export function serializeAccount(account: Account, options: { pendingQuotaTimers?: boolean } = {}): AccountDocument {
  const { accessToken: _accessToken, refreshToken: _refreshToken, idToken: _idToken, ...safeAccount } = account;
  if (options.pendingQuotaTimers && safeAccount.codexUsage) {
    safeAccount.codexUsage = {
      ...safeAccount.codexUsage,
      primaryWindow: safeAccount.codexUsage.primaryWindow
        ? { ...safeAccount.codexUsage.primaryWindow, resetAfterSeconds: -1 }
        : undefined,
      secondaryWindow: safeAccount.codexUsage.secondaryWindow
        ? { ...safeAccount.codexUsage.secondaryWindow, resetAfterSeconds: -1 }
        : undefined,
    };
  }
  return safeAccount;
}

function registerLivequerySubscription(ctx: LivequeryContext) {
  if (!ctx.livequery?.ref) return;
  const clientId = ctx.request.headers.get("x-lcid") ?? ctx.request.headers.get("socket_id");
  if (!clientId) return;
  const client = realtimeClients.get(clientId);
  if (!client) return;
  client.refs.add(ctx.livequery.ref);
  let clients = realtimeRefs.get(ctx.livequery.ref);
  if (!clients) {
    clients = new Set();
    realtimeRefs.set(ctx.livequery.ref, clients);
  }
  clients.add(clientId);
}

type RealtimeChange = {
  ref: string;
  type: "added" | "modified" | "removed";
  data: Record<string, unknown>;
};

function publishRealtimeChanges(changes: RealtimeChange[]) {
  if (changes.length === 0) return;
  const targets = new Set([
    ...changes.flatMap((change) => [
      ...(realtimeRefs.get(change.ref) ?? []),
      ...(realtimeRefs.get(`${change.ref}/${change.data.id}`) ?? []),
    ]),
  ]);
  const message = JSON.stringify({
    event: "sync",
    data: {
      changes,
    },
  });
  for (const clientId of targets) {
    realtimeClients.get(clientId)?.send(message);
  }
}

function publishCollectionSnapshot(collection: "accounts" | "reports") {
  if (collection !== "accounts") {
    publishRealtimeChanges(reports.map((doc) => ({ ref: "reports", type: "modified" as const, data: doc })));
    return;
  }
  const accounts = getAccounts().map((account) => serializeAccount(account));
  const changes: RealtimeChange[] = accounts.map((doc) => ({
    ref: "accounts",
    type: knownAccountIds.has(doc.id) ? "modified" : "added",
    data: doc,
  }));
  knownAccountIds = new Set(accounts.map((a) => a.id));
  publishRealtimeChanges(changes);
}

function publishAccountRemoved(id: string) {
  publishRealtimeChanges([{ ref: "accounts", type: "removed", data: { id } }]);
}

export function addReport(entry: Omit<ReportDocument, "id"> & { id?: string }): ReportDocument {
  const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
  const report: ReportDocument = {
    ...entry,
    type: String(entry.type ?? "report"),
    id: entry.id ?? `${timestamp}-${crypto.randomUUID()}`,
    timestamp,
  };
  reports.unshift(report);
  if (reports.length > REPORT_LIMIT) reports.length = REPORT_LIMIT;
  publishRealtimeChanges([{ ref: "reports", type: "added", data: report }]);
  return report;
}

export function notifyAccountsChanged() {
  publishCollectionSnapshot("accounts");
}

function refreshAccountsUsageInBackground(force = false) {
  if (accountsUsageRefresh) return;
  accountsUsageRefresh = refreshCodexUsageForAccounts(force)
    .then(() => {
      notifyAccountsChanged();
      addReport({ type: "accounts_usage_refreshed", timestamp: Date.now() });
    })
    .catch((err) => {
      addReport({
        type: "accounts_usage_refresh_error",
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    })
    .finally(() => {
      accountsUsageRefresh = null;
    });
}

export function getLivequeryRealtimeUrl(publicBaseUrl: string): string {
  const publicUrl = new URL(publicBaseUrl);
  const scheme = publicUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${publicUrl.host}${LIVEQUERY_SOCKET_PATH}`;
}

function resolveOpenaiBaseUrl(publicBaseUrl: unknown, fallbackOpenaiBaseUrl: string) {
  if (typeof publicBaseUrl !== "string") return fallbackOpenaiBaseUrl;
  try {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallbackOpenaiBaseUrl;
    return `${url.origin}/v1`;
  } catch {
    return fallbackOpenaiBaseUrl;
  }
}

async function handleAccounts(ctx: LivequeryContext): Promise<Response> {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Accounts collection only supports GET", 405);
  }
  const accounts = getAccounts().map((account) => serializeAccount(account, { pendingQuotaTimers: true }));
  refreshAccountsUsageInBackground();
  return json({ data: collectionResponse(accounts, { collection: "accounts" }) });
}

function reportsSummary() {
  return {
    collection: "reports",
    total: reports.length,
    newestAt: reports[0]?.timestamp ?? null,
  };
}

function handleReports(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Reports collection only supports GET", 405);
  }
  const limit = Number(ctx.livequery?.query[":limit"] ?? REPORT_LIMIT);
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(REPORT_LIMIT, Math.floor(limit))) : REPORT_LIMIT;
  return json({ data: collectionResponse(reports.slice(0, boundedLimit), reportsSummary()) });
}

async function handleAction(action: string, ctx: LivequeryContext, openaiBaseUrl: string, restartCodex: () => Promise<void>) {
  const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
  const effectiveOpenaiBaseUrl = resolveOpenaiBaseUrl(payload.publicBaseUrl, openaiBaseUrl);

  if (action === "refresh-usage") {
    await refreshCodexUsageForAccounts(true);
    notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  if (action === "select-account") {
    const id = String(payload.id ?? "");
    if (!id) return error("BAD_REQUEST", "Missing account id");
    const result = setSelectedAccount(id);
    if (!result.ok) return error("BAD_REQUEST", result.error ?? "Could not select account");
    const account = getAccounts().find((a) => a.id === id);
    const email = account?.email ?? id;
    logEvent("account_selected", email);
    addReport({ type: "account_selected", email, timestamp: Date.now() });
    notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  if (action === "remove-account") {
    const id = String(payload.id ?? "");
    if (!id) return error("BAD_REQUEST", "Missing account id");
    const result = removeAccount(id);
    if (!result.ok) return error("BAD_REQUEST", result.error ?? "Could not remove account");
    logEvent("account_removed", id);
    addReport({ type: "account_removed", accountId: id, timestamp: Date.now() });
    publishAccountRemoved(id);
    notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  if (action === "login-status") {
    return json({ data: { inProgress: isLoginInProgress() } });
  }

  if (action === "start-login") {
    const sendLoginEvent = (entry: object) => {
      addReport({ ...(entry as Record<string, unknown>), timestamp: Date.now(), type: String((entry as any).type ?? "login_event") });
    };
    const result = startLoginFlow(
      (email) => {
        logEvent("login_success", email);
        addReport({ type: "login_success", email, timestamp: Date.now() });
        notifyAccountsChanged();
      },
      (err) => {
        logEvent("login_error", err);
        addReport({ type: "login_error", error: err, timestamp: Date.now() });
      },
      sendLoginEvent
    );
    if (!result.ok) return error("CONFLICT", result.error, 409);
    logEvent("login_started", "callback port=1455");
    addReport({ type: "login_started", timestamp: Date.now() });
    return json({ data: { ok: true, authorizeUrl: result.authorizeUrl } });
  }

  if (action === "cancel-login") {
    const cancelled = cancelLoginFlow("cancelled from Web UI");
    if (cancelled) addReport({ type: "login_cancelled", timestamp: Date.now() });
    return json({ data: { ok: true, cancelled, inProgress: isLoginInProgress() } });
  }

  if (action === "import-callback") {
    const callbackUrl = typeof payload.callbackUrl === "string" ? payload.callbackUrl.trim() : "";
    if (!callbackUrl) return error("BAD_REQUEST", "Missing callbackUrl");
    const result = await importCallbackUrl(callbackUrl);
    if (!result.ok) {
      const message = result.error ?? "Import callback failed";
      logEvent("login_import_error", message);
      addReport({ type: "login_import_error", error: message, timestamp: Date.now() });
      return error("BAD_REQUEST", message);
    }
    notifyAccountsChanged();
    return json({ data: { ok: true, email: result.email } });
  }

  if (action === "config-status") {
    return json({ data: { enabled: isCodexConfigPatched(effectiveOpenaiBaseUrl) } });
  }

  if (action === "set-config") {
    const enabled = Boolean(payload.enabled);
    const shouldRestartCodex = Boolean(payload.restartCodex);
    if (enabled) patchCodexConfig(effectiveOpenaiBaseUrl);
    else restoreCodexConfig();
    saveProxyState(enabled);
    if (shouldRestartCodex) await restartCodex();
    const state = isCodexConfigPatched(effectiveOpenaiBaseUrl);
    logEvent("config_proxy", state ? "enabled" : "disabled");
    addReport({ type: "config_proxy", enabled: state, restarted: shouldRestartCodex, timestamp: Date.now() });
    return json({ data: { ok: true, enabled: state, restarted: shouldRestartCodex } });
  }

  return error("ACTION_NOT_FOUND", `Unknown LiveQuery action: ${action}`, 404);
}

export async function handleLivequeryRequest(
  req: Request,
  options: {
    openaiBaseUrl: string;
    publicBaseUrl: string;
    restartCodex: () => Promise<void>;
  }
): Promise<Response> {
  const ctx = await parseContext(req);
  const collection = ctx.livequery?.collection_ref;
  const action = getAction(new URL(req.url).pathname);

  if (action) {
    return handleAction(action, ctx, options.openaiBaseUrl, options.restartCodex);
  }

  if (collection === "accounts") return handleAccounts(ctx);
  if (collection === "reports") return handleReports(ctx);
  if (collection === "config") {
    return json({ data: { item: { id: "status", enabled: isCodexConfigPatched(options.openaiBaseUrl) } } });
  }
  if (collection === "session") {
    return json({ data: { item: { id: "login", inProgress: isLoginInProgress() } } });
  }
  if (collection === "runtime") {
    return json({
      data: {
        item: {
          id: "runtime",
          realtimeUrl: getLivequeryRealtimeUrl(options.publicBaseUrl),
        },
      },
    });
  }

  return error("COLLECTION_NOT_FOUND", `Unknown LiveQuery collection: ${collection ?? "unknown"}`, 404);
}

export function closeLivequery() {
  realtimeClients.clear();
  realtimeRefs.clear();
}

export function getLivequeryHealth(openaiBaseUrl: string) {
  const accounts = getAccounts();
  return {
    ok: true,
    openaiBaseUrl,
    accountCount: accounts.length,
    activeAccountCount: accounts.filter((account) => account.status === "active").length,
    selectedAccount: accounts.find((account) => account.selected)?.email ?? null,
    configInstalled: isCodexConfigPatched(openaiBaseUrl),
    realtimeClientCount: realtimeClients.size,
    realtimeSubscriptionCount: Array.from(realtimeRefs.values()).reduce((sum, clients) => sum + clients.size, 0),
    reportsCount: reports.length,
    usageRefreshRunning: Boolean(accountsUsageRefresh),
    timestamp: Date.now(),
  };
}

export function openLivequerySocket(ws: {
  send(data: string): void;
  data: { livequeryClientId?: string; livequeryRefs?: Set<string> };
}) {
  ws.data.livequeryRefs = new Set();
}

export function messageLivequerySocket(
  ws: {
    send(data: string): void;
    close(): void;
    data: { livequeryClientId?: string; livequeryRefs?: Set<string> };
  },
  message: string | Buffer
) {
  if (typeof message !== "string") return;
  let event: any;
  try {
    event = JSON.parse(message);
  } catch {
    return;
  }

  if (event.event === "start") {
    const clientId = String(event.data?.id ?? "");
    if (!clientId) {
      ws.close();
      return;
    }
    ws.data.livequeryClientId = clientId;
    ws.data.livequeryRefs = new Set();
    realtimeClients.set(clientId, {
      send: (data) => ws.send(data),
      refs: ws.data.livequeryRefs,
    });
    ws.send(JSON.stringify({ event: "hello", gid: realtimeGatewayId, binary: false }));
    return;
  }

  if (event.event === "unsubscribe") {
    const clientId = ws.data.livequeryClientId;
    if (!clientId) return;
    const refs = [
      ...event.data?.ref ? [String(event.data.ref)] : [],
      ...Array.isArray(event.data?.refs) ? event.data.refs.map(String) : [],
    ];
    for (const ref of refs) {
      ws.data.livequeryRefs?.delete(ref);
      realtimeRefs.get(ref)?.delete(clientId);
      if (realtimeRefs.get(ref)?.size === 0) realtimeRefs.delete(ref);
    }
  }
}

export function closeLivequerySocket(ws: { data: { livequeryClientId?: string; livequeryRefs?: Set<string> } }) {
  const clientId = ws.data.livequeryClientId;
  if (!clientId) return;
  for (const ref of ws.data.livequeryRefs ?? []) {
    realtimeRefs.get(ref)?.delete(clientId);
    if (realtimeRefs.get(ref)?.size === 0) realtimeRefs.delete(ref);
  }
  realtimeClients.delete(clientId);
}
