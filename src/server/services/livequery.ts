import {
  LivequeryRequestParser,
  type LivequeryContext,
} from "@livequery/core";
import type { Account } from "../schemas";
import {
  getAccounts,
  refreshCodexUsageForAccounts,
  removeAccount,
  setSelectedAccount,
} from "./accounts";
import {
  cancelLoginFlow,
  importAccountInput,
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
import { type Subscription, type Observable } from "rxjs";
import {
  fetchHosts, fetchProjects, fetchChats, fetchTurns,
  createTask, cancelTask, archiveTask, recoverTask, markTaskRead,
  type HostItem, type ProjectItem, type ChatItem, type TurnItem,
} from "./codex-api";
import { createOrGetSseStream, getActiveStream, type SseEvent } from "./sse-stream";
import type { SseRequestParams } from "../schemas/sse";
import { startLocalTurn, cancelLocalTurn } from "../libs/local-thread";
import { fetchRemoteProjects } from "./remote-control";

export type ReportDocument = {
  id: string;
  timestamp: number;
  type: string;
  [key: string]: unknown;
};

export type AccountDocument = Omit<Account, "accessToken" | "refreshToken" | "idToken">;

export type HostDocument = HostItem & { account_id: string };
export type ProjectDocument = ProjectItem & { account_id: string };
export type ChatDocument = ChatItem & { account_id: string };
export type TurnDocument = TurnItem & { account_id: string; chat_id: string };

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

// ─── Caches for hosts / projects / chats ─────────────────────────────────────
const hostsCache = new Map<string, HostDocument[]>();
const hostsFetchedAt = new Map<string, number>();
const hostsRefreshing = new Set<string>();

const projectsCacheState = { items: [] as ProjectItem[], fetchedAt: 0 };
let projectsRefreshing = false;

const chatsCache = new Map<string, ChatDocument[]>();
const chatsFetchedAt = new Map<string, number>();
const chatsRefreshing = new Set<string>();

const HOSTS_TTL_MS = 30_000;
const PROJECTS_TTL_MS = 60_000;
const CHATS_TTL_MS = 60_000;

// ─── SSE subscription registry (one per active chat, shared across WS clients) ─

const activeSseSubscriptions = new Map<string, Subscription>();
const latestResponseIds = new Map<string, string>(); // chatId → last SSE responseId for continuity
const pendingInputs = new Map<string, SseRequestParams>(); // chatId → params waiting for turns endpoint

// Local Desktop App chats (selfhost: prefix)
type LocalChatEntry = { accountId: string; hostId: string; conversationId: string; cwd?: string; title?: string };
const localChats = new Map<string, LocalChatEntry>(); // chatId → entry
const localStreams = new Map<string, Observable<SseEvent>>(); // "accountId:chatId" → stream

// ─── Environment ID parsing ───────────────────────────────────────────────────

function parseEnvId(raw?: string): { kind: "selfhost" | "cloud" | "none"; envId: string } {
  if (!raw) return { kind: "none", envId: "" };
  if (raw.startsWith("selfhost:")) return { kind: "selfhost", envId: raw.slice(9) };
  if (raw.startsWith("cloud:")) return { kind: "cloud", envId: raw.slice(6) };
  return { kind: "cloud", envId: raw };
}

function subscribeToSseStream(accountId: string, chatId: string, observable: ReturnType<typeof getActiveStream>) {
  if (!observable) return;
  const key = `${accountId}:${chatId}`;
  if (activeSseSubscriptions.has(key)) return; // already subscribed

  const sub = observable.subscribe({
    next: (event: SseEvent) => {
      if (event.type === "error") return;

      if (event.type === "completed" && event.responseId) {
        latestResponseIds.set(chatId, event.responseId);
      }

      const turnDoc: TurnDocument = {
        id: "turnId" in event ? event.turnId : chatId,
        type: "assistant",
        role: "assistant",
        input_items: [],
        output_items: event.type === "completed"
          ? (event.outputItems.length > 0 ? event.outputItems : [{ type: "text", text: event.text }])
          : [{ type: "text", text: event.type === "delta" ? event.accumulated : event.text }],
        status: event.type === "completed" ? "completed" : "in_progress",
        account_id: accountId,
        chat_id: chatId,
      };

      publishRealtimeChanges([{
        ref: `accounts/${accountId}/chats/${chatId}/turns`,
        type: "modified",
        data: turnDoc as unknown as Record<string, unknown>,
      }]);
    },
    error: (err: unknown) => {
      activeSseSubscriptions.delete(key);
      addReport({ type: "sse_error", accountId, chatId, error: String(err), timestamp: Date.now() });
    },
    complete: () => {
      activeSseSubscriptions.delete(key);
      refreshChatsInBackground(accountId, {}, true);
    },
  });

  activeSseSubscriptions.set(key, sub);
}

function cancelSseStream(key: string) {
  activeSseSubscriptions.get(key)?.unsubscribe();
  activeSseSubscriptions.delete(key);
}

function notifyHostsChanged(accountId: string) {
  const items = hostsCache.get(accountId) ?? [];
  publishRealtimeChanges(
    items.map((item) => ({ ref: `accounts/${accountId}/hosts`, type: "modified" as const, data: item }))
  );
}

function notifyProjectsChanged(accountId: string, items: ProjectDocument[]) {
  publishRealtimeChanges(
    items.map((item) => ({ ref: `accounts/${accountId}/projects`, type: "modified" as const, data: item }))
  );
}

function notifyChatsChanged(accountId: string) {
  const items = chatsCache.get(accountId) ?? [];
  publishRealtimeChanges(
    items.map((item) => ({ ref: `accounts/${accountId}/chats`, type: "modified" as const, data: item }))
  );
}

function refreshHostsInBackground(accountId: string, force = false) {
  if (hostsRefreshing.has(accountId)) return;
  if (!force && Date.now() - (hostsFetchedAt.get(accountId) ?? 0) < HOSTS_TTL_MS) return;
  hostsRefreshing.add(accountId);
  const account = getAccounts().find((a) => a.id === accountId);
  if (!account) { hostsRefreshing.delete(accountId); return; }
  fetchHosts(account)
    .then((items) => {
      const docs: HostDocument[] = items.map((h) => ({ ...h, account_id: accountId }));
      hostsCache.set(accountId, docs);
      hostsFetchedAt.set(accountId, Date.now());
      notifyHostsChanged(accountId);
    })
    .catch(() => {})
    .finally(() => hostsRefreshing.delete(accountId));
}

function refreshProjectsInBackground(force = false) {
  if (projectsRefreshing) return;
  if (!force && Date.now() - projectsCacheState.fetchedAt < PROJECTS_TTL_MS) return;
  projectsRefreshing = true;
  fetchProjects()
    .then((items) => {
      projectsCacheState.items = items;
      projectsCacheState.fetchedAt = Date.now();
    })
    .catch(() => {})
    .finally(() => { projectsRefreshing = false; });
}

function refreshChatsInBackground(accountId: string, params: { taskFilter?: string; envId?: string } = {}, force = false) {
  if (chatsRefreshing.has(accountId)) return;
  if (!force && Date.now() - (chatsFetchedAt.get(accountId) ?? 0) < CHATS_TTL_MS) return;
  chatsRefreshing.add(accountId);
  const account = getAccounts().find((a) => a.id === accountId);
  if (!account) { chatsRefreshing.delete(accountId); return; }
  fetchChats(account, params)
    .then((items) => {
      const docs: ChatDocument[] = items.map((c) => ({ ...c, account_id: accountId }));
      chatsCache.set(accountId, docs);
      chatsFetchedAt.set(accountId, Date.now());
      notifyChatsChanged(accountId);
    })
    .catch(() => {})
    .finally(() => chatsRefreshing.delete(accountId));
}

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
  if (parts.length === 5 && collection === "accounts") {
    // /livequery/accounts/:account_id/chats/:chat_id/turns
    if (parts[2] === "chats" && parts[4] === "turns") {
      return `${LIVEQUERY_PATH_PREFIX}/accounts/:account_id/chats/:chat_id/turns`;
    }
    // /livequery/accounts/:account_id/hosts/:host_id/projects|chats
    if (parts[2] === "hosts") {
      return `${LIVEQUERY_PATH_PREFIX}/accounts/:account_id/hosts/:host_id/${parts[4]}`;
    }
  }
  // /livequery/accounts/:account_id/<sub>
  if (parts.length === 3 && collection === "accounts") {
    return `${LIVEQUERY_PATH_PREFIX}/accounts/:account_id/${parts[2]}`;
  }
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

// ─── Hosts / Projects / Chats collection handlers ─────────────────────────────

function handleHosts(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Hosts collection only supports GET", 405);
  }
  const accountId = String(ctx.livequery?.keys?.account_id ?? "");
  if (!accountId) return error("BAD_REQUEST", "Missing account_id", 400);
  refreshHostsInBackground(accountId);
  const items = hostsCache.get(accountId) ?? [];
  return json({ data: collectionResponse(items, { collection: "hosts", account_id: accountId }) });
}

