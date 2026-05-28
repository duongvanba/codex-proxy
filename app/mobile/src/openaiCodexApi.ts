import type { ApprovalRequest, ChatMessage, ChatSummary, FolderNode, Host, Project, Session } from "./types";

const defaultApiBase = "https://chatgpt.com";
const devAuthUrls = ["http://127.0.0.1:8787/auth", "http://localhost:8787/auth"];

function headers(session?: Session) {
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    Originator: "codex_cli_rs",
    Version: "0.133.0",
  };
  if (session?.accessToken) h.Authorization = `Bearer ${session.accessToken}`;
  if (session?.accountId) h["ChatGPT-Account-Id"] = session.accountId;
  return h;
}

function getApiBase(session?: Session) {
  return (session?.apiBase || defaultApiBase).replace(/\/+$/, "");
}

async function getJson<T>(url: string, session?: Session): Promise<T> {
  const res = await fetch(url, { headers: headers(session) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown, session?: Session): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: headers(session),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export type CodexApi = {
  signInWithGoogle(input?: { accessToken?: string; accountId?: string; apiBase?: string }): Promise<Session>;
  authorizeRemoteControl(session: Session): Promise<Session>;
  listHosts(session: Session): Promise<Host[]>;
  listProjects(session: Session, hostId: string): Promise<Project[]>;
  listFolders(session: Session, hostId: string): Promise<FolderNode[]>;
  createProject(session: Session, hostId: string, folderPath: string): Promise<Project>;
  createChat(session: Session, hostId: string, projectId: string): Promise<ChatSummary>;
  readChat(session: Session, hostId: string, projectId: string, chatId: string): Promise<{
    messages: ChatMessage[];
    approvals: ApprovalRequest[];
  }>;
  sendMessage(session: Session, hostId: string, projectId: string, chatId: string, text: string): Promise<ChatMessage>;
  approveRequest(session: Session, hostId: string, chatId: string, approvalId: string): Promise<void>;
};

export function createCodexApi(apiBase = defaultApiBase): CodexApi {
  const fallbackBase = apiBase.replace(/\/+$/, "");

  return {
    async signInWithGoogle(input) {
      const devAuth = input?.accessToken?.trim() ? null : await loadDevAuth();
      const session: Session = {
        accessToken: input?.accessToken?.trim() || devAuth?.accessToken || "development-token",
        accountId: input?.accountId?.trim() || devAuth?.accountId || "",
        apiBase: input?.apiBase?.trim() || devAuth?.apiBase || fallbackBase,
        email: devAuth?.email || "you@example.com",
        remoteControlAuthorized: false,
      };

      if (session.accessToken !== "development-token") {
        try {
          const me = await getJson<{ email?: string; user?: { email?: string } }>(
            `${getApiBase(session)}/backend-api/me`,
            session
          );
          return {
            ...session,
            email: me.email ?? me.user?.email ?? session.email,
          };
        } catch {
          return session;
        }
      }

      return {
        ...session,
        remoteControlAuthorized: false,
      };
    },

    async authorizeRemoteControl(session) {
      try {
        await postJson(`${getApiBase(session)}/backend-api/codex/remote-control/authorize`, {}, session);
      } catch {
        // Keep the preview usable while the exact desktop endpoint is being mapped.
      }
      return { ...session, remoteControlAuthorized: true };
    },

    async listHosts(session) {
      try {
        const environments = await listRemoteControlEnvironments(session);
        if (environments.length > 0) {
          return environments.map(remoteControlEnvironmentToHost);
        }
      } catch {
        // Fall through to the older clients endpoint for accounts/builds that do not expose environments yet.
      }

      try {
        const data = await getJson<{ items?: RemoteControlClient[]; cursor?: string | null }>(
          `${getApiBase(session)}/backend-api/wham/remote/control/clients`,
          session
        );
        const clients = data.items ?? [];
        const computers = clients.filter((client) => client.device_type === "computer");
        return (computers.length > 0 ? computers : clients).map(remoteControlClientToHost);
      } catch {
        return mockHosts;
      }
    },

    async listProjects(session, hostId) {
      // Codex Desktop builds the remote project list from its local global state
      // (`remote-projects`) and app-server inbox data. The ChatGPT backend does not
      // expose `/codex/hosts/{hostId}/projects`; keep preview data until a desktop
      // bridge/app-server transport is wired in.
      return mockProjects(hostId);
    },

    async listFolders(session, hostId) {
      try {
        const data = await getJson<{ folders?: FolderNode[] }>(
          `${getApiBase(session)}/backend-api/codex/hosts/${encodeURIComponent(hostId)}/folders`,
          session
        );
        return data.folders ?? mockFolders;
      } catch {
        return mockFolders;
      }
    },

    async createProject(session, hostId, folderPath) {
      try {
        return await postJson<Project>(
          `${getApiBase(session)}/backend-api/codex/hosts/${encodeURIComponent(hostId)}/projects`,
          { path: folderPath },
          session
        );
      } catch {
        const name = folderPath.split("/").filter(Boolean).at(-1) ?? "New project";
        return {
          id: `project-${Date.now()}`,
          hostId,
          name,
          path: folderPath,
          chats: [],
        };
      }
    },

    async createChat(session, hostId, projectId) {
      try {
        return await postJson<ChatSummary>(
          `${getApiBase(session)}/backend-api/codex/hosts/${encodeURIComponent(hostId)}/projects/${encodeURIComponent(projectId)}/chats`,
          {},
          session
        );
      } catch {
        return {
          id: `chat-${Date.now()}`,
          title: "New chat",
          updatedAt: "now",
          status: "idle",
        };
      }
    },

    async readChat(session, hostId, projectId, chatId) {
      try {
        return await getJson<{ messages: ChatMessage[]; approvals: ApprovalRequest[] }>(
          `${getApiBase(session)}/backend-api/codex/hosts/${encodeURIComponent(hostId)}/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`,
          session
        );
      } catch {
        return mockChat(chatId);
      }
    },

    async sendMessage(session, hostId, projectId, chatId, text) {
      try {
        return await postJson<ChatMessage>(
          `${getApiBase(session)}/backend-api/codex/hosts/${encodeURIComponent(hostId)}/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}/messages`,
          { text },
          session
        );
      } catch {
        return {
          id: `local-${Date.now()}`,
          role: "user",
          text,
          createdAt: new Date().toISOString(),
        };
      }
    },

    async approveRequest(session, hostId, chatId, approvalId) {
      try {
        await postJson(
          `${getApiBase(session)}/backend-api/codex/hosts/${encodeURIComponent(hostId)}/chats/${encodeURIComponent(chatId)}/approvals/${encodeURIComponent(approvalId)}/approve`,
          {},
          session
        );
      } catch {
        return;
      }
    },
  };
}

type DevAuthResponse = {
  accessToken?: string;
  accountId?: string;
  apiBase?: string;
  email?: string;
};

async function loadDevAuth(): Promise<DevAuthResponse | null> {
  for (const url of devAuthUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      return (await res.json()) as DevAuthResponse;
    } catch {
      // Try the next localhost alias.
    }
  }
  return null;
}

type RemoteControlClient = {
  client_id: string;
  display_name?: string | null;
  device_type?: string | null;
  platform?: string | null;
  os_version?: string | null;
  device_model?: string | null;
  enrollment_status?: string | null;
  app_version?: string | null;
  last_seen_at?: string | null;
};

type RemoteControlEnvironment = {
  env_id: string;
  display_name?: string | null;
  host_name?: string | null;
  name?: string | null;
  online?: boolean | null;
  busy?: boolean | null;
  os?: string | null;
  os_version?: string | null;
  arch?: string | null;
  app_server_version?: string | null;
  client_type?: string | null;
  client_name?: string | null;
  client_version?: string | null;
  last_seen_at?: string | null;
};

async function listRemoteControlEnvironments(session: Session, cursor?: string | null): Promise<RemoteControlEnvironment[]> {
  const query = new URLSearchParams({ limit: "100" });
  if (cursor) query.set("cursor", cursor);
  const data = await getJson<{ items?: RemoteControlEnvironment[]; cursor?: string | null }>(
    `${getApiBase(session)}/backend-api/codex/remote/control/environments?${query.toString()}`,
    session
  );
  const items = data.items ?? [];
  if (!data.cursor) return items;
  return items.concat(await listRemoteControlEnvironments(session, data.cursor));
}

function remoteControlEnvironmentToHost(environment: RemoteControlEnvironment): Host {
  return {
    id: `remote-control:${environment.env_id}`,
    name: environment.display_name || environment.name || environment.host_name || "Unknown host",
    platform:
      [environment.os, environment.os_version, environment.arch, environment.app_server_version]
        .filter(Boolean)
        .join(" ") || environment.client_name || "Unknown",
    status: environment.online ? "online" : "offline",
    lastSeen: formatLastSeen(environment.last_seen_at),
  };
}

function remoteControlClientToHost(client: RemoteControlClient): Host {
  return {
    id: client.client_id,
    name: client.display_name || client.device_model || "Unknown host",
    platform: [client.platform, client.os_version].filter(Boolean).join(" ") || client.device_model || "Unknown",
    status: client.enrollment_status === "enrolled_device_key" ? "online" : "needs_auth",
    lastSeen: formatLastSeen(client.last_seen_at),
  };
}

function formatLastSeen(value?: string | null) {
  if (!value) return "unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return "now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const mockFolders: FolderNode[] = [
  {
    id: "home",
    name: "baduongvan",
    path: "/Users/baduongvan",
    children: [
      {
        id: "dev",
        name: "dev",
        path: "/Users/baduongvan/dev",
        children: [
          {
            id: "trick",
            name: "trick",
            path: "/Users/baduongvan/dev/trick",
            children: [
              { id: "codex", name: "codex", path: "/Users/baduongvan/dev/trick/codex" },
              { id: "mobile", name: "mobile-client", path: "/Users/baduongvan/dev/trick/mobile-client" },
            ],
          },
        ],
      },
      {
        id: "documents",
        name: "Documents",
        path: "/Users/baduongvan/Documents",
        children: [
          { id: "codex-docs", name: "Codex", path: "/Users/baduongvan/Documents/Codex" },
        ],
      },
    ],
  },
];

const mockHosts: Host[] = [
  {
    id: "local-mac",
    name: "Baduongvan MacBook",
    platform: "macOS",
    status: "online",
    lastSeen: "now",
  },
  {
    id: "studio-host",
    name: "Studio Host",
    platform: "macOS",
    status: "offline",
    lastSeen: "2h ago",
  },
];

function mockProjects(hostId: string): Project[] {
  return [
    {
      id: "codex-proxy",
      hostId,
      name: "codex-proxy",
      path: "/Users/baduongvan/dev/trick/codex",
      chats: [
        {
          id: "chat-1",
          title: "Patch remote connection gate",
          updatedAt: "10m ago",
          status: "waiting_approval",
        },
        {
          id: "chat-2",
          title: "Review proxy auth flow",
          updatedAt: "1h ago",
          status: "idle",
        },
      ],
    },
    {
      id: "mobile-client",
      hostId,
      name: "mobile-client",
      path: "/Users/baduongvan/dev/trick/codex/app/mobile",
      chats: [
        {
          id: "chat-3",
          title: "Build Codex Remote app",
          updatedAt: "now",
          status: "running",
        },
      ],
    },
  ];
}

function mockChat(chatId: string) {
  const approvals: ApprovalRequest[] =
    chatId === "chat-1"
      ? [
          {
            id: "approval-1",
            title: "Run patch script",
            command: "python3 patch_remote_connections.py",
            risk: "medium",
          },
        ]
      : [];

  return {
    approvals,
    messages: [
      {
        id: "m1",
        role: "user" as const,
        text: "Hãy kiểm tra host và chuẩn bị patch.",
        createdAt: new Date(Date.now() - 300000).toISOString(),
      },
      {
        id: "m2",
        role: "assistant" as const,
        text: approvals.length
          ? "Tôi cần quyền chạy script patch trước khi tiếp tục."
          : "Đã sẵn sàng. Bạn có thể nhắn tiếp từ mobile.",
        createdAt: new Date(Date.now() - 240000).toISOString(),
      },
    ],
  };
}
