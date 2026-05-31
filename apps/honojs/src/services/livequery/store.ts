import { WebsocketGateway } from "@livequery/core";
import type { Subscription } from "rxjs";
import type { Account } from "../../schemas";
import type { AccountsService } from "../accounts";
import type { SseRequestParams } from "../../schemas/sse";
import type { CodexApiService, ProjectItem } from "../../libs/chatgpt";
import type { RemoteControlRegistry, RemoteChat, WebsocketRelay } from "../../libs/codex-remote-control";
import { mapThreadStatus } from "../../libs/codex-remote-control";
import type { EnrollmentService } from "../../libs/openai";
import type { ConfigPatcherService } from "../config-patcher";
import {
  REPORT_LIMIT, HOSTS_TTL_MS, PROJECTS_TTL_MS, CHATS_TTL_MS,
  serializeAccount,
  type ReportDocument, type RealtimeChange, type HostDocument, type ProjectDocument,
  type ChatDocument, type TurnDocument, type LocalChatEntry,
} from "./types";

/**
 * Kernel chia sẻ giữa các LiveQuery controller: state + cache + gateway/publish + reports +
 * realtime stream (relay → token-by-token) + background refresh. Mọi controller nhận CHUNG
 * một instance này; phần logic HTTP handler/action nằm trong từng controller.
 */
export class LivequeryStore {
  constructor(
    private readonly accounts: AccountsService,
    private readonly codexApi: CodexApiService,
    private readonly registry: RemoteControlRegistry,
    private readonly enrollment: EnrollmentService,
    private readonly configPatcher: ConfigPatcherService
  ) {
    this.knownAccountIds = new Set(this.accounts.getAccounts().map((a) => a.id));
  }

  private gateway: WebsocketGateway | null = null;
  private knownAccountIds: Set<string>;
  private accountsUsageRefresh: Promise<void> | null = null;

  readonly reports: ReportDocument[] = [];

  // Caches
  readonly hostsCache = new Map<string, HostDocument[]>();
  private readonly hostsFetchedAt = new Map<string, number>();
  private readonly hostsRefreshing = new Set<string>();
  readonly chatsCache = new Map<string, ChatDocument[]>();
  private readonly chatsFetchedAt = new Map<string, number>();
  private readonly chatsRefreshing = new Set<string>();
  readonly hostChatsCache = new Map<string, ChatDocument[]>();
  readonly hostChatsFetchedAt = new Map<string, number>();
  private readonly hostChatsRefreshing = new Set<string>();
  readonly projectsCacheState = { items: [] as ProjectItem[], fetchedAt: 0 };
  private projectsRefreshing = false;
  readonly hostProjectsCache = new Map<string, ProjectDocument[]>();
  private readonly hostProjectsFetchedAt = new Map<string, number>();
  private readonly hostProjectsRefreshing = new Set<string>();

  // Realtime host-scoped tracking
  private readonly activeHostChats = new Map<string, Set<string>>();
  private readonly activeHostProjects = new Map<string, Set<string>>();
  readonly chatHostId = new Map<string, string>();

  // Central event$ → livequery publish state (1 subscription/account, demux theo envId/threadId)
  private readonly hookedRelays = new Set<string>();              // accountId đã gắn event$ subscription
  private readonly knownThreads = new Map<string, Set<string>>(); // envId → thread ids đã biết (từ thread/list). Có entry = host đã warm
  private readonly threadToChat = new Map<string, string>();      // relay threadId → URL chatId (cho turnRefs)
  private readonly chatById = new Map<string, ChatDocument>();    // chatId → chat doc gần nhất (merge status)
  private readonly turnSeq = new Map<string, number>();           // docId → _seq tăng dần (delta fragment)
  private readonly turnSeen = new Set<string>();                  // turn docId đã added → lần sau modified

  // Chats local / cloud SSE state
  readonly localChats = new Map<string, LocalChatEntry>();
  readonly localRcSubscriptions = new Map<string, Subscription>();
  readonly activeSseSubscriptions = new Map<string, Subscription>();
  readonly addedTurnIds = new Map<string, Set<string>>();
  readonly latestResponseIds = new Map<string, string>();
  readonly pendingInputs = new Map<string, SseRequestParams>();

  // ─── Gateway / realtime publish ────────────────────────────────────────────────