function handleProjectsCollection(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Projects collection only supports GET", 405);
  }
  const accountId = String(ctx.livequery?.keys?.account_id ?? "");
  if (!accountId) return error("BAD_REQUEST", "Missing account_id", 400);
  refreshProjectsInBackground();

  // Filter by account's known host ids, fall back to all projects when hosts not yet cached
  const accountHosts = hostsCache.get(accountId);
  let items: ProjectDocument[];
  if (accountHosts && accountHosts.length > 0) {
    const envIds = new Set(accountHosts.map((h) => `remote-control:${h.env_id}`));
    items = projectsCacheState.items
      .filter((p) => envIds.has(p.hostId))
      .map((p) => ({ ...p, account_id: accountId }));
  } else {
    items = projectsCacheState.items.map((p) => ({ ...p, account_id: accountId }));
  }
  // Trigger host refresh so next call can filter more precisely
  if (!accountHosts) refreshHostsInBackground(accountId);
  return json({ data: collectionResponse(items, { collection: "projects", account_id: accountId }) });
}

function handleChats(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Chats collection only supports GET", 405);
  }
  const accountId = String(ctx.livequery?.keys?.account_id ?? "");
  if (!accountId) return error("BAD_REQUEST", "Missing account_id", 400);
  const taskFilter = String(ctx.livequery?.query?.task_filter ?? "current");
  refreshChatsInBackground(accountId, { taskFilter });
  const items = chatsCache.get(accountId) ?? [];
  return json({ data: collectionResponse(items, { collection: "chats", account_id: accountId }) });
}

