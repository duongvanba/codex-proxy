import { LivequeryClient, LivequeryMemoryStorage } from "@livequery/client";
import { RestTransporter } from "@livequery/rest";

function getLivequeryWebSocketUrl() {
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
