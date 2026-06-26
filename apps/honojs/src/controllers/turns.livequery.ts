import { Hono } from "hono";
import { createLivequery } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import type { AccountsService } from "../services/accounts";
import type { CodexApiService } from "../libs/chatgpt";
import type { RemoteControlRegistry } from "../libs/codex-remote-control";
import type { SseStreamService, SseEvent } from "../services/sse-stream";
import { LivequeryStore, json, error, parseEnvId, collectionResponse, type TurnDocument } from "../services/livequery";
import { buildCtx, type LivequeryDeps } from "./_livequery";

/** Collection `turns` của một chat (account-scoped + host-scoped). */
export class TurnsController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly accounts: AccountsService,
    private readonly codexApi: CodexApiService,
    private readonly registry: RemoteControlRegistry,
    private readonly sseStream: SseStreamService,
    deps: LivequeryDeps
  ) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });

    lq.get("/livequery/accounts/:accountId/chats/:chatId/turns", async (c) => {
      const { accountId, chatId } = c.req.param();
      return this.handleTurns(await buildCtx(c, { account_id: accountId, chat_id: chatId }));
    });
    lq.get("/livequery/accounts/:accountId/hosts/:hostId/chats/:chatId/turns", async (c) => {
      const { accountId, hostId, chatId } = c.req.param();
      return this.handleTurns(await buildCtx(c, { account_id: accountId, host_id: hostId, chat_id: chatId }));
    });
  }

  private async handleTurns(ctx: LivequeryContext): Promise<Response> {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Turns collection only supports GET", 405);
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    const chatId = String(ctx.livequery?.keys?.chat_id ?? "");
    if (!accountId || !chatId) return error("BAD_REQUEST", "Missing account_id or chat_id", 400);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    // Recover sau reload/direct URL: route host-scoped đã có đủ hostId, không cần chờ hostChatsCache warm.
    if (!this.store.localChats.has(chatId) && hostId) {
      this.store.localChats.set(chatId, { accountId, hostId, conversationId: chatId });
    }

    // Recover sau restart từ account-scoped route: tìm trong hostChatsCache nếu chưa có trong localChats.
    if (!this.store.localChats.has(chatId)) {
      for (const [key, docs] of this.store.hostChatsCache.entries()) {
        const [cacheAccountId, cacheHostId] = key.split(":");
        if (cacheAccountId !== accountId) continue;
        const doc = docs.find((d) => d.id === chatId);
        if (doc) {
          const { kind, envId: recoveredHostId } = parseEnvId(doc.environment_id ?? `selfhost:${cacheHostId}`);
          if (kind === "selfhost") this.store.localChats.set(chatId, { accountId, hostId: recoveredHostId, conversationId: chatId });
          break;
        }
      }
    }

    const localChat = this.store.localChats.get(chatId);
    if (localChat) {
      this.store.chatHostId.set(chatId, localChat.hostId);
      const pending = this.store.pendingInputs.get(chatId);
      try {
        const rc = await this.registry.getRC(account, localChat.hostId);
        let threadId = localChat.rcThreadId ?? chatId;

        if (pending) {
          this.store.pendingInputs.delete(chatId);
          const inputText = Array.isArray(pending.input)
            ? String((pending.input[0] as Record<string, unknown>)?.content ?? "")
            : String(pending.input ?? "");
          const sendThreadId = localChat.rcThreadId ?? (localChat.isNew ? undefined : chatId);
          const sent = await rc.sendMessage(inputText, { threadId: sendThreadId, workspaceRoot: localChat.cwd, images: pending.images, envId: localChat.hostId });
          threadId = sent.threadId || sendThreadId || chatId;
          localChat.isNew = false;
        }
        localChat.rcThreadId = threadId;

        // Lịch sử turn; realtime đi qua central event$ hook publish vào turnRefs.
        const history = await this.store.streamChatTurns(account, accountId, chatId, threadId, localChat.hostId);
        return json({ data: collectionResponse(history, { collection: "turns", account_id: accountId, chat_id: chatId }) });
      } catch (err) {
        this.store.addReport({ type: "local_turn_error", accountId, chatId, error: String(err), timestamp: Date.now() });
        return json({ data: collectionResponse([], { collection: "turns", account_id: accountId, chat_id: chatId }) });
      }
    }

    // ── Cloud WHAM chat ──
    try {
      const { turns, current_turn_id } = await this.codexApi.fetchTurns(account, chatId);
      const docs: TurnDocument[] = turns.map((t) => ({ ...t, account_id: accountId, chat_id: chatId }));
      const pending = this.store.pendingInputs.get(chatId);
      if (pending) {
        this.store.pendingInputs.delete(chatId);
        const stream$ = this.sseStream.createOrGetSseStream(account, chatId, pending);
        this.subscribeToSseStream(accountId, chatId, stream$);
      } else {
        const existing = this.sseStream.getActiveStream(`${accountId}:${chatId}`);
        if (existing) this.subscribeToSseStream(accountId, chatId, existing);
      }
      return json({ data: collectionResponse(docs, { collection: "turns", account_id: accountId, chat_id: chatId, current_turn_id }) });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private subscribeToSseStream(accountId: string, chatId: string, observable: ReturnType<SseStreamService["getActiveStream"]>) {
    if (!observable) return;
    const key = `${accountId}:${chatId}`;
    if (this.store.activeSseSubscriptions.has(key)) return;

    const sub = observable.subscribe({
      next: (event: SseEvent) => {
        if (event.type === "error") return;
        if (event.type === "completed" && event.responseId) this.store.latestResponseIds.set(chatId, event.responseId);
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
        const turnKey = `${accountId}:${chatId}`;
        if (!this.store.addedTurnIds.has(turnKey)) this.store.addedTurnIds.set(turnKey, new Set());
        const seenIds = this.store.addedTurnIds.get(turnKey)!;
        const changeType = seenIds.has(turnDoc.id) ? "modified" : "added";
        seenIds.add(turnDoc.id);
        this.store.publishRealtimeChanges(this.store.turnRefs(accountId, chatId).map((ref) => ({ ref, type: changeType, data: turnDoc as unknown as Record<string, unknown> })));
      },
      error: (err: unknown) => {
        this.store.cancelSseStream(key);
        this.store.addReport({ type: "sse_error", accountId, chatId, error: String(err), timestamp: Date.now() });
      },
      complete: () => {
        this.store.cancelSseStream(key);
        this.store.addedTurnIds.delete(key);
        this.store.refreshChatsInBackground(accountId, {}, true);
      },
    });
    this.store.activeSseSubscriptions.set(key, sub);
  }
}
