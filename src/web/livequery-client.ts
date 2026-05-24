import { LivequeryClient, LivequeryMemoryStorage } from "@livequery/client";
import { RestTransporter } from "@livequery/rest";

declare global {
  interface Window {
    __LIVEQUERY_WS_URL__?: string;
  }
}

function getLivequeryWebSocketUrl() {
  const injected = window.__LIVEQUERY_WS_URL__;
  if (injected && !injected.includes("__LIVEQUERY_WS_URL_VALUE__")) return injected;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/livequery/realtime-updates`;
}

export const livequeryClient = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    rest: new RestTransporter({
      api: `${location.origin}/livequery`,
      ws: getLivequeryWebSocketUrl(),
    }),
  },
});
