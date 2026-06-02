import { Hono } from "hono";
import { createLivequery } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";
import { LivequeryStore, REPORT_LIMIT, json, collectionResponse } from "../services/livequery";
import { buildCtx, type LivequeryDeps } from "./_livequery";

/** Collection `reports` (request log / events). */
export class ReportsController extends Hono {
  constructor(private readonly store: LivequeryStore, deps: LivequeryDeps) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });
    lq.get("/livequery/reports", async (c) => this.handleReports(await buildCtx(c)));
  }

  private handleReports(ctx: LivequeryContext): Response {
    if (ctx.request.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Reports collection only supports GET" } }, { status: 405 });
    const limit = Number(ctx.livequery?.query[":limit"] ?? REPORT_LIMIT);
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(REPORT_LIMIT, Math.floor(limit))) : REPORT_LIMIT;
    const summary = { collection: "reports", total: this.store.reports.length, newestAt: this.store.reports[0]?.timestamp ?? null };
    return json({ data: collectionResponse(this.store.reports.slice(0, bounded), summary) });
  }
}