  initWebsocketGateway(ws: WebsocketGateway): void {
    this.gateway = ws;
  }

  publishRealtimeChanges(changes: RealtimeChange[]): void {
    if (!this.gateway || changes.length === 0) return;
    for (const change of changes) {
      this.gateway.next({ ref: change.ref, data: change.data, type: change.type } as Parameters<WebsocketGateway["next"]>[0]);
    }
  }

  turnRefs(accountId: string, chatId: string): string[] {
    const base = `accounts/${accountId}/chats/${chatId}/turns`;
    const hostId = this.chatHostId.get(chatId);
    return hostId ? [base, `accounts/${accountId}/hosts/${hostId}/chats/${chatId}/turns`] : [base];
  }

  addReport(entry: Omit<ReportDocument, "id"> & { id?: string }): ReportDocument {
    const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.now();
    const report: ReportDocument = {
      ...entry,
      type: String(entry.type ?? "report"),
      id: entry.id ?? `${timestamp}-${crypto.randomUUID()}`,
      timestamp,
    };
    this.reports.unshift(report);
    if (this.reports.length > REPORT_LIMIT) this.reports.length = REPORT_LIMIT;
    this.publishRealtimeChanges([{ ref: "reports", type: "added", data: report }]);
    return report;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────────

  cancelSseStream(key: string): void {
    this.activeSseSubscriptions.get(key)?.unsubscribe();
    this.activeSseSubscriptions.delete(key);
  }

  cancelRcStream(key: string): void {
    this.localRcSubscriptions.get(key)?.unsubscribe();
    this.localRcSubscriptions.delete(key);
  }

  close(): void {
    for (const key of this.activeSseSubscriptions.keys()) this.cancelSseStream(key);
    for (const key of this.localRcSubscriptions.keys()) this.cancelRcStream(key);
  }

  // ─── Notify helpers ──────────────────────────────────────────────────────────

  private notifyHostsChanged(accountId: string) {
    const items = this.hostsCache.get(accountId) ?? [];
    this.publishRealtimeChanges(items.map((item) => ({ ref: `accounts/${accountId}/hosts`, type: "modified" as const, data: item })));
  }
  private notifyChatsChanged(accountId: string) {
    const items = this.chatsCache.get(accountId) ?? [];
    this.publishRealtimeChanges(items.map((item) => ({ ref: `accounts/${accountId}/chats`, type: "modified" as const, data: item })));
  }
  private notifyHostChatsChanged(accountId: string, hostId: string, items: ChatDocument[]) {
    this.publishRealtimeChanges(items.map((item) => ({ ref: `accounts/${accountId}/hosts/${hostId}/chats`, type: "modified" as const, data: item })));
  }
  private notifyHostProjectsChanged(accountId: string, hostId: string, items: ProjectDocument[]) {
    this.publishRealtimeChanges(items.map((item) => ({ ref: `accounts/${accountId}/hosts/${hostId}/projects`, type: "modified" as const, data: item })));
  }

  trackActiveHostChats(accountId: string, hostId: string) { this.trackActiveHost(this.activeHostChats, accountId, hostId); }
  trackActiveHostProjects(accountId: string, hostId: string) { this.trackActiveHost(this.activeHostProjects, accountId, hostId); }
  private trackActiveHost(map: Map<string, Set<string>>, accountId: string, hostId: string) {
    let set = map.get(accountId);
    if (!set) { set = new Set<string>(); map.set(accountId, set); }
    set.add(hostId);
  }

  // ─── Accounts realtime ───────────────────────────────────────────────────────

  private async publishAccountsSnapshot() {
    const raw = this.accounts.getAccounts();
    const docs = await Promise.all(raw.map(async (account) => ({
      ...serializeAccount(account),
      enrolled: !!(await this.enrollment.getEnrollment(account.id)),
    })));
    const changes: RealtimeChange[] = docs.map((doc) => ({
      ref: "accounts",
      type: this.knownAccountIds.has(doc.id) ? "modified" : "added",
      data: doc as unknown as Record<string, unknown>,
    }));
    this.knownAccountIds = new Set(docs.map((a) => a.id));
    this.publishRealtimeChanges(changes);
  }

  notifyAccountsChanged(): void {
    void this.publishAccountsSnapshot();
  }

  publishAccountRemoved(id: string): void {
    this.publishRealtimeChanges([{ ref: "accounts", type: "removed", data: { id } }]);
  }

  refreshAccountsUsageInBackground(): void {
    if (this.accountsUsageRefresh) return;
    this.accountsUsageRefresh = this.accounts.refreshCodexUsageForAccounts(false)
      .then(() => {
        this.notifyAccountsChanged();
        this.addReport({ type: "accounts_usage_refreshed", timestamp: Date.now() });
      })
      .catch((err) => {
        this.addReport({ type: "accounts_usage_refresh_error", error: err instanceof Error ? err.message : String(err), timestamp: Date.now() });
      })
      .finally(() => { this.accountsUsageRefresh = null; });
  }

  getHostsForAccount(accountId: string): HostDocument[] { return this.hostsCache.get(accountId) ?? []; }

  getHealth(openaiBaseUrl: string) {
    const accounts = this.accounts.getAccounts();
    return {
      ok: true,
      openaiBaseUrl,
      accountCount: accounts.length,
      activeAccountCount: accounts.filter((a) => a.status === "active").length,
      selectedAccount: accounts.find((a) => a.selected)?.email ?? null,
      configInstalled: this.configPatcher.isCodexConfigPatched(openaiBaseUrl),
      reportsCount: this.reports.length,
      usageRefreshRunning: Boolean(this.accountsUsageRefresh),
      timestamp: Date.now(),
    };
  }

  // ─── Background refresh ──────────────────────────────────────────────────────

  refreshHostsInBackground(accountId: string, force = false) {
    if (this.hostsRefreshing.has(accountId)) return;
    if (!force && Date.now() - (this.hostsFetchedAt.get(accountId) ?? 0) < HOSTS_TTL_MS) return;
    this.hostsRefreshing.add(accountId);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) { this.hostsRefreshing.delete(accountId); return; }
    this.codexApi.fetchHosts(account)
      .then((items) => {
        this.hostsCache.set(accountId, items.map((h) => ({ ...h, account_id: accountId })));
        this.hostsFetchedAt.set(accountId, Date.now());
        this.notifyHostsChanged(accountId);
      })
      .catch(() => {})
      .finally(() => this.hostsRefreshing.delete(accountId));
  }

