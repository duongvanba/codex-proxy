import { Hono } from "hono";
import { join } from "path";
import { getLivequeryRealtimeUrl, getLivequeryHealth } from "../services/livequery";

const WEB_DIR = join(import.meta.dir, "../../web");
const WEB_BUILD_DIR = join(import.meta.dir, "../../../.livequery-web");
const WEB_BUNDLE = join(WEB_BUILD_DIR, "app.js");

export function createWebController() {
  const app = new Hono();

  app.get("/", async (c) => {
    const realtimeUrl = getLivequeryRealtimeUrl(new URL(c.req.url).origin);
    const html = await Bun.file(join(WEB_DIR, "index.html")).text();
    return c.html(html.replace("__LIVEQUERY_WS_URL_VALUE__", realtimeUrl));
  });

  app.get("/index.html", async (c) => {
    const realtimeUrl = getLivequeryRealtimeUrl(new URL(c.req.url).origin);
    const html = await Bun.file(join(WEB_DIR, "index.html")).text();
    return c.html(html.replace("__LIVEQUERY_WS_URL_VALUE__", realtimeUrl));
  });

  app.get("/app.js", (_c) =>
    new Response(Bun.file(WEB_BUNDLE), { headers: { "Content-Type": "text/javascript; charset=utf-8" } })
  );

  app.get("/app.js.map", (_c) =>
    new Response(Bun.file(`${WEB_BUNDLE}.map`), { headers: { "Content-Type": "application/json; charset=utf-8" } })
  );

  app.get("/app.css", (_c) =>
    new Response(Bun.file(join(WEB_BUILD_DIR, "app.css")), { headers: { "Content-Type": "text/css; charset=utf-8" } })
  );

  app.get("/favicon.ico", (_c) => new Response(null, { status: 204 }));

  app.get("/health", (c) => c.json(getLivequeryHealth(`${new URL(c.req.url).origin}/v1`)));

  app.get("/v1/models", (c) => {
    const models = ["gpt-5.5", "gpt-5.5-turbo", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3", "o4-mini"].map((id) => ({
      id, object: "model", created: 1700000000, owned_by: "openai",
    }));
    return c.json({ object: "list", data: models });
  });

  app.all("/api/*", (c) =>
    c.json(
      { error: { message: `Legacy API route removed after LiveQuery migration: ${c.req.path}`, type: "livequery_migration" } },
      410
    )
  );

  return app;
}