function handleHostProjects(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }
  const accountId = String(ctx.livequery?.keys?.account_id ?? "");
  const hostId = String(ctx.livequery?.keys?.host_id ?? "");
  if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id", 400);
  refreshProjectsInBackground();
  const items = projectsCacheState.items
    .filter((p) => p.hostId === hostId || p.hostId.endsWith(`:${hostId}`))
    .map((p) => ({ ...p, account_id: accountId }));
  return json({ data: collectionResponse(items, { collection: "projects", account_id: accountId, host_id: hostId }) });
}

function handleHostChats(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Method not allowed", 405);
  }
  const accountId = String(ctx.livequery?.keys?.account_id ?? "");
  const hostId = String(ctx.livequery?.keys?.host_id ?? "");
  if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id", 400);
  const taskFilter = String(ctx.livequery?.query?.task_filter ?? "current");
  refreshChatsInBackground(accountId, { taskFilter, envId: hostId });
  const cached = chatsCache.get(accountId) ?? [];
  const cloudItems = cached.filter((c) => c.environment_id === hostId);
  const localItems: ChatDocument[] = [];
  for (const [chatId, entry] of localChats.entries()) {
    if (entry.accountId === accountId && entry.hostId === hostId) {
      localItems.push({
        id: chatId,
        title: entry.title ?? entry.cwd ?? "New conversation",
        status: "active",
        environment_id: `selfhost:${hostId}`,
        workspace_root: entry.cwd,
        account_id: accountId,
      } as unknown as ChatDocument);
    }
  }
  const items = [...cloudItems, ...localItems];
  return json({ data: collectionResponse(items, { collection: "chats", account_id: accountId, host_id: hostId }) });
}

