import { Hono } from "hono";
import { createLivequery, livequeryJson } from "@livequery/honojs";
import { LivequeryStore } from "../services/livequery";
import type { ConfigPatcherService } from "../services/config-patcher";
import type { LoginFlowService } from "../libs/openai";
import type { LivequeryDeps } from "./_livequery";

/** Document đơn (config / session / runtime) + endpoint /health. */
export class RuntimeController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly configPatcher: ConfigPatcherService,
    private readonly loginFlow: LoginFlowService,
    deps: LivequeryDeps
  ) {
    super();
    const lq = createLivequery(this, { websocketGateway: deps.websocketGateway });

    lq.get("/livequery/config", (c) =>
      livequeryJson(c, { data: { item: { id: "status", enabled: this.configPatcher.isCodexConfigPatched(deps.openaiBaseUrl) } } } as any));

    lq.get("/livequery/session", (c) =>
      livequeryJson(c, { data: { item: { id: "login", in_progress: this.loginFlow.isLoginInProgress() } } } as any));

    lq.get("/livequery/runtime", (c) => {
      const origin = new URL(c.req.url).origin;
      const wsProto = origin.startsWith("https") ? "wss" : "ws";
      const wsOrigin = origin.replace(/^https?/, wsProto);
      return livequeryJson(c, { data: { item: { id: "runtime", realtime_url: `${wsOrigin}/livequery/realtime-updates` } } } as any);
    });

    this.get("/health", (c) => c.json(this.store.getHealth(deps.openaiBaseUrl)));
  }
}
