import { LivequeryClient, LivequeryMemoryStorage } from "@livequery/client";
import { RestTransporter } from "@livequery/rest";
import { SharedWorkerChannel, WorkerManager } from "@livequery/rpc";
import { AuthService } from "./AuthService";

const HTTP_API = "/livequery";
const WS_API =
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/livequery/realtime-updates`;
const WORKER_SERVICES = {
  livequery: "livequery",
  auth: "auth",
} as const;

const channel = new SharedWorkerChannel();
const authService = new AuthService();

const livequeryClient = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    rest: new RestTransporter({
      api: HTTP_API,
      ws: WS_API,
      onRequest: async ({ headers }) => {
        const token = await authService.getAccessToken();
        if (!token) return {};
        return {
          headers: {
            ...headers,
            Authorization: `Bearer ${token}`,
          },
        };
      },
    }),
  },
});

const manager = new WorkerManager(channel);
manager.exposeService(WORKER_SERVICES.auth, authService);
manager.exposeService(WORKER_SERVICES.livequery, livequeryClient);