async function handleTurns(ctx: LivequeryContext): Promise<Response> {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Turns collection only supports GET", 405);
  }
  const accountId = String(ctx.livequery?.keys?.account_id ?? "");
  const chatId = String(ctx.livequery?.keys?.chat_id ?? "");
  if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id", 400);
  const account = getAccounts().find((a) => a.id === accountId);
  if (!account) return error("NOT_FOUND", "Account not found", 404);

  // ── Local Desktop App chat ────────────────────────────────────────────────
  const localChat = localChats.get(chatId);
  if (localChat) {
    const streamKey = `${accountId}:${chatId}`;
    const pending = pendingInputs.get(chatId);
    if (pending) {
      pendingInputs.delete(chatId);
      const inputText = Array.isArray(pending.input)
        ? String((pending.input[0] as Record<string, unknown>)?.content ?? "")
        : String(pending.input ?? "");
      const stream$ = startLocalTurn(account, localChat.hostId, {
        input: inputText,
        conversationId: localChat.conversationId,
        chatId,
        cwd: localChat.cwd,
      });
      localStreams.set(streamKey, stream$);
      subscribeToSseStream(accountId, chatId, stream$);
    } else {
      const existing = localStreams.get(streamKey);
      if (existing) subscribeToSseStream(accountId, chatId, existing);
    }
    return json({ data: collectionResponse([], { collection: "turns", account_id: accountId, chat_id: chatId }) });
  }

  // ── Cloud WHAM chat ────────────────────────────────────────────────────────
  try {
    const { turns, current_turn_id } = await fetchTurns(account, chatId);
    const docs: TurnDocument[] = turns.map((t) => ({ ...t, account_id: accountId, chat_id: chatId }));

    const pending = pendingInputs.get(chatId);
    if (pending) {
      pendingInputs.delete(chatId);
      const stream$ = createOrGetSseStream(account, chatId, pending);
      subscribeToSseStream(accountId, chatId, stream$);
    } else {
      const existing = getActiveStream(`${accountId}:${chatId}`);
      if (existing) subscribeToSseStream(accountId, chatId, existing);
    }

    return json({ data: collectionResponse(docs, { collection: "turns", account_id: accountId, chat_id: chatId, current_turn_id }) });
  } catch (err) {
    return error("UPSTREAM_ERROR", String(err), 502);
  }
}

function handleReports(ctx: LivequeryContext): Response {
  if (ctx.request.method !== "GET") {
    return error("METHOD_NOT_ALLOWED", "Reports collection only supports GET", 405);
  }
  const limit = Number(ctx.livequery?.query[":limit"] ?? REPORT_LIMIT);
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(REPORT_LIMIT, Math.floor(limit))) : REPORT_LIMIT;
  return json({ data: collectionResponse(reports.slice(0, boundedLimit), reportsSummary()) });
}

type ActionPathParams = { accountId: string; chatId: string; hostId: string };

function extractActionPathParams(pathname: string): ActionPathParams {
  const pathBeforeAction = pathname.split("/~")[0] ?? "";
  const parts = pathBeforeAction.replace(/^\/livequery\/?/, "").split("/").filter(Boolean);
  const isAccounts = parts[0] === "accounts";
  return {
    accountId: isAccounts && parts.length >= 2 ? (parts[1] ?? "") : "",
    chatId: isAccounts && parts[2] === "chats" && parts.length >= 4 ? (parts[3] ?? "") : "",
    hostId: isAccounts && parts[2] === "hosts" && parts.length >= 4 ? (parts[3] ?? "") : "",
  };
}

