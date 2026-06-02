import { Hono } from "hono";
import { createLivequery } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import type { AccountsService } from "../services/accounts";
import type { RemoteControlRegistry } from "../libs/codex-remote-control";
import { LivequeryStore, json, error, parseEnvId, parseImages, collectionResponse, type ChatDocument } from "../services/livequery";
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
      case "folder-list": return this.folderList(ctx);
      case "folder-create": return this.folderCreate(ctx);
      case "create-chat": return this.createChat(ctx);
      default: return error("ACTION_NOT_FOUND", `Unknown host action: ${action}`, 404);
    }
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private async getRemoteShell(accountId: string, hostId: string) {
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    return this.registry.getRC(account, hostId);
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

  private async folderList(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    const requestedPath = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id");
    try {
      const rc = await this.getRemoteShell(accountId, hostId);
      const baseExpr = requestedPath ? this.shellQuote(requestedPath) : '"$HOME"';
      const command = [
        `base=${baseExpr}`,
        `if [ ! -d "$base" ]; then echo "__ERR__not a directory: $base"; exit 2; fi`,
        `real="$(cd "$base" && pwd -P)"`,
        `printf '__BASE__%s\\n' "$real"`,
        `find "$real" -mindepth 1 -maxdepth 1 -type d \\( -name .git -o -name node_modules -o -name .next -o -name dist -o -name build \\) -prune -o -type d -print 2>/dev/null | sort`,
      ].join("; ");
      const result = await rc.shellCommand(command, { timeout: 20_000, envId: hostId });
      const lines = result.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const err = lines.find((l) => l.startsWith("__ERR__"));
      if (err) return error("BAD_REQUEST", err.replace(/^__ERR__/, ""), 400);
      const base = lines.find((l) => l.startsWith("__BASE__"))?.replace(/^__BASE__/, "") ?? requestedPath;
      const dirs = lines
        .filter((l) => !l.startsWith("__BASE__") && !l.startsWith("__ERR__"))
        .map((path) => ({ path, name: path.split("/").filter(Boolean).pop() ?? path }));
      return json({ data: { ok: true, path: base, dirs } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  private async folderCreate(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!accountId || !hostId || !path) return error("BAD_REQUEST", "Missing account_id, host_id or path");
    try {
      const rc = await this.getRemoteShell(accountId, hostId);
      const command = `mkdir -p ${this.shellQuote(path)} && cd ${this.shellQuote(path)} && printf '__CREATED__%s\\n' "$(pwd -P)"`;
      const result = await rc.shellCommand(command, { timeout: 20_000, envId: hostId });
      const created = result.output.split(/\r?\n/).find((l) => l.startsWith("__CREATED__"))?.replace(/^__CREATED__/, "") ?? path;
      return json({ data: { ok: true, path: created } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }

  /** create-chat qua host ref → luôn là chat Desktop App (selfhost). */
  private async createChat(ctx: LivequeryContext): Promise<Response> {
    const payload = (ctx.request.body ?? {}) as Record<string, unknown>;
    const accountId = String(ctx.livequery?.keys?.account_id ?? payload.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    const input = String(payload.input ?? "");
    if (!accountId || !input) return error("BAD_REQUEST", "Missing account_id or input");
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);

    const { kind, envId } = parseEnvId(typeof payload.environment_id === "string" ? payload.environment_id : (hostId ? `selfhost:${hostId}` : undefined));
    if (kind !== "selfhost") return error("BAD_REQUEST", "Host create-chat requires a selfhost env");

    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    const title = typeof payload.title === "string" ? payload.title : input.slice(0, 60);
    try {
      // Tạo thread THẬT trên remote + submit turn đầu NGAY, rồi dùng threadId thật làm chatId.
      // Tránh phân kỳ id (UUID local vs threadId remote) khiến turn/status realtime định tuyến sai
      // (chat rỗng, spinner kẹt) và message bị mất (thread/start không submit input).
      const rc = await this.registry.getRC(account, envId);
      const sent = await rc.sendMessage(input, { threadId: undefined, workspaceRoot: cwd, images: parseImages(payload), envId });
      const chatId = sent.threadId;
      if (!chatId) throw new Error("Remote did not return a thread id");
      this.store.localChats.set(chatId, { accountId, hostId: envId, conversationId: chatId, rcThreadId: chatId, cwd, title, isNew: false });
      const chatDoc = {
        id: chatId,
        title,
        status: "in_progress",
        environment_id: `selfhost:${envId}`,
        workspace_root: cwd,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_id: accountId,
      } as unknown as ChatDocument;
      this.store.registerLocalChat(accountId, envId, chatDoc);
      this.store.addReport({ type: "chat_created", accountId, chatId, local: true, hostId: envId, cwd, timestamp: Date.now() });
      return json({ data: { ok: true, chat_id: chatId } });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }
}
