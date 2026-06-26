import type { LivequeryClient } from "@livequery/client";
import { ServiceLinker, SharedWorkerChannel, type WorkerService } from "@livequery/rpc";
import type { AuthService } from "../services/AuthService";
import { useGlobalValue } from "./useGlobalValue";

export type { AuthAccount, AuthAccountState, AuthApiResponseSession, AuthApiSession, AuthSession } from "../services/AuthService";

export const WORKER_SERVICES = {
  livequery: "livequery",
  auth: "auth",
} as const;

export type WorkerServices = {
  [WORKER_SERVICES.livequery]: LivequeryClient;
  [WORKER_SERVICES.auth]: AuthService;
};

type LinkedWorkerService<T> = {
  [K in keyof WorkerService<T>]: WorkerService<T>[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : WorkerService<T>[K];
};

type WorkerConnection = {
  linker: ServiceLinker;
};

function useWorkerConnection(): WorkerConnection | null {
  if (typeof SharedWorker === "undefined") return null;
  return useGlobalValue("codex-worker-connection", () => {
    const worker = new SharedWorker(new URL("../services/index.ts", import.meta.url), {
      type: "module",
      name: "codex-remix-v2-worker-v7",
    });
    const channel = new SharedWorkerChannel(worker);
    return { linker: new ServiceLinker(channel) };
  });
}

export function linkWorkerService<Name extends keyof WorkerServices>(
  name: Name
): LinkedWorkerService<WorkerServices[Name]> {
  const connection = useWorkerConnection();
  if (!connection) return null as unknown as LinkedWorkerService<WorkerServices[Name]>;
  return useGlobalValue(`codex-worker-service:${String(name)}`, () =>
    connection.linker.linkService<WorkerServices[Name]>(name) as LinkedWorkerService<WorkerServices[Name]>
  );
}

export function useWorkerService<Name extends keyof WorkerServices>(
  name: Name
): LinkedWorkerService<WorkerServices[Name]> {
  return linkWorkerService(name);
}

export const useService = useWorkerService;

export function useLivequeryClient(): LivequeryClient {
  return useWorkerService(WORKER_SERVICES.livequery) as unknown as LivequeryClient;
}

export const livequeryClient: LivequeryClient =
  typeof SharedWorker !== "undefined"
    ? (linkWorkerService(WORKER_SERVICES.livequery) as unknown as LivequeryClient)
    : (null as any);