async function handleAction(action: string, ctx: LivequeryContext, openaiBaseUrl: string, restartCodex: () => Promise<void>, path: ActionPathParams) {
  const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
  const effectiveOpenaiBaseUrl = resolveOpenaiBaseUrl(payload.publicBaseUrl, openaiBaseUrl);

  if (action === "refresh-usage") {
    await refreshCodexUsageForAccounts(true);
    notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  if (action === "select-account") {
    const id = path.accountId || String(payload.id ?? "");
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
    const id = path.accountId || String(payload.id ?? "");
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
    const importInput =
      typeof payload.importInput === "string" ? payload.importInput.trim() :
      typeof payload.callbackUrl === "string" ? payload.callbackUrl.trim() :
      "";
    if (!importInput) return error("BAD_REQUEST", "Missing import input");
    const result = await importAccountInput(importInput);
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

  // ─── Chat mutations ──────────────────────────────────────────────────────────

  if (action === "create-chat") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const input = String(payload.input ?? "");
    const rawEnvId = typeof payload.environment_id === "string" ? payload.environment_id : undefined;
    const modelSlug = typeof payload.model_slug === "string" ? payload.model_slug : "gpt-5.5";
    if (!accountId || !input) return error("BAD_REQUEST", "Missing account_id or input");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const { kind, envId } = parseEnvId(rawEnvId);

    // ── Local Desktop App chat ──
    if (kind === "selfhost") {
      const conversationId = crypto.randomUUID();
      const chatId = conversationId;
      const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
      const title = typeof payload.title === "string" ? payload.title : input.slice(0, 60);
      localChats.set(chatId, { accountId, hostId: envId, conversationId, cwd, title });
      pendingInputs.set(chatId, { input: [{ role: "user", content: input }], environmentId: `selfhost:${envId}` });
      addReport({ type: "chat_created", accountId, chatId, local: true, hostId: envId, cwd, timestamp: Date.now() });
      return json({ data: { ok: true, chat_id: chatId } });
    }

    // ── Cloud WHAM chat ──
    try {
      const task = await createTask(account, {
        input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text: input }] }],
        environment_id: kind === "none" ? undefined : envId,
        model_slug: modelSlug,
      });
      const chatId = task.task_id;
      if (!chatId) return error("UPSTREAM_ERROR", "Task created without ID", 502);
      pendingInputs.set(chatId, { input: [{ role: "user", content: input }], environmentId: envId || undefined });
      refreshChatsInBackground(accountId, {}, true);
      addReport({ type: "chat_created", accountId, chatId, timestamp: Date.now() });
      return json({ data: { ok: true, chat_id: chatId } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  if (action === "send-message") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const chatId = path.chatId || String(payload.chat_id ?? "");
    const input = String(payload.input ?? "");
    const rawEnvId = typeof payload.environment_id === "string" ? payload.environment_id : undefined;
    if (!accountId || !chatId || !input) return error("BAD_REQUEST", "Missing account_id, chat_id or input");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const localChat = localChats.get(chatId);
    if (localChat) {
      // Cancel any in-progress local stream before starting a new turn
      const streamKey = `${accountId}:${chatId}`;
      activeSseSubscriptions.get(streamKey)?.unsubscribe();
      activeSseSubscriptions.delete(streamKey);
      localStreams.delete(streamKey);
      pendingInputs.set(chatId, { input: [{ role: "user", content: input }], environmentId: `selfhost:${localChat.hostId}` });
      return json({ data: { ok: true, chat_id: chatId } });
    }

    // Cloud WHAM
    const { envId } = parseEnvId(rawEnvId);
    const previousResponseId = latestResponseIds.get(chatId);
    pendingInputs.set(chatId, { input: [{ role: "user", content: input }], previousResponseId, environmentId: envId || undefined });
    return json({ data: { ok: true, chat_id: chatId } });
  }

  if (action === "cancel-chat") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const chatId = path.chatId || String(payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const localChat = localChats.get(chatId);
    if (localChat) {
      try {
        await cancelLocalTurn(account, localChat.hostId, localChat.conversationId);
      } catch {
        // best-effort cancel
      }
      const streamKey = `${accountId}:${chatId}`;
      cancelSseStream(streamKey);
      localStreams.delete(streamKey);
      return json({ data: { ok: true } });
    }

    try {
      await cancelTask(account, chatId);
      cancelSseStream(`${accountId}:${chatId}`);
      refreshChatsInBackground(accountId, {}, true);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  if (action === "archive-chat") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const chatId = path.chatId || String(payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      await archiveTask(account, chatId);
      refreshChatsInBackground(accountId, {}, true);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  if (action === "recover-chat") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const chatId = path.chatId || String(payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      await recoverTask(account, chatId);
      refreshChatsInBackground(accountId, {}, true);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  if (action === "mark-read") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const chatId = path.chatId || String(payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      await markTaskRead(account, chatId);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  if (action === "refresh-hosts") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id");
    hostsFetchedAt.delete(accountId);
    refreshHostsInBackground(accountId, true);
    return json({ data: { ok: true } });
  }

  if (action === "refresh-projects") {
    projectsCacheState.fetchedAt = 0;
    refreshProjectsInBackground(true);
    return json({ data: { ok: true } });
  }

  if (action === "refresh-chats") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id");
    chatsFetchedAt.delete(accountId);
    refreshChatsInBackground(accountId, {}, true);
    return json({ data: { ok: true } });
  }

  if (action === "workspace-options") {
    const accountId = path.accountId || String(payload.account_id ?? "");
    const hostId = path.hostId || String(payload.host_id ?? "");
    if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id");
    const account = getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      const projects = await fetchRemoteProjects(account, hostId);
      return json({ data: { ok: true, options: projects.map((p) => ({ path: p.remotePath, label: p.label })) } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
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
  const schemaCollection = ctx.livequery?.schema_collection_ref;
  const action = getAction(new URL(req.url).pathname);

  if (action) {
    const pathParams = extractActionPathParams(new URL(req.url).pathname);
    return handleAction(action, ctx, options.openaiBaseUrl, options.restartCodex, pathParams);
  }

  // Manually inject path keys — parser doesn't reliably resolve nested params
  const pathParts = new URL(req.url).pathname.replace(/^\/livequery\/?/, "").split("/").filter(Boolean);
  if (pathParts[0] === "accounts" && pathParts.length >= 3) {
    const [, accountId, sub, subId, leaf] = pathParts;
    if (ctx.livequery) ctx.livequery.keys = { ...ctx.livequery.keys, account_id: accountId };

    if (pathParts.length === 3) {
      if (sub === "hosts")    return handleHosts(ctx);
      if (sub === "projects") return handleProjectsCollection(ctx);
      if (sub === "chats")    return handleChats(ctx);
    }
    if (pathParts.length === 5) {
      if (sub === "chats" && leaf === "turns") {
        if (ctx.livequery) ctx.livequery.keys = { ...ctx.livequery.keys, chat_id: subId };
        return handleTurns(ctx);
      }
      if (sub === "hosts" && leaf === "projects") {
        if (ctx.livequery) ctx.livequery.keys = { ...ctx.livequery.keys, host_id: subId };
        return handleHostProjects(ctx);
      }
      if (sub === "hosts" && leaf === "chats") {
        if (ctx.livequery) ctx.livequery.keys = { ...ctx.livequery.keys, host_id: subId };
        return handleHostChats(ctx);
      }
    }
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
  for (const key of activeSseSubscriptions.keys()) cancelSseStream(key);
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
