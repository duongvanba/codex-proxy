import { Hono } from "hono";
import { createLivequery } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import type { AccountsService } from "../services/accounts";
import type { RemoteControlRegistry } from "../libs/codex-remote-control";
import { LivequeryStore, json, error, parseEnvId, parseImages, collectionResponse } from "../services/livequery";
import { buildCtx, type LivequeryDeps } from "./_livequery";

/** Collection `accounts/:id/hosts` + actions cấp host (workspace-options, create-chat selfhost). */
export class HostsController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly accounts: AccountsService,
    private readonly registry: RemoteControlRegistry,
    deps: LivequeryDeps
  ) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });

    lq.get("/livequery/accounts/:accountId/hosts", async (c) => {
      const { accountId } = c.req.param();
      return this.handleHosts(await buildCtx(c, { account_id: accountId }));
    });

    lq.post("/livequery/accounts/:accountId/hosts/:hostId/:action{~.+}", async (c) => {
      const { accountId, hostId } = c.req.param();
      const action = (c.req.param("action") ?? "").replace(/^~/, "");
      return this.runAction(action, await buildCtx(c, { account_id: accountId, host_id: hostId }));
    });
  }

  private handleHosts(ctx: LivequeryContext): Response {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Hosts collection only supports GET", 405);
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id", 400);
    this.store.refreshHostsInBackground(accountId);
    return json({ data: collectionResponse(this.store.getHostsForAccount(accountId), { collection: "hosts", account_id: accountId }) });
  }

  private runAction(action: string, ctx: LivequeryContext): Promise<Response> | Response {
    switch (action) {
      case "workspace-options": return this.workspaceOptions(ctx);
      case "create-chat": return this.createChat(ctx);
      default: return error("ACTION_NOT_FOUND", `Unknown host action: ${action}`, 404);
    }
  }

  private async workspaceOptions(ctx: LivequeryContext): Promise<Response> {
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    try {
      const projects = await this.registry.fetchRemoteProjects(account, hostId);
      return json({ data: { ok: true, options: projects.map((p) => ({ path: p.remotePath, label: p.label })) } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  /** create-chat qua host ref → luôn là chat Desktop App (selfhost). */
  private createChat(ctx: LivequeryContext): Response {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    const input = String(payload.input ?? "");
    if (!accountId || !input) return error("BAD_REQUEST", "Missing account_id or input");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const { kind, envId } = parseEnvId(typeof payload.environment_id === "string" ? payload.environment_id : (hostId ? `selfhost:${hostId}` : undefined));
    if (kind !== "selfhost") return error("BAD_REQUEST", "Host create-chat requires a selfhost env");

    const chatId = crypto.randomUUID();
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const title = typeof payload.title === "string" ? payload.title : input.slice(0, 60);
    this.store.localChats.set(chatId, { accountId, hostId: envId, conversationId: chatId, cwd, title, isNew: true });
    this.store.chatHostId.set(chatId, envId);
    this.store.pendingInputs.set(chatId, { input: [{ role: "user", content: input }], environmentId: `selfhost:${envId}`, images: parseImages(payload) });
    this.store.addReport({ type: "chat_created", accountId, chatId, local: true, hostId: envId, cwd, timestamp: Date.now() });
    return json({ data: { ok: true, chat_id: chatId } });
  }
}
