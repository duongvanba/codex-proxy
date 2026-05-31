import { Hono } from "hono";
import { createLivequery } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import type { AccountsService } from "../services/accounts";
import type { CodexApiService } from "../libs/chatgpt";
import type { RemoteControlRegistry } from "../libs/codex-remote-control";
import { LivequeryStore, json, error, parseEnvId, parseImages, collectionResponse, type LocalChatEntry } from "../services/livequery";
import { buildCtx, type LivequeryDeps } from "./_livequery";

/** Collection chats (account & host) + chat mutations (send/cancel/archive/recover/mark-read) + terminal/approval. */
export class ChatsController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly accounts: AccountsService,
    private readonly codexApi: CodexApiService,
    private readonly registry: RemoteControlRegistry,
    deps: LivequeryDeps
  ) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });

    lq.get("/livequery/accounts/:accountId/chats", async (c) => {
      const { accountId } = c.req.param();
      return this.handleChats(await buildCtx(c, { account_id: accountId }));
    });
    lq.get("/livequery/accounts/:accountId/hosts/:hostId/chats", async (c) => {
      const { accountId, hostId } = c.req.param();
      return this.handleHostChats(await buildCtx(c, { account_id: accountId, host_id: hostId }));
    });

    lq.post("/livequery/accounts/:accountId/chats/:chatId/:action{~.+}", async (c) => {
      const { accountId, chatId } = c.req.param();
      const action = (c.req.param("action") ?? "").replace(/^~/, "");
      return this.runAction(action, await buildCtx(c, { account_id: accountId, chat_id: chatId }));
    });
    lq.post("/livequery/accounts/:accountId/hosts/:hostId/chats/:chatId/:action{~.+}", async (c) => {
      const { accountId, hostId, chatId } = c.req.param();
      const action = (c.req.param("action") ?? "").replace(/^~/, "");
      return this.runAction(action, await buildCtx(c, { account_id: accountId, host_id: hostId, chat_id: chatId }));
    });
  }

  private readonly terminalThreads = new Map<string, string>(); // accountId:chatId → ephemeral threadId

  private runAction(action: string, ctx: LivequeryContext): Promise<Response> | Response {
    switch (action) {
      case "send-message": return this.sendMessage(ctx);
      case "cancel-chat": return this.cancelChat(ctx);
      case "archive-chat": return this.archiveChat(ctx);
      case "recover-chat": return this.recoverChat(ctx);
      case "mark-read": return this.markRead(ctx);
      case "shell-command": return this.shellCommand(ctx);
      case "approve-action": return this.approveAction(ctx);
      default: return error("ACTION_NOT_FOUND", `Unknown chat action: ${action}`, 404);
    }
  }

  // ─── Collection handlers ─────────────────────────────────────────────────────

  private handleChats(ctx: LivequeryContext): Response {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Chats collection only supports GET", 405);
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id", 400);
    const taskFilter = String(ctx.livequery?.query?.task_filter ?? "all");
    this.store.refreshChatsInBackground(accountId, { taskFilter });
    return json({ data: collectionResponse(this.store.chatsCache.get(accountId) ?? [], { collection: "chats", account_id: accountId }) });
  }

  private async handleHostChats(ctx: LivequeryContext): Promise<Response> {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Method not allowed", 405);
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id", 400);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    this.store.trackActiveHostChats(accountId, hostId);
    try {
      // Lịch sử chat; realtime đổi trạng thái do central event$ hook publish.
      const history = await this.store.streamChats(account, accountId, hostId);
      this.store.hostChatsCache.set(`${accountId}:${hostId}`, history);   // cho recover ở handleTurns
      this.store.hostChatsFetchedAt.set(`${accountId}:${hostId}`, Date.now());
      return json({ data: collectionResponse(history, { collection: "chats", account_id: accountId, host_id: hostId }) });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────────

  private async sendMessage(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "");
    const input = String(payload.input ?? "");
    if (!accountId || !chatId || !input) return error("BAD_REQUEST", "Missing account_id, chat_id or input");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const { kind: envKind, envId: parsedEnvId } = parseEnvId(typeof payload.environment_id === "string" ? payload.environment_id : undefined);
    const localChat = this.store.localChats.get(chatId) ?? (envKind === "selfhost"
      ? (() => { const e: LocalChatEntry = { accountId, hostId: parsedEnvId, conversationId: chatId }; this.store.localChats.set(chatId, e); return e; })()
      : undefined);

    if (localChat) {
      this.store.chatHostId.set(chatId, localChat.hostId);
      try {
        // Gửi THẲNG tới remote (turn/start resume). Turn được STREAM realtime publish.
        const rc = await this.registry.getRC(account, localChat.hostId);
        const threadId = localChat.rcThreadId ?? chatId;
        // Stream đã được streamChatTurns thiết lập khi mở chat; gửi xong turn tự về qua đó.
        const sent = await rc.sendMessage(input, { threadId, workspaceRoot: localChat.cwd, images: parseImages(payload), envId: localChat.hostId });
        localChat.rcThreadId = sent.threadId || threadId;
        localChat.isNew = false;
        return json({ data: { ok: true, chat_id: chatId } });
      } catch (err) {
        return error("UPSTREAM_ERROR", String(err), 502);
      }
    }

    // Cloud WHAM
    const previousResponseId = this.store.latestResponseIds.get(chatId);
    this.store.pendingInputs.set(chatId, { input: [{ role: "user", content: input }], previousResponseId, environmentId: parsedEnvId || undefined });
    return json({ data: { ok: true, chat_id: chatId } });
  }

  private async cancelChat(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const localChat = this.store.localChats.get(chatId);
    if (localChat) {
      if (localChat.rcThreadId) {
        const threadId = localChat.rcThreadId;
        this.registry.getRC(account, localChat.hostId).then((rc) => rc.stopThread(threadId, localChat.hostId)).catch(() => {});
      }
      this.store.cancelRcStream(`${accountId}:${chatId}`);
      return json({ data: { ok: true } });
    }
    try {
      await this.codexApi.cancelTask(account, chatId);
      this.store.cancelSseStream(`${accountId}:${chatId}`);
      this.store.refreshChatsInBackground(accountId, {}, true);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private async archiveChat(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      await this.codexApi.archiveTask(account, chatId);
      this.store.refreshChatsInBackground(accountId, {}, true);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private async recoverChat(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      await this.codexApi.recoverTask(account, chatId);
      this.store.refreshChatsInBackground(accountId, {}, true);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private async markRead(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      await this.codexApi.markTaskRead(account, chatId);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private async shellCommand(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "term");
    const command = String(payload.command ?? "");
    if (!accountId || !command) return error("BAD_REQUEST", "Missing account_id or command");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    const { envId: parsedHost } = parseEnvId(typeof payload.environment_id === "string" ? payload.environment_id : undefined);
    const hostId = this.store.localChats.get(chatId)?.hostId ?? this.store.chatHostId.get(chatId) ?? parsedHost;
    if (!hostId) return error("NOT_FOUND", "Chat host not found", 404);
    try {
      const rc = await this.registry.getRC(account, hostId);
      const tkey = `${accountId}:${chatId}`;
      const res = await rc.shellCommand(command, { threadId: this.terminalThreads.get(tkey), timeout: 60_000, envId: hostId });
      this.terminalThreads.set(tkey, res.threadId);
      return json({ data: { output: res.output, exit_code: res.exitCode } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private async approveAction(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? payload.chat_id ?? "");
    const decision = String(payload.decision ?? "approve");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    const localChat = this.store.localChats.get(chatId);
    const hostId = localChat?.hostId ?? this.store.chatHostId.get(chatId);
    if (!hostId) return error("NOT_FOUND", "Chat host not found", 404);
    try {
      const rc = await this.registry.getRC(account, hostId);
      await rc.approveAction(localChat?.rcThreadId ?? chatId, { reject: decision === "reject" }, hostId);
      return json({ data: { ok: true } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }
}
