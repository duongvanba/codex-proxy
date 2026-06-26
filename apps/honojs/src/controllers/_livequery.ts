import { getLivequeryRequest, type WebsocketGateway } from "@livequery/honojs";
import type { LivequeryContext } from "@livequery/core";

/** Runtime config dùng chung cho mọi LiveQuery controller. */
export type LivequeryDeps = {
  websocketGateway: WebsocketGateway;
  openaiBaseUrl: string;
  restartCodex: () => Promise<void>;
};

type HonoCtx = Parameters<typeof getLivequeryRequest>[0];

/** Bắc cầu request Hono → LivequeryContext, gắn thêm keys (account_id, host_id, chat_id). */
export async function buildCtx(c: HonoCtx, extraKeys: Record<string, string> = {}): Promise<LivequeryContext> {
  let body: unknown;
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json") && c.req.method !== "GET") {
    body = await c.req.json().catch(() => undefined);
  }
  const lq = getLivequeryRequest(c) as any;
  if (lq && Object.keys(extraKeys).length) {
    lq.keys = { ...(lq.keys ?? {}), ...extraKeys };
  }
  return {
    request: {
      path: c.req.path,
      ref: c.req.path,
      method: c.req.method.toUpperCase(),
      params: c.req.param() as Record<string, string>,
      query: c.req.query(),
      body,
      headers: new Map(Object.entries(c.req.header())),
    },
    livequery: lq ? { ...lq, body } : undefined,
  };
}
