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
import type { AccountService } from "../account-service";
import {
  REPORT_LIMIT, HOSTS_TTL_MS, PROJECTS_TTL_MS, CHATS_TTL_MS,
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
    private readonly configPatcher: ConfigPatcherService,
    private readonly accountService: AccountService
  ) {}

  private gateway: WebsocketGateway | null = null;

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
  // accountId → host ids đã publish, để diff added/modified/removed (chuẩn realtime LiveQuery).
  private readonly knownHostIds = new Map<string, Set<string>>();

  // Central event$ → livequery publish state (1 subscription/account, demux theo envId/threadId)
  private readonly hookedRelays = new Set<string>();              // accountId đã gắn event$ subscription
  private readonly knownThreads = new Map<string, Set<string>>(); // envId → thread ids đã biết (từ thread/list). Có entry = host đã warm
  private readonly threadToChat = new Map<string, string>();      // relay threadId → URL chatId (cho turnRefs)
  private readonly chatById = new Map<string, ChatDocument>();    // chatId → chat doc gần nhất (merge status)
  private readonly turnSeq = new Map<string, number>();           // docId → _seq tăng dần (delta fragment)
  private readonly turnSeen = new Set<string>();                  // turn docId đã added → lần sau modified
  private readonly turnAgentDocId = new Map<string, string>();    // turnId → agent message doc id realtime
  private readonly chatTitleOverrides = new Map<string, string>(); // accountId:chatId → title do UI đổi

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

  private relayThreadId(params: Record<string, unknown>): string {
    const item = this.asRecord(params.item);
    const turn = this.asRecord(params.turn);
    const thread = this.asRecord(params.thread);
    return String(
      params.threadId ??
      params.thread_id ??
      item?.threadId ??
      item?.thread_id ??
      turn?.threadId ??
      turn?.thread_id ??
      thread?.id ??
      ""
    );
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
    const ref = `accounts/${accountId}/hosts`;
    const items = this.hostsCache.get(accountId) ?? [];
    const known = this.knownHostIds.get(accountId) ?? new Set<string>();
    const nextIds = new Set<string>();
    const changes: RealtimeChange[] = [];
    // added cho host mới (client chưa có thì "modified" sẽ bị bỏ qua), modified cho host đã biết.
    for (const item of items) {
      nextIds.add(item.id);
      changes.push({ ref, type: known.has(item.id) ? "modified" : "added", data: item });
    }
    // removed cho host đã biến mất khỏi danh sách (vd unenroll / gỡ environment).
    for (const id of known) {
      if (!nextIds.has(id)) changes.push({ ref, type: "removed", data: { id } });
    }
    this.knownHostIds.set(accountId, nextIds);
    this.publishRealtimeChanges(changes);
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

  // Account realtime do AccountService sở hữu; store chỉ delegate để controller cũ khỏi đổi call-site.
  notifyAccountsChanged(): void {
    this.accountService.notifyChanged();
  }

  publishAccountRemoved(id: string): void {
    this.accountService.publishRemoved(id);
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
    const id = rc.id;
    return {
      id,
      title: this.chatTitleOverrides.get(`${accountId}:${id}`) ?? rc.title,
      status: rc.status ?? "idle",
      remote_status: rc.remoteStatus,
      environment_id: `selfhost:${hostId}`,
      workspace_root: rc.workspaceRoot,
      created_at: rc.createdAt,
      updated_at: rc.updatedAt,
      account_id: accountId,
    } as unknown as ChatDocument;
  }

  renameChat(accountId: string, chatId: string, title: string): ChatDocument | null {
    this.chatTitleOverrides.set(`${accountId}:${chatId}`, title);
    const patch = (doc: ChatDocument): ChatDocument => ({ ...doc, title, updated_at: new Date().toISOString() } as ChatDocument);
    let updated: ChatDocument | null = null;

    const accountChats = this.chatsCache.get(accountId);
    if (accountChats) {
      this.chatsCache.set(accountId, accountChats.map((c) => {
        if (c.id !== chatId) return c;
        updated = patch(c);
        return updated;
      }));
    }

    for (const [key, docs] of this.hostChatsCache.entries()) {
      const next = docs.map((c) => {
        if (c.id !== chatId) return c;
        updated = patch(c);
        return updated;
      });
      this.hostChatsCache.set(key, next);
    }

    const local = this.localChats.get(chatId);
    if (local) local.title = title;
    const existing = this.chatById.get(chatId);
    if (existing) {
      updated = patch(existing);
      this.chatById.set(chatId, updated);
    }

    if (!updated && local) {
      updated = {
        id: chatId,
        title,
        status: "idle",
        environment_id: `selfhost:${local.hostId}`,
        workspace_root: local.cwd,
        account_id: accountId,
        updated_at: new Date().toISOString(),
      } as unknown as ChatDocument;
      this.chatById.set(chatId, updated);
    }

    if (updated) {
      const refs = [`accounts/${accountId}/chats`];
      const hostId = this.chatHostId.get(chatId) ?? local?.hostId;
      if (hostId) refs.push(`accounts/${accountId}/hosts/${hostId}/chats`);
      this.publishRealtimeChanges(refs.map((ref) => ({ ref, type: "modified" as const, data: updated as unknown as Record<string, unknown> })));
    }

    return updated;
  }

  /**
   * Đăng ký một chat selfhost vừa tạo (chatId = threadId THẬT trên remote): seed map host/byId,
   * đánh dấu thread "đã biết" (nếu host warm) để hook event KHÔNG #emitNewChat nhân đôi, đẩy doc
   * vào cache + publish "added" cho sidebar. Status realtime sau đó tự cập nhật đúng (cùng id).
   */
  registerLocalChat(accountId: string, hostId: string, chat: ChatDocument): void {
    this.chatHostId.set(chat.id, hostId);
    this.chatById.set(chat.id, chat);
    this.knownThreads.get(hostId)?.add(chat.id);   // chỉ khi host đã warm; chưa warm thì streamChats seed sau
    const cacheKey = `${accountId}:${hostId}`;
    this.hostChatsCache.set(cacheKey, [chat, ...(this.hostChatsCache.get(cacheKey) ?? []).filter((c) => c.id !== chat.id)]);
    this.hostChatsFetchedAt.set(cacheKey, Date.now());
    this.publishRealtimeChanges([{ ref: `accounts/${accountId}/hosts/${hostId}/chats`, type: "added", data: chat as unknown as Record<string, unknown> }]);
  }

  private isApprovalItem(item: Record<string, unknown>): boolean {
    const t = String(item.type ?? "").toLowerCase();
    if (/approval|elicit|confirmation|guardian|permission|option_picker|optionpicker/.test(t)) return true;
    if (String(item.name ?? item.toolName ?? "").toLowerCase() === "request_user_input") return true;
    const s = String((item.status as unknown) ?? "").toLowerCase();
    if (/pending|awaiting|needsapproval|denied|requested|requiresapproval/.test(s) && /exec|command|file|patch|tool/.test(t)) return true;
    return false;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private stringifyCommand(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const command = value.map((part) => {
        const obj = this.asRecord(part);
        return obj ? String(obj.command ?? obj.cmd ?? obj.value ?? "") : String(part);
      }).filter(Boolean).join(" ").trim();
      return command || undefined;
    }
    const obj = this.asRecord(value);
    if (!obj) return undefined;
    return this.stringifyCommand(obj.command ?? obj.cmd ?? obj.argv ?? obj.args);
  }

  private firstText(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value;
      const obj = this.asRecord(value);
      if (obj) {
        const nested = this.firstText(obj.text, obj.content, obj.message, obj.description, obj.reason, obj.prompt, obj.question);
        if (nested) return nested;
      }
    }
    return undefined;
  }

  private extractUserInputRequest(item: Record<string, unknown>): { title?: string; content?: string; options?: string[]; optionDescriptions?: string[]; allowMultiple?: boolean; submitLabel?: string; skipLabel?: string } | undefined {
    const args = this.parseJsonObject(item.arguments)
      ?? this.asRecord(item.arguments)
      ?? this.asRecord(item.params)
      ?? this.asRecord(item.input)
      ?? item;
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const question = this.asRecord(questions[0]) ?? args;
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options: string[] = [];
    const optionDescriptions: string[] = [];
    for (const raw of rawOptions) {
      if (typeof raw === "string") {
        options.push(raw);
        optionDescriptions.push("");
        continue;
      }
      const option = this.asRecord(raw);
      if (!option) continue;
      const label = String(option.label ?? option.value ?? option.text ?? "");
      if (!label) continue;
      options.push(label);
      optionDescriptions.push(String(option.description ?? ""));
    }
    if (!this.firstText(question.question, question.prompt, question.message) && options.length === 0) return undefined;
    return {
      title: this.firstText(question.header, question.title),
      content: this.firstText(question.question, question.prompt, question.message),
      options,
      optionDescriptions,
      allowMultiple: question.allowMultiple === true,
      submitLabel: typeof question.submitLabel === "string" ? question.submitLabel : undefined,
      skipLabel: typeof question.skipLabel === "string" ? question.skipLabel : undefined,
    };
  }

  private extractApproval(item: Record<string, unknown>): { title: string; content: string; command?: string; options?: string[]; optionDescriptions?: string[]; requiresInput?: boolean; allowMultiple?: boolean; submitLabel?: string; skipLabel?: string; approval_event?: unknown } {
    const userInput = this.extractUserInputRequest(item);
    if (userInput) {
      return {
        title: userInput.title ?? "Yêu cầu xác nhận",
        content: userInput.content ?? "Cho phép hành động này?",
        options: userInput.options,
        optionDescriptions: userInput.optionDescriptions,
        approval_event: item.approval_event,
        allowMultiple: userInput.allowMultiple,
        submitLabel: userInput.submitLabel,
        skipLabel: userInput.skipLabel,
        requiresInput: false,
      };
    }
    const nestedAction = this.asRecord(item.action) ?? this.asRecord(item.commandAction) ?? this.asRecord(item.request) ?? this.asRecord(item.approval);
    const command = this.stringifyCommand(
      item.commandActions ?? item.command ?? item.cmd ?? item.shellCommand ?? item.commandLine ?? item.commandAction ?? item.action ?? nestedAction
    );
    const rawOpts = (item.options ?? item.choices) as unknown;
    const options = Array.isArray(rawOpts)
      ? rawOpts.map((o) => (typeof o === "string" ? o : String((o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.value ?? ""))).filter(Boolean)
      : undefined;
    return {
      title: String(item.title ?? nestedAction?.title ?? "Yêu cầu xác nhận"),
      content: this.firstText(item.content, item.message, item.description, item.prompt, item.question, item.reason, nestedAction) ?? command ?? "Cho phép hành động này?",
      command, options,
      optionDescriptions: undefined,
      approval_event: item.approval_event,
      allowMultiple: item.allowMultiple === true,
      submitLabel: typeof item.submitLabel === "string" ? item.submitLabel : undefined,
      skipLabel: typeof item.skipLabel === "string" ? item.skipLabel : undefined,
      requiresInput: item.requiresInput === true || String(item.type ?? "").toLowerCase().includes("elicit"),
    };
  }

  private parseJsonObject(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private extractPrefixRule(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      const text = value.map((part) => String(part)).filter(Boolean).join(" ").trim();
      return text || undefined;
    }
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  private async readPendingApprovalFromSession(rc: WebsocketRelay, thread: Record<string, unknown>, envId: string): Promise<Record<string, unknown> | null> {
    const path = typeof thread.path === "string" ? thread.path : "";
    if (!path) return null;
    try {
      const text = await rc.readFileText(path, envId);
      const outputs = new Set<string>();
      const candidates: Record<string, unknown>[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const entry = this.parseJsonObject(line);
        const payload = this.asRecord(entry?.payload);
        if (entry?.type !== "response_item" || !payload) continue;
        if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
          outputs.add(payload.call_id);
          continue;
        }
        if (payload.type !== "function_call" || typeof payload.call_id !== "string") continue;
        const args = this.parseJsonObject(payload.arguments);
        if (payload.name === "request_user_input" && args) {
          candidates.push({ call_id: payload.call_id, name: payload.name, args });
          continue;
        }
        if (!args || args.sandbox_permissions !== "require_escalated") continue;
        candidates.push({ call_id: payload.call_id, name: payload.name, args });
      }
      for (let i = candidates.length - 1; i >= 0; i--) {
        const candidate = candidates[i];
        if (outputs.has(String(candidate.call_id))) continue;
        const args = this.asRecord(candidate.args) ?? {};
        if (candidate.name === "request_user_input") {
          return {
            id: candidate.call_id,
            type: "option_picker",
            ...this.extractApproval({ type: "option_picker", name: "request_user_input", arguments: args }),
          };
        }
        const command = this.stringifyCommand(args.cmd ?? args.command);
        const prefix = this.extractPrefixRule(args.prefix_rule);
        const content = this.firstText(args.justification) ?? "Cho phép hành động này?";
        return {
          id: candidate.call_id,
          type: "approval",
          title: "Yêu cầu xác nhận",
          content,
          command,
          prefix,
          options: prefix
            ? ["Yes", `Yes, and don't ask again for commands that start with ${prefix}`, "No, and tell Codex what to do differently"]
            : ["Yes", "No, and tell Codex what to do differently"],
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private async readUserInputRequestDocsFromSession(rc: WebsocketRelay, thread: Record<string, unknown>, envId: string, accountId: string, chatId: string): Promise<TurnDocument[]> {
    const path = typeof thread.path === "string" ? thread.path : "";
    if (!path) return [];
    try {
      const text = await rc.readFileText(path, envId);
      const outputs = new Set<string>();
      const calls: { callId: string; args: Record<string, unknown>; createdAt?: string }[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const entry = this.parseJsonObject(line);
        const payload = this.asRecord(entry?.payload);
        if (entry?.type !== "response_item" || !payload) continue;
        if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
          outputs.add(payload.call_id);
          continue;
        }
        if (payload.type !== "function_call" || payload.name !== "request_user_input" || typeof payload.call_id !== "string") continue;
        const args = this.parseJsonObject(payload.arguments);
        if (!args) continue;
        calls.push({ callId: payload.call_id, args, createdAt: typeof entry.timestamp === "string" ? entry.timestamp : undefined });
      }
      return calls.map(({ callId, args, createdAt }) => ({
        id: callId,
        type: "approval",
        role: "assistant",
        input_items: [],
        output_items: [{ type: "option_picker", ...this.extractApproval({ type: "option_picker", name: "request_user_input", arguments: args }) }],
        status: outputs.has(callId) ? "completed" : "pending",
        created_at: createdAt,
        account_id: accountId,
        chat_id: chatId,
      } as unknown as TurnDocument));
    } catch {
      return [];
    }
  }

  private approvalItemFromStatus(params: Record<string, unknown>): Record<string, unknown> | null {
    const status = this.asRecord(params.status);
    if (!status) return null;
    if (mapThreadStatus(status) !== "needs_response") return null;
    const source =
      this.asRecord(status.approval) ??
      this.asRecord(status.approvalRequest) ??
      this.asRecord(status.confirmation) ??
      this.asRecord(status.confirmationRequest) ??
      this.asRecord(status.elicitation) ??
      this.asRecord(status.guardianDeniedAction) ??
      this.asRecord(status.deniedAction) ??
      this.asRecord(status.pendingAction) ??
      this.asRecord(status.action) ??
      this.asRecord(status.request) ??
      {};
    return {
      ...status,
      ...source,
      type: String(source.type ?? status.type ?? "approval"),
      id: source.id ?? status.id ?? params.turnId ?? `${String(params.threadId ?? "")}:approval`,
    };
  }

  private async approvalDocFromThreadStatus(rc: WebsocketRelay, thread: Record<string, unknown>, envId: string, accountId: string, chatId: string): Promise<TurnDocument | null> {
    const status = this.asRecord(thread.status);
    if (!status || mapThreadStatus(status) !== "needs_response") return null;
    const threadId = String(thread.id ?? chatId);
    const pendingEvent = await rc.fetchPendingApprovalEvent(threadId, envId, 1_500).catch(() => undefined);
    if (pendingEvent) {
      const method = typeof pendingEvent.method === "string" ? pendingEvent.method : "";
      const params = this.asRecord(pendingEvent.params) ?? {};
      const doc = this.#turnUpdateFromEvent(method, params, accountId, chatId, {
        id: pendingEvent.id as string | number | undefined,
        seqId: typeof pendingEvent.seqId === "number" ? pendingEvent.seqId : undefined,
        streamId: typeof pendingEvent.streamId === "string" ? pendingEvent.streamId : undefined,
      });
      if (doc) return doc;
    }
    const item = this.approvalItemFromStatus({ threadId: thread.id ?? chatId, turnId: status.turnId ?? status.turn_id, status });
    if (!item) return null;
    const pending = await this.readPendingApprovalFromSession(rc, thread, envId);
    const approval = pending ? { ...item, ...pending } : item;
    const id = String(item.id ?? status.turnId ?? `${chatId}:approval`);
    return {
      id,
      type: "approval",
      role: "assistant",
      input_items: [],
      output_items: [{ type: "approval", ...this.extractApproval(approval), prefix: approval.prefix }],
      status: "pending",
      created_at: new Date().toISOString(),
      account_id: accountId,
      chat_id: chatId,
    } as unknown as TurnDocument;
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

  private planImplementationApproval(item: Record<string, unknown>, fallbackTurnId = ""): Record<string, unknown> | null {
    if (item.isCompleted === true) return null;
    const planContent = typeof item.planContent === "string" ? item.planContent.trim() : "";
    if (!planContent) return null;
    const turnId = String(item.turnId ?? fallbackTurnId ?? "");
    return {
      type: "option_picker",
      title: "Implement this plan?",
      content: "Implement this plan?",
      options: ["Yes, implement this plan", "No, and tell Codex what to do differently"],
      optionDescriptions: ["", ""],
      submitLabel: "Submit",
      skipLabel: "Dismiss",
      approval_event: {
        method: "local/implementPlan",
        params: { turnId, planContent },
      },
    };
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
        const fallbackId = String(item.id ?? crypto.randomUUID());
        // Lịch sử thread có thể chứa nhiều agentMessage trong cùng một turn. Nếu dùng chung
        // `${turnId}:agent`, LiveQuery sẽ merge chúng thành 1 document trên client.
        const id = type === "agentMessage" && fallbackId ? fallbackId : this.turnDocId(turnId, type, fallbackId);
        if (type === "userMessage" || type === "steeringUserMessage") {
          const content = this.extractRcItemText(item);
          if (!content) continue;
          docs.push({ id, type: "user", role: "user", input_items: [{ type: "message", role: "user", content }], output_items: [], status: "completed", created_at: startedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "agentMessage") {
          const text = this.extractRcItemText(item);
          if (!text) continue;
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "plan") {
          const text = this.extractRcItemText(item) || String(item.text ?? item.content ?? "");
          if (!text) continue;
          docs.push({ id, type: "plan", role: "assistant", input_items: [], output_items: [{ type: "plan", text, content: text }], status: String(item.status ?? "completed"), created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "contextCompaction") {
          docs.push({ id, type: "context_compaction", role: "assistant", input_items: [], output_items: [{ type: "context_compaction", text: "Tối ưu context" }], status: String(item.status ?? "completed"), created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "image" || type === "localImage" || type === "imageGeneration") {
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "image", ...this.extractImageItem(item) }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "fileChange") {
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "file_change", changes: this.extractFileChanges(item) }], status: "completed", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (this.isApprovalItem(item)) {
          const approval = this.extractApproval(item);
          const approvalType = String(item.type ?? "").toLowerCase().includes("option") || String(item.name ?? "") === "request_user_input" ? "option_picker" : "approval";
          docs.push({ id, type: "approval", role: "assistant", input_items: [], output_items: [{ type: approvalType, ...approval }], status: "pending", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "planImplementation") {
          const approval = this.planImplementationApproval(item, turnId);
          if (!approval) continue;
          const requestTurnId = String(item.turnId ?? turnId ?? fallbackId);
          const planContent = String(item.planContent ?? "");
          docs.push({ id: `implement-plan:${requestTurnId}`, type: "plan", role: "assistant", input_items: [], output_items: [{ type: "plan", text: planContent, content: planContent }, approval], status: "pending", created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
        } else if (type === "commandExecution") {
          docs.push({ id, type: "assistant", role: "assistant", input_items: [], output_items: [item], status: String(item.status ?? "completed"), created_at: completedIso, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);
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
    if (itemType === "plan") {
      const text = this.extractRcItemText(item) || String(item.text ?? item.content ?? "");
      if (!text) return null;
      return { id: itemId, type: "plan", role: "assistant", input_items: [], output_items: [{ type: "plan", text, content: text }], status: String(item.status ?? "completed"), created_at: createdAt };
    }
    if (itemType === "contextCompaction") {
      return { id: itemId, type: "context_compaction", role: "assistant", input_items: [], output_items: [{ type: "context_compaction", text: "Tối ưu context" }], status: String(item.status ?? "completed"), created_at: createdAt };
    }
    if (itemType === "fileChange") {
      return { id: itemId, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "file_change", changes: this.extractFileChanges(item) }], status: "completed", created_at: createdAt };
    }
    if (this.isApprovalItem(item)) {
      const approvalType = itemType.toLowerCase().includes("option") || String(item.name ?? "") === "request_user_input" ? "option_picker" : "approval";
      return { id: itemId, type: "approval", role: "assistant", input_items: [], output_items: [{ type: approvalType, ...this.extractApproval(item) }], status: "pending", created_at: createdAt };
    }
    if (itemType === "planImplementation") {
      const approval = this.planImplementationApproval(item);
      if (!approval) return null;
      const turnId = String(item.turnId ?? itemId);
      const planContent = String(item.planContent ?? "");
      return { id: `implement-plan:${turnId}`, type: "plan", role: "assistant", input_items: [], output_items: [{ type: "plan", text: planContent, content: planContent }, approval], status: "pending", created_at: createdAt };
    }
    if (itemType === "commandExecution") {
      return { id: itemId, type: "assistant", role: "assistant", input_items: [], output_items: [item], status: String(item.status ?? "completed"), created_at: createdAt };
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
      const thread = await rc.readThread(threadId, envId);
      const turns = Array.isArray(thread.turns) ? thread.turns as Record<string, unknown>[] : await rc.listTurns(threadId, envId) as Record<string, unknown>[];
      history = this.rcHistoryToDocs(turns, accountId, chatId);
      const sessionRequestDocs = await this.readUserInputRequestDocsFromSession(rc, thread, envId, accountId, chatId);
      for (const doc of sessionRequestDocs) {
        if (!history.some((existing) => existing.id === doc.id)) history.push(doc);
      }
      const hasPendingRequest = history.some((doc) =>
        doc.type === "approval" &&
        doc.status !== "completed" &&
        doc.status !== "resolved" &&
        Array.isArray(doc.output_items) &&
        doc.output_items.some((item) => {
          const type = String((item as Record<string, unknown>).type ?? "");
          return type === "approval" || type === "option_picker" || type === "elicitation";
        })
      );
      if (!hasPendingRequest) {
        const approval = await this.approvalDocFromThreadStatus(rc, thread, envId, accountId, chatId);
        if (approval && !history.some((doc) => doc.id === approval.id)) history.push(approval);
      }
      history.sort((a, b) => {
        const at = Date.parse(String(a.created_at ?? ""));
        const bt = Date.parse(String(b.created_at ?? ""));
        return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
      });
    } catch { /* relay đang reconnect → history rỗng, realtime vẫn chạy */ }
    for (const d of history) this.turnSeen.add((d as unknown as { id: string }).id);  // history đã ở client → modified
    this.#hookRelayEvents(rc, account, accountId);
    return history;
  }

  /** Map 1 event của chat → turn doc, hoặc null nếu event không đổi turn nào.
   *  Token agentMessage gửi dạng MẢNH `_delta` + `_seq` tăng dần (frontend cộng dồn). */
  #turnUpdateFromEvent(method: string, params: Record<string, unknown>, accountId: string, chatId: string, eventMeta?: { id?: string | number; seqId?: number; streamId?: string }): TurnDocument | null {
    const turnIdOf = (it?: Record<string, unknown>) => String(params.turnId ?? (params.turn as Record<string, unknown> | undefined)?.id ?? it?.turnId ?? "");
    const mk = (doc: Record<string, unknown>): TurnDocument => ({ ...doc, account_id: accountId, chat_id: chatId } as unknown as TurnDocument);

    if (method === "item/agentMessage/delta" || (method.includes("agentMessage") && method.toLowerCase().includes("delta"))) {
      const item = params.item as Record<string, unknown> | undefined;
      const turnId = turnIdOf(item);
      const id = String(item?.id ?? params.itemId ?? (turnId ? (this.turnAgentDocId.get(turnId) ?? `${turnId}:agent`) : ""));
      if (!id) return null;
      const delta = params.delta ?? params.text ?? params.content ?? item?.delta ?? item?.text ?? "";
      const seq = (this.turnSeq.get(id) ?? 0) + 1;
      this.turnSeq.set(id, seq);
      // Chỉ gửi mảnh delta + _seq (payload nhỏ); output_items rỗng khi đang stream — frontend dùng _delta gộp.
      return mk({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text: "" }], status: "in_progress", _delta: String(delta), _seq: seq });
    }
    if (method === "thread/status/changed") {
      const item = this.approvalItemFromStatus(params);
      if (!item) return null;
      const threadId = String(params.threadId ?? "");
      const turnId = turnIdOf(item);
      const id = String(item.id ?? (turnId ? `${turnId}:approval` : `${threadId}:approval`));
      return mk({ id, type: "approval", role: "assistant", input_items: [], output_items: [{ type: "approval", ...this.extractApproval(item) }], status: "pending", created_at: new Date().toISOString() });
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const threadId = String(params.threadId ?? "");
      const turnId = turnIdOf(params);
      const itemId = String(params.itemId ?? params.callId ?? "");
      const id = itemId || (turnId ? `${turnId}:approval` : `${threadId}:approval`);
      const prefix = this.extractPrefixRule(params.proposedExecpolicyAmendment);
      const options = method === "item/commandExecution/requestApproval"
        ? (prefix
            ? ["Yes", `Yes, and don't ask again for commands that start with ${prefix}`, "No, and tell Codex what to do differently"]
            : ["Yes", "Yes, and don't ask again this session", "No, and tell Codex what to do differently"])
        : ["Yes", "Yes, and don't ask again this session", "No, and tell Codex what to do differently"];
      const item = {
        ...params,
        type: "approval",
        title: "Yêu cầu xác nhận",
        content: params.reason,
        options,
        prefix,
        approval_event: { ...eventMeta, method, params },
      };
      return mk({ id, type: "approval", role: "assistant", input_items: [], output_items: [{ type: "approval", ...this.extractApproval(item), prefix }], status: "pending", created_at: new Date().toISOString() });
    }
    if (method === "item/tool/requestOptionPicker") {
      const threadId = String(params.threadId ?? "");
      const turnId = turnIdOf(params);
      const itemId = String(params.itemId ?? params.callId ?? "");
      const id = itemId || (turnId ? `${turnId}:option_picker` : `${threadId}:option_picker`);
      const rawOptions = Array.isArray(params.options) ? params.options : [];
      const options = rawOptions
        .map((option) => {
          if (typeof option === "string") return option;
          const obj = this.asRecord(option);
          return obj ? String(obj.label ?? obj.value ?? obj.text ?? "") : "";
        })
        .filter(Boolean);
      const item = {
        ...params,
        type: "option_picker",
        title: "Yêu cầu xác nhận",
        content: params.question,
        options,
        approval_event: { ...eventMeta, method, params },
      };
      return mk({
        id,
        type: "approval",
        role: "assistant",
        input_items: [],
        output_items: [{ type: "option_picker", ...this.extractApproval(item) }],
        status: "pending",
        created_at: new Date().toISOString(),
      });
    }
    if (method === "item/tool/requestUserInput") {
      const threadId = String(params.threadId ?? "");
      const turnId = turnIdOf(params);
      const itemId = String(params.itemId ?? params.callId ?? "");
      const id = itemId || (turnId ? `${turnId}:user_input` : `${threadId}:user_input`);
      const item = {
        ...params,
        type: "option_picker",
        name: "request_user_input",
        arguments: { questions: Array.isArray(params.questions) ? params.questions : [] },
        approval_event: { ...eventMeta, method, params },
      };
      return mk({
        id,
        type: "approval",
        role: "assistant",
        input_items: [],
        output_items: [{ type: "option_picker", ...this.extractApproval(item) }],
        status: "pending",
        created_at: new Date().toISOString(),
      });
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined; if (!item) return null;
      const itemType = String(item.type ?? ""), turnId = turnIdOf(item);
      const itemId = String(item.id ?? "");
      const id = itemType === "agentMessage" && itemId ? itemId : this.turnDocId(turnId, itemType, itemId);
      const createdAt = ((): string | undefined => { const v = Number(params.startedAtMs ?? params.completedAtMs); return Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : undefined; })();
      if (itemType === "agentMessage") {
        if (turnId) this.turnAgentDocId.set(turnId, id);
        if (method === "item/started") return mk({ id, type: "assistant", role: "assistant", input_items: [], output_items: [{ type: "text", text: "" }], status: "in_progress", created_at: createdAt });
        this.turnSeq.delete(id);
        if (turnId) this.turnAgentDocId.delete(turnId);
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
    // KHÔNG nuốt lỗi: lỗi fetch (relay drop / token hết hạn) nổi lên controller → trả 502
    // để UI hiển thị, tránh "0 chat im lặng" (trước đây catch → trả rỗng, người dùng tưởng hết chat).
    const history = (await this.registry.fetchRemoteChats(account, envId)).map((c) => this.remoteChatToDoc(c, accountId, envId));
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
    rc.event$.subscribe(({ id: eventId, seqId, streamId, method, params, envId }) => {
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
      const threadId = this.relayThreadId(params);
      const chatId = this.threadToChat.get(threadId) ?? threadId;
      if (!chatId) return;
      const turnDoc = this.#turnUpdateFromEvent(method, params, accountId, chatId, { id: eventId, seqId, streamId });
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
      if (real) doc = { ...this.remoteChatToDoc(real, accountId, envId), status: fallback.status, remote_status: fallback.remote_status };  // giữ status realtime mới nhất
    } catch { /* relay reconnect → dùng fallback placeholder */ }
    this.chatById.set(doc.id, doc);
    this.chatHostId.set(doc.id, envId);
    this.publishRealtimeChanges([{ ref: `accounts/${accountId}/hosts/${envId}/chats`, type: "added", data: doc as unknown as Record<string, unknown> }]);
  }

  /** Map 1 event → chat doc đã đổi status (merge field cũ từ `byId`), hoặc null.
   *  PURE: không tự ghi vào `byId` — caller quyết định seed `chatById` (tránh nhét nhầm shell-thread). */
  #chatUpdateFromEvent(method: string, params: Record<string, unknown>, accountId: string, envId: string, byId: Map<string, ChatDocument>): ChatDocument | null {
    const statusObj = this.asRecord(params.status);
    const statusType = typeof statusObj?.type === "string" ? statusObj.type : typeof params.status === "string" ? params.status : undefined;
    const activeFlags = Array.isArray(statusObj?.activeFlags) ? statusObj.activeFlags.map(String).filter(Boolean) : [];
    const remoteStatus = statusType && activeFlags.length ? `${statusType}:${activeFlags.join(",")}` : statusType;
    const status =
      method === "thread/status/changed" ? mapThreadStatus(statusObj ?? params.status)
      : method === "turn/started" ? "in_progress"
      : method === "turn/completed" ? "idle"
      : null;
    if (status === null) return null;
    const chatId = this.relayThreadId(params); if (!chatId) return null;
    const existing = byId.get(chatId);
    const nextStatus = method === "turn/completed" && existing?.status === "needs_response" ? "needs_response" : status;
    return existing
      ? ({ ...existing, status: nextStatus, remote_status: remoteStatus ?? existing.remote_status } as ChatDocument)
      : this.remoteChatToDoc({ id: chatId, title: chatId, status: nextStatus, remoteStatus } as RemoteChat, accountId, envId);
  }
}