  refreshProjectsInBackground(force = false) {
    if (this.projectsRefreshing) return;
    if (!force && Date.now() - this.projectsCacheState.fetchedAt < PROJECTS_TTL_MS) return;
    this.projectsRefreshing = true;
    this.codexApi.fetchProjects()
      .then((items) => { this.projectsCacheState.items = items; this.projectsCacheState.fetchedAt = Date.now(); })
      .catch(() => {})
      .finally(() => { this.projectsRefreshing = false; });
  }

  refreshChatsInBackground(accountId: string, params: { taskFilter?: string; envId?: string } = {}, force = false) {
    if (this.chatsRefreshing.has(accountId)) return;
    if (!force && Date.now() - (this.chatsFetchedAt.get(accountId) ?? 0) < CHATS_TTL_MS) return;
    this.chatsRefreshing.add(accountId);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) { this.chatsRefreshing.delete(accountId); return; }
    this.codexApi.fetchChats(account, params)
      .then((items) => {
        this.chatsCache.set(accountId, items.map((c) => ({ ...c, account_id: accountId })));
        this.chatsFetchedAt.set(accountId, Date.now());
        this.notifyChatsChanged(accountId);
      })
      .catch(() => {})
      .finally(() => this.chatsRefreshing.delete(accountId));
  }

  refreshHostChatsInBackground(accountId: string, hostId: string, force = false) {
    const key = `${accountId}:${hostId}`;
    if (this.hostChatsRefreshing.has(key)) return;
    if (!force && Date.now() - (this.hostChatsFetchedAt.get(key) ?? 0) < CHATS_TTL_MS) return;
    this.hostChatsRefreshing.add(key);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) { this.hostChatsRefreshing.delete(key); return; }
    this.registry.fetchRemoteChats(account, hostId)
      .then((remoteChats) => {
        const docs = remoteChats.map((rc) => this.remoteChatToDoc(rc, accountId, hostId));
        this.hostChatsCache.set(key, docs);
        this.hostChatsFetchedAt.set(key, Date.now());
        for (const d of docs) this.chatHostId.set(d.id, hostId);
        this.notifyHostChatsChanged(accountId, hostId, docs);
      })
      .catch(() => {})
      .finally(() => this.hostChatsRefreshing.delete(key));
  }

  refreshHostProjectsInBackground(accountId: string, hostId: string, force = false) {
    const key = `${accountId}:${hostId}`;
    if (this.hostProjectsRefreshing.has(key)) return;
    if (!force && Date.now() - (this.hostProjectsFetchedAt.get(key) ?? 0) < PROJECTS_TTL_MS) return;
    this.hostProjectsRefreshing.add(key);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) { this.hostProjectsRefreshing.delete(key); return; }
    this.registry.fetchRemoteProjects(account, hostId)
      .then((remoteProjects) => {
        const items: ProjectDocument[] = remoteProjects.map((p) => ({ ...p, source: "global-state" as const, account_id: accountId }));
        this.hostProjectsCache.set(key, items);
        this.hostProjectsFetchedAt.set(key, Date.now());
        this.notifyHostProjectsChanged(accountId, hostId, items);
      })
      .catch(() => {})
      .finally(() => this.hostProjectsRefreshing.delete(key));
  }

  // refresh-* actions (force + push realtime cho host đã query)
  triggerRefreshHosts(accountId: string) {
    this.hostsFetchedAt.delete(accountId);
    this.refreshHostsInBackground(accountId, true);
  }
  triggerRefreshProjects() {
    this.projectsCacheState.fetchedAt = 0;
    this.refreshProjectsInBackground(true);
    for (const [accId, hostIds] of this.activeHostProjects) {
      for (const hId of hostIds) this.refreshHostProjectsInBackground(accId, hId, true);
    }
  }
  triggerRefreshChats(accountId: string) {
    this.chatsFetchedAt.delete(accountId);
    this.refreshChatsInBackground(accountId, {}, true);
    for (const hostId of this.activeHostChats.get(accountId) ?? []) {
      this.refreshHostChatsInBackground(accountId, hostId, true);
    }
  }

  // ─── Relay → doc mapping ───────────────────────────────────────────────────────

  remoteChatToDoc(rc: RemoteChat, accountId: string, hostId: string): ChatDocument {
    return {
      id: rc.id,
      title: rc.title,
      status: rc.status ?? "idle",
      environment_id: `selfhost:${hostId}`,
      workspace_root: rc.workspaceRoot,
      created_at: rc.createdAt,
      updated_at: rc.updatedAt,
      account_id: accountId,
    } as unknown as ChatDocument;
  }

  private isApprovalItem(item: Record<string, unknown>): boolean {
    const t = String(item.type ?? "").toLowerCase();
    if (/approval|elicit|confirmation|guardian|permission/.test(t)) return true;
    const s = String((item.status as unknown) ?? "").toLowerCase();
    if (/pending|awaiting|needsapproval|denied|requested|requiresapproval/.test(s) && /exec|command|file|patch|tool/.test(t)) return true;
    return false;
  }

  private extractApproval(item: Record<string, unknown>): { title: string; content: string; command?: string; options?: string[]; requiresInput?: boolean } {
    const command = typeof item.command === "string" ? item.command : (Array.isArray(item.command) ? (item.command as unknown[]).join(" ") : undefined);
    const rawOpts = (item.options ?? item.choices) as unknown;
    const options = Array.isArray(rawOpts)
      ? rawOpts.map((o) => (typeof o === "string" ? o : String((o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.value ?? ""))).filter(Boolean)
      : undefined;
    return {
      title: String(item.title ?? "Yêu cầu xác nhận"),
      content: String(item.content ?? command ?? item.message ?? item.description ?? item.prompt ?? "Cho phép hành động này?"),
      command, options,
      requiresInput: item.requiresInput === true || String(item.type ?? "").toLowerCase().includes("elicit"),
    };
  }

  private extractImageItem(item: Record<string, unknown>): { data?: string; mimeType?: string; url?: string; path?: string } {
    const dataField = item.data as Record<string, unknown> | string | undefined;
    const data = typeof dataField === "string" ? dataField : (typeof (dataField as Record<string, unknown>)?.data === "string" ? String((dataField as Record<string, unknown>).data) : undefined);
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : (typeof (dataField as Record<string, unknown>)?.mimeType === "string" ? String((dataField as Record<string, unknown>).mimeType) : undefined);
    const url = typeof item.url === "string" ? item.url : (typeof item.href === "string" ? item.href : undefined);
    const path = typeof item.path === "string" ? item.path : undefined;
    return { data, mimeType: mimeType ?? (data ? "image/png" : undefined), url, path };
  }

  /** Trích danh sách thay đổi file từ item fileChange (path + kind + diff). */
  private extractFileChanges(item: Record<string, unknown>): { path: string; kind: string; diff: string }[] {
    const raw = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
    return raw.map((c) => ({
      path: String(c.path ?? ""),
      kind: String((c.kind as Record<string, unknown> | undefined)?.type ?? c.kind ?? "modify"),
      diff: typeof c.diff === "string" ? c.diff : (typeof c.content === "string" ? c.content : ""),
    }));
  }

  private extractRcItemText(item: Record<string, unknown>): string {
    if (typeof item.text === "string") return item.text;
    const content = item.content;
    if (Array.isArray(content)) {
      return content.filter((c) => (c as Record<string, unknown>)?.type === "text").map((c) => String((c as Record<string, unknown>).text ?? "")).join("\n");
    }
    if (typeof content === "string") return content;
    return "";
  }

  private turnDocId(turnId: string, itemType: string, fallbackId: string): string {
    const t = itemType.toLowerCase();
    if (turnId && (t === "usermessage" || t === "steeringusermessage")) return `${turnId}:user`;
    if (turnId && t === "agentmessage") return `${turnId}:agent`;
    return fallbackId;
  }

  /** Map lịch sử thread (rc.listTurns) → TurnDocument[]. */
  rcHistoryToDocs(rawTurns: Record<string, unknown>[], accountId: string, chatId: string): TurnDocument[] {
    const docs: TurnDocument[] = [];
    const toIso = (v: unknown): string | undefined => { const n = Number(v); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined; };
    for (const turn of rawTurns) {
      const startedIso = toIso(turn.startedAt);
      const completedIso = toIso(turn.completedAt) ?? startedIso;
      const turnId = String(turn.id ?? "");
      const items = Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : [];
      for (const item of items) {
        const type = String(item.type ?? "");
        const id = this.turnDocId(turnId, type, String(item.id ?? crypto.randomUUID()));
        if (type === "userMessage" || type === "steeringUserMessage") {
          const content = this.extractRcItemText(item);
          if (!content) continue;
          docs.push({ id, type: "user", role: "user", input_items: [{ type: "message", role: "user", content }], output_items: [], status: "completed", created_at: startedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "agentMessage") {
          const text = this.extractRcItemText(item);
          if (!text) continue;
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "image" || type === "localImage" || type === "imageGeneration") {
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "image", ...this.extractImageItem(item) }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "fileChange") {
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "file_change", changes: this.extractFileChanges(item) }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (this.isApprovalItem(item)) {
          docs.push({ id, type: "approval", role: "assistant", input_items: [], output_items: [{ type: "approval", ...this.extractApproval(item) }], status: "pending", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else {
          docs.push({ id, type: "unsupported", role: "assistant", input_items: [], output_items: [{ type: "unsupported", item_type: type, raw: JSON.stringify(item).slice(0, 4000) }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        }
      }
    }
    return docs;
  }

  private buildStreamDoc(itemType: string, itemId: string, item: Record<string, unknown>, createdAt?: string): Record<string, unknown> | null {
    if (itemType === "userMessage" || itemType === "steeringUserMessage") {
      const content = this.extractRcItemText(item);
      if (!content) return null;
      return { id: itemId, type: "user", role: "user", input_items: [{ type: "message", role: "user", content }], output_items: [], status: "completed", created_at: createdAt };
    }
    if (itemType === "image" || itemType === "localImage" || itemType === "imageGeneration") {
      return { id: itemId, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "image", ...this.extractImageItem(item) }], status: "completed", created_at: createdAt };
    }
    if (itemType === "fileChange") {
      return { id: itemId, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "file_change", changes: this.extractFileChanges(item) }], status: "completed", created_at: createdAt };
    }
    if (this.isApprovalItem(item)) {
      return { id: itemId, type: "approval", role: "assistant", input_items: [], output_items: [{ type: "approval", ...this.extractApproval(item) }], status: "pending", created_at: createdAt };
    }
    return { id: itemId, type: "unsupported", role: "assistant", input_items: [], output_items: [{ type: "unsupported", item_type: itemType, raw: JSON.stringify(item).slice(0, 4000) }], status: "completed", created_at: createdAt };
  }

  /**
   * Load lịch sử turn của 1 chat (thread/read). Realtime đi qua central event$ hook
   * (gắn 1 lần/account trong `#hookRelayEvents`), không cần stream riêng ở đây.
   */
  async streamChatTurns(account: Account, accountId: string, chatId: string, threadId: string, envId: string): Promise<TurnDocument[]> {
    const rc = await this.registry.getRC(account, envId);
    this.chatHostId.set(chatId, envId);          // để turnRefs publish đúng host-scoped ref
    this.threadToChat.set(threadId, chatId);     // demux turn event (relay threadId) → đúng URL chatId
    let history: TurnDocument[] = [];
    try {
      history = this.rcHistoryToDocs(await rc.listTurns(threadId, envId) as Record<string, unknown>[], accountId, chatId);
    } catch { /* relay đang reconnect → history rỗng, realtime vẫn chạy */ }
    for (const d of history) this.turnSeen.add((d as unknown as { id: string }).id);  // history đã ở client → modified
    this.#hookRelayEvents(rc, account, accountId);
    return history;
  }

  /** Map 1 event của chat → turn doc, hoặc null nếu event không đổi turn nào.
   *  Token agentMessage gửi dạng MẢNH `_delta` + `_seq` tăng dần (frontend cộng dồn). */
  #turnUpdateFromEvent(method: string, params: Record<string, unknown>, accountId: string, chatId: string): TurnDocument | null {
    const turnIdOf = (it?: Record<string, unknown>) => String(params.turnId ?? (params.turn as Record<string, unknown> | undefined)?.id ?? it?.turnId ?? "");
    const mk = (doc: Record<string, unknown>): TurnDocument => ({ ...doc, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);

    if (method === "item/agentMessage/delta") {
      const turnId = turnIdOf(); if (!turnId) return null;
      const id = `${turnId}:agent`;
      const seq = (this.turnSeq.get(id) ?? 0) + 1;
      this.turnSeq.set(id, seq);
      // Chỉ gửi mảnh delta + _seq (payload nhỏ); output_items rỗng khi đang stream — frontend dùng _delta gộp.
      return mk({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text: "" }], status: "in_progress", _delta: String(params.delta ?? ""), _seq: seq });
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined; if (!item) return null;
      const itemType = String(item.type ?? ""), turnId = turnIdOf(item);
      const id = this.turnDocId(turnId, itemType, String(item.id ?? ""));
      const createdAt = ((): string | undefined => { const v = Number(params.startedAtMs ?? params.completedAtMs); return Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : undefined; })();
      if (itemType === "agentMessage") {
        if (method === "item/started") return mk({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text: "" }], status: "in_progress", created_at: createdAt });
        this.turnSeq.delete(id);
        return mk({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text: this.extractRcItemText(item) }], status: "completed", created_at: createdAt });
      }
      if (method !== "item/completed") return null;
      const built = this.buildStreamDoc(itemType, id, item, createdAt);
      return built ? mk(built) : null;
    }
    return null;
  }

  /**
   * Load danh sách chat của 1 host (thread/list). Realtime đổi trạng thái đi qua central
   * event$ hook (gắn 1 lần/account), không cần stream riêng ở đây.
   */
  async streamChats(account: Account, accountId: string, envId: string): Promise<ChatDocument[]> {
    const rc = await this.registry.getRC(account, envId);
    let history: ChatDocument[] = [];
    try {
      history = (await this.registry.fetchRemoteChats(account, envId)).map((c) => this.remoteChatToDoc(c, accountId, envId));
    } catch { /* relay đang reconnect → rỗng, realtime vẫn chạy */ }
    for (const c of history) { this.chatHostId.set(c.id, envId); this.chatById.set(c.id, c); }   // map chat → host + base merge
    // Seed tập thread đã biết của host (đánh dấu host "warm"); thread lạ sau này = chat mới.
    this.knownThreads.set(envId, new Set(history.map((c) => c.id)));
    this.#hookRelayEvents(rc, account, accountId);
    return history;
  }

  /**
   * Gắn 1 subscription duy nhất/account vào `rc.event$`. Mỗi notification được demux:
   *   - đổi trạng thái thread → publish vào ref chats của host (envId trong event).
   *   - cập nhật item/turn   → publish vào turnRefs của chat (relay threadId → URL chatId).
   */
  #hookRelayEvents(rc: WebsocketRelay, account: Account, accountId: string): void {
    if (this.hookedRelays.has(accountId)) return;
    this.hookedRelays.add(accountId);
    rc.event$.subscribe(({ method, params, envId }) => {
      // 1) Chat status / chat mới → ref danh sách chat host-scoped.
      const chatDoc = this.#chatUpdateFromEvent(method, params, accountId, envId, this.chatById);
      if (chatDoc) {
        const known = this.knownThreads.get(envId);   // undefined = host chưa warm → bỏ qua (tránh false-added cả list cũ)
        if (known) {
          if (!known.has(chatDoc.id)) {
            known.add(chatDoc.id);   // dedup ngay → event sau của thread này đi nhánh dưới
            // shell-thread (relay tạo để chạy lệnh) → KHÔNG phải chat, bỏ qua; còn lại publish "added".
            if (!rc.shellThreadIds.has(chatDoc.id)) void this.#emitNewChat(rc, account, accountId, envId, chatDoc);
          } else if (this.chatById.has(chatDoc.id)) {
            // chỉ cập nhật status cho chat THẬT (shell-thread không vào chatById nên tự bị loại).
            this.publishRealtimeChanges([{ ref: `accounts/${accountId}/hosts/${envId}/chats`, type: "modified", data: chatDoc as unknown as Record<string, unknown> }]);
          }
        }
      }

      // 2) Turn update → turnRefs (ánh xạ relay threadId → URL chatId; fallback chính nó).
      const threadId = String(params.threadId ?? (params.item as Record<string, unknown> | undefined)?.threadId ?? "");
      const chatId = this.threadToChat.get(threadId) ?? threadId;
      if (!chatId) return;
      const turnDoc = this.#turnUpdateFromEvent(method, params, accountId, chatId);
      if (!turnDoc) return;
      const id = (turnDoc as unknown as { id: string }).id;
      const type: "added" | "modified" = this.turnSeen.has(id) ? "modified" : "added";
      this.turnSeen.add(id);
      this.publishRealtimeChanges(this.turnRefs(accountId, chatId).map((ref) => ({ ref, type, data: turnDoc as unknown as Record<string, unknown> })));
    });
  }

  /** Chat mới (threadId lạ): fetch metadata thật qua thread/list để có tên/cwd đúng (thay placeholder),
   *  rồi publish `added` vào ref danh sách chat của host. Lỗi fetch → vẫn publish doc fallback. */
  async #emitNewChat(rc: WebsocketRelay, account: Account, accountId: string, envId: string, fallback: ChatDocument): Promise<void> {
    let doc = fallback;
    try {
      const chats = await this.registry.fetchRemoteChats(account, envId);
      const real = chats.find((c) => c.id === fallback.id);
      if (real) doc = { ...this.remoteChatToDoc(real, accountId, envId), status: fallback.status };  // giữ status realtime mới nhất
    } catch { /* relay reconnect → dùng fallback placeholder */ }
    this.chatById.set(doc.id, doc);
    this.chatHostId.set(doc.id, envId);
    this.publishRealtimeChanges([{ ref: `accounts/${accountId}/hosts/${envId}/chats`, type: "added", data: doc as unknown as Record<string, unknown> }]);
  }

  /** Map 1 event → chat doc đã đổi status (merge field cũ từ `byId`), hoặc null.
   *  PURE: không tự ghi vào `byId` — caller quyết định seed `chatById` (tránh nhét nhầm shell-thread). */
  #chatUpdateFromEvent(method: string, params: Record<string, unknown>, accountId: string, envId: string, byId: Map<string, ChatDocument>): ChatDocument | null {
    const status =
      method === "thread/status/changed" ? mapThreadStatus((params.status as Record<string, unknown> | undefined)?.type ?? params.status)
      : method === "turn/started" ? "in_progress"
      : method === "turn/completed" ? "idle"
      : null;
    if (status === null) return null;
    const chatId = String(params.threadId ?? ""); if (!chatId) return null;
    const existing = byId.get(chatId);
    return existing
      ? ({ ...existing, status } as ChatDocument)
      : this.remoteChatToDoc({ id: chatId, title: chatId, status } as RemoteChat, accountId, envId);
  }
}
