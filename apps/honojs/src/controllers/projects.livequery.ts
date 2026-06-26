import { Hono } from "hono";
import { createLivequery } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import type { AccountsService } from "../services/accounts";
import type { RemoteControlRegistry } from "../libs/codex-remote-control";
import { LivequeryStore, json, error, collectionResponse, type ProjectDocument } from "../services/livequery";
import { buildCtx, type LivequeryDeps } from "./_livequery";

/** Collection projects: cấp account (cloud) và cấp host (hostId = env_id). */
export class ProjectsController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly accounts: AccountsService,
    private readonly registry: RemoteControlRegistry,
    deps: LivequeryDeps
  ) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });

    lq.get("/livequery/accounts/:accountId/projects", async (c) => {
      const { accountId } = c.req.param();
      return this.handleProjectsCollection(await buildCtx(c, { account_id: accountId }));
    });
    lq.get("/livequery/accounts/:accountId/hosts/:hostId/projects", async (c) => {
      const { accountId, hostId } = c.req.param();
      return this.handleHostProjects(await buildCtx(c, { account_id: accountId, host_id: hostId }));
    });
  }

  private handleProjectsCollection(ctx: LivequeryContext): Response {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Projects collection only supports GET", 405);
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    if (!accountId) return error("BAD_REQUEST", "Missing account_id", 400);
    this.store.refreshProjectsInBackground();

    const accountHosts = this.store.hostsCache.get(accountId);
    let items: ProjectDocument[];
    if (accountHosts && accountHosts.length > 0) {
      const envIds = new Set(accountHosts.map((h) => `remote-control:${h.env_id}`));
      items = this.store.projectsCacheState.items.filter((p) => envIds.has(p.hostId)).map((p) => ({ ...p, account_id: accountId }));
    } else {
      items = this.store.projectsCacheState.items.map((p) => ({ ...p, account_id: accountId }));
    }
    if (!accountHosts) this.store.refreshHostsInBackground(accountId);
    return json({ data: collectionResponse(items, { collection: "projects", account_id: accountId }) });
  }

  private async handleHostProjects(ctx: LivequeryContext): Promise<Response> {
    if (ctx.request.method !== "GET") return error("METHOD_NOT_ALLOWED", "Method not allowed", 405);
    const accountId = String(ctx.livequery?.keys?.account_id ?? "");
    const hostId = String(ctx.livequery?.keys?.host_id ?? "");
    if (!accountId || !hostId) return error("BAD_REQUEST", "Missing account_id or host_id", 400);
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) return error("NOT_FOUND", "Account not found", 404);
    this.store.trackActiveHostProjects(accountId, hostId);
    try {
      const remoteProjects = await this.registry.fetchRemoteProjects(account, hostId);
      const items: ProjectDocument[] = remoteProjects.map((p) => ({ ...p, source: "global-state" as const, account_id: accountId }));
      this.store.hostProjectsCache.set(`${accountId}:${hostId}`, items);
      return json({ data: collectionResponse(items, { collection: "projects", account_id: accountId, host_id: hostId }) });
    } catch (err) {
      return error("UPSTREAM_ERROR", String(err), 502);
    }
  }
}
