import { Hono } from "hono";
import { createLivequery, livequeryJson } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import type { AccountsService } from "../services/accounts";
import type { ConfigPatcherService } from "../services/config-patcher";
import type { LoggerService } from "../services/logger";
import type { CodexApiService } from "../libs/chatgpt";
import type { EnrollmentService, LoginFlowService } from "../libs/openai";
import type { RemoteControlRegistry } from "../libs/codex-remote-control";
import { LivequeryStore, json, error, parseEnvId, resolveOpenaiBaseUrl, serializeAccount, collectionResponse } from "../services/livequery";
import { buildCtx, type LivequeryDeps } from "./_livequery";

/** Collection `accounts` + doc `rc-hosts` + actions cấp account/collection (login, config, enroll, refresh, cloud create-chat, rc-shell). */
export class AccountsController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly accounts: AccountsService,
    private readonly enrollment: EnrollmentService,
    private readonly loginFlow: LoginFlowService,
    private readonly logger: LoggerService,
    private readonly configPatcher: ConfigPatcherService,
    private readonly codexApi: CodexApiService,
    private readonly registry: RemoteControlRegistry,
    private readonly deps: LivequeryDeps
  ) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });

    lq.get("/livequery/accounts", async (c) => this.handleAccounts(await buildCtx(c)));

    lq.get("/livequery/accounts/:accountId/rc-hosts", async (c) => {
      const { accountId } = c.req.param();
      const entry = await this.enrollment.getEnrollment(accountId);
      const hosts = this.store.getHostsForAccount(accountId);
      return livequeryJson(c, { data: { item: {
        id: accountId, enrolled: !!entry, client_id: entry?.clientId, token_expires_at: entry?.tokenExpiresAt,
        hosts: hosts.map((h) => ({ env_id: h.env_id, name: (h as any).name })),
      } } } as any);
    });

    // rc-shell: streaming SSE (route literal, đặt trước catch-all)
    lq.post("/livequery/accounts/:accountId/~rc-shell", async (c) => {
      const { accountId } = c.req.param();
      return this.rcShell(await buildCtx(c, { account_id: accountId }));
    });

    // Actions cấp collection + cấp account
    lq.post("/livequery/accounts/:action{~.+}", async (c) => {
      const action = (c.req.param("action") ?? "").replace(/^~/, "");
      return this.runAction(action, await buildCtx(c), new URL(c.req.url).origin);
    });
    lq.post("/livequery/accounts/:accountId/:action{~.+}", async (c) => {
      const { accountId } = c.req.param();
      const action = (c.req.param("action") ?? "").replace(/^~/, "");
      return this.runAction(action, await buildCtx(c, { account_id: accountId }), new URL(c.req.url).origin);
    });
  }

  private runAction(action: string, ctx: LivequeryContext, origin: string): Promise<Response> | Response {
    switch (action) {
      case "refresh-usage": return this.refreshUsage();
      case "select-account": return this.selectAccount(ctx);
      case "remove-account": return this.removeAccount(ctx);
      case "login-status": return json({ data: { in_progress: this.loginFlow.isLoginInProgress() } });
      case "start-login": return this.startLogin();
      case "cancel-login": return this.cancelLogin();
      case "import-callback": return this.importCallback(ctx);
      case "config-status": return json({ data: { enabled: this.configPatcher.isCodexConfigPatched(this.effectiveBaseUrl(ctx)) } });
      case "set-config": return this.setConfig(ctx);
      case "rc-enroll-start": return this.rcEnrollStart(ctx, origin);
      case "rc-enroll-delete": return this.rcEnrollDelete(ctx);
      case "rc-enroll-callback": return this.rcEnrollCallback(ctx);
      case "refresh-hosts": return this.refreshHosts(ctx);
      case "refresh-projects": this.store.triggerRefreshProjects(); return json({ data: { ok: true } });
      case "refresh-chats": return this.refreshChats(ctx);
      case "create-chat": return this.createChatCloud(ctx);
      default: return error("ACTION_NOT_FOUND", `Unknown account action: ${action}`, 404);
    }
  }

  private effectiveBaseUrl(ctx: LivequeryContext): string {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    return resolveOpenaiBaseUrl(payload.public_base_url, this.deps.openaiBaseUrl);
  }

  // ─── Collection + health ───────────────────────────────────────────────────────

  private async handleAccounts(ctx: LivequeryContext): Promise<Response> {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Accounts collection only supports GET", 405);
    const docs = await Promise.all(this.accounts.getAccounts().map(async (account) => ({
      ...serializeAccount(account, { pendingQuotaTimers: true }),
      enrolled: !!(await this.enrollment.getEnrollment(account.id)),
    })));
    this.store.refreshAccountsUsageInBackground();
    return json({ data: collectionResponse(docs, { collection: "accounts" }) });
  }

  // ─── Account actions ───────────────────────────────────────────────────────────

  private async refreshUsage(): Promise<Response> {
    await this.accounts.refreshCodexUsageForAccounts(true);
    this.store.notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  private selectAccount(ctx: LivequeryContext): Response {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const id = String(ctx.livequery?.keys?.account_id ?? payload.id ?? "");
    if (!id) return error("BAD_REQUEST", "Missing account id");
    const result = this.accounts.setSelectedAccount(id);
    if (!result.ok) return error("BAD_REQUEST", result.error ?? "Could not select account");
    const email = this.accounts.getAccounts().find((a) => a.id === id)?.email ?? id;
    this.logger.logEvent("account_selected", email);
    this.store.addReport({ type: "account_selected", email, timestamp: Date.now() });
    this.store.notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  private removeAccount(ctx: LivequeryContext): Response {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const id = String(ctx.livequery?.keys?.account_id ?? payload.id ?? "");
    if (!id) return error("BAD_REQUEST", "Missing account id");
    const result = this.accounts.removeAccount(id);
    if (!result.ok) return error("BAD_REQUEST", result.error ?? "Could not remove account");
    this.logger.logEvent("account_removed", id);
    this.store.addReport({ type: "account_removed", accountId: id, timestamp: Date.now() });
    this.store.publishAccountRemoved(id);
    this.store.notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  private startLogin(): Response {
    const sendLoginEvent = (entry: object) => {
      this.store.addReport({ ...(entry as Record<string, unknown>), timestamp: Date.now(), type: String((entry as Record<string, unknown>).type ?? "login_event") });
    };
    const result = this.loginFlow.startLoginFlow(
      (email) => { this.logger.logEvent("login_success", email); this.store.addReport({ type: "login_success", email, timestamp: Date.now() }); this.store.notifyAccountsChanged(); },
      (err) => { this.logger.logEvent("login_error", err); this.store.addReport({ type: "login_error", error: err, timestamp: Date.now() }); },
      sendLoginEvent
    );
    if (!result.ok) return error("CONFLICT", result.error, 409);
    this.logger.logEvent("login_started", "callback port=1455");
    this.store.addReport({ type: "login_started", timestamp: Date.now() });
    return json({ data: { ok: true, authorize_url: result.authorizeUrl } });
  }

  private cancelLogin(): Response {
    const cancelled = this.loginFlow.cancelLoginFlow("cancelled from Web UI");
    if (cancelled) this.store.addReport({ type: "login_cancelled", timestamp: Date.now() });
    return json({ data: { ok: true, cancelled, in_progress: this.loginFlow.isLoginInProgress() } });
  }

  private async importCallback(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const importInput =
      typeof payload.import_input === "string" ? payload.import_input.trim() :
      typeof payload.callback_url === "string" ? payload.callback_url.trim() : "";
    if (!importInput) return error("BAD_REQUEST", "Missing import input");
    const result = await this.loginFlow.importAccountInput(importInput);
    if (!result.ok) {
      const message = result.error ?? "Import callback failed";
      this.logger.logEvent("login_import_error", message);
      this.store.addReport({ type: "login_import_error", error: message, timestamp: Date.now() });
      return error("BAD_REQUEST", message);
    }
    this.store.notifyAccountsChanged();
    return json({ data: { ok: true, email: result.email } });
  }

  private async setConfig(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const baseUrl = this.effectiveBaseUrl(ctx);
    const enabled = Boolean(payload.enabled);
    const shouldRestartCodex = Boolean(payload.restart_codex);
    if (enabled) this.configPatcher.patchCodexConfig(baseUrl);
    else this.configPatcher.restoreCodexConfig();
    this.configPatcher.saveProxyState(enabled);
    if (shouldRestartCodex) await this.deps.restartCodex();
    const state = this.configPatcher.isCodexConfigPatched(baseUrl);
    this.logger.logEvent("config_proxy", state ? "enabled" : "disabled");
    this.store.addReport({ type: "config_proxy", enabled: state, restarted: shouldRestartCodex, timestamp: Date.now() });
    return json({ data: { ok: true, enabled: state, restarted: shouldRestartCodex } });
  }

  private refreshHosts(ctx: LivequeryContext): Response {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id");
    this.store.triggerRefreshHosts(accountId);
    return json({ data: { ok: true } });
  }

  private refreshChats(ctx: LivequeryContext): Response {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id");
    this.store.triggerRefreshChats(accountId);
    return json({ data: { ok: true } });
  }

  // ─── Remote Control enroll ─────────────────────────────────────────────────────

  private async rcEnrollStart(ctx: LivequeryContext, origin: string): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      return json({ data: await this.enrollment.startEnrollment(account, origin) });
    } catch (e) {
      return error("UPSTREAM_ERROR", e instanceof Error ? e.message : String(e), 500);
    }
  }

  private async rcEnrollDelete(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    this.registry.invalidateRC(accountId);
    await this.enrollment.deleteEnrollment(accountId);
    this.store.notifyAccountsChanged();
    return json({ data: { ok: true } });
  }

  private async rcEnrollCallback(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const callbackUrl = typeof payload.callback_url === "string" ? payload.callback_url.trim() : "";
    if (!callbackUrl) return error("BAD_REQUEST", "Missing callbackUrl");
    let code = "", state = "";
    try {
      const u = new URL(callbackUrl);
      code = u.searchParams.get("code") ?? "";
      state = u.searchParams.get("state") ?? "";
      const oauthError = u.searchParams.get("error");
      if (oauthError) return error("BAD_REQUEST", `Enroll failed: ${oauthError}`);
    } catch {
      return error("BAD_REQUEST", "Invalid callback URL");
    }
    if (!code || !state) return error("BAD_REQUEST", "callbackUrl thiếu code hoặc state");
    try {
      await this.enrollment.completeEnrollmentWithCode(state, code);
      this.store.notifyAccountsChanged();
      return json({ data: { ok: true } });
    } catch (e) {
      return error("UPSTREAM_ERROR", e instanceof Error ? e.message : String(e), 500);
    }
  }

  // ─── Cloud create-chat ─────────────────────────────────────────────────────────

  private async createChatCloud(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const input = String(payload.input ?? "");
    const modelSlug = typeof payload.model_slug === "string" ? payload.model_slug : "gpt-5.5";
    if (!accountId || !input) return error("BAD_REQUEST", "Missing account_id or input");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const { kind, envId } = parseEnvId(typeof payload.environment_id === "string" ? payload.environment_id : undefined);
    try {
      const task = await this.codexApi.createTask(account, {
        input_items: [{ type: "message", role: "user", content: [{ content_type: "text", text: input }] }],
        environment_id: kind === "none" ? undefined : envId,
        model_slug: modelSlug,
      });
      const chatId = task.task_id;
      if (!chatId) return error("UPSTREAM_ERROR", "Task created without ID", 502);
      if (envId) this.store.chatHostId.set(chatId, envId);
      this.store.pendingInputs.set(chatId, { input: [{ role: "user", content: input }], environmentId: envId || undefined });
      this.store.refreshChatsInBackground(accountId, {}, true);
      this.store.addReport({ type: "chat_created", accountId, chatId, timestamp: Date.now() });
      return json({ data: { ok: true, chat_id: chatId } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  // ─── rc-shell (streaming) ──────────────────────────────────────────────────────

  private async rcShell(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const envId = String(payload.env_id ?? "");
    const command = String(payload.command ?? "");
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const threadId = typeof payload.thread_id === "string" ? payload.thread_id : undefined;
    if (!accountId || !envId || !command) return error("BAD_REQUEST", "Missing account_id, env_id, or command");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    let rc;
    try {
      rc = await this.registry.getRC(account, envId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return error(msg.includes("not enrolled") ? "FORBIDDEN" : "UPSTREAM_ERROR", msg, msg.includes("not enrolled") ? 403 : 502);
    }

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
        try {
          const result = await rc.shellCommand(command, { threadId, cwd, onDelta: (delta) => send({ delta }), envId });
          send({ done: true, exit_code: result.exitCode, thread_id: result.threadId });
        } catch (e) {
          send({ error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
  }
}
