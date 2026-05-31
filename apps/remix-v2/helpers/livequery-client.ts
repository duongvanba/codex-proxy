import { LivequeryClient, LivequeryMemoryStorage } from "@livequery/client";
import { RestTransporter } from "@livequery/rest";

const HTTP_API =
  typeof window !== "undefined"
    ? (import.meta.env.PUBLIC_HTTP_API ?? "/livequery")
    : "/livequery";

// Realtime gateway chạy trên port riêng (9879). Vite WS-proxy không forward ổn,
// nên browser kết nối THẲNG tới gateway theo đúng hostname trang đang mở —
// chạy cho cả localhost lẫn LAN (gateway bind 0.0.0.0). Prod override bằng PUBLIC_WEBSOCKET_API.
const WS_API =
  typeof window !== "undefined"
    ? (import.meta.env.PUBLIC_WEBSOCKET_API ??
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:9879/livequery/realtime-updates`)
    : "ws://localhost:9879/livequery/realtime-updates";

// Singleton — reuse across HMR reloads
declare global {
  interface Window {
    __CODEX_LIVEQUERY_CLIENT?: LivequeryClient;
  }
}

function createClient(): LivequeryClient {
  if (typeof window !== "undefined" && window.__CODEX_LIVEQUERY_CLIENT) {
    return window.__CODEX_LIVEQUERY_CLIENT;
  }
  const client = new LivequeryClient({
    storage: new LivequeryMemoryStorage(),
    transporters: {
      rest: new RestTransporter({ api: HTTP_API, ws: WS_API }),
    },
  });
  if (typeof window !== "undefined") {
    window.__CODEX_LIVEQUERY_CLIENT = client;
  }
  return client;
}

export const livequeryClient: LivequeryClient =
  typeof window !== "undefined" ? createClient() : (null as any);
