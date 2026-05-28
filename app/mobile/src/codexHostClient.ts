export type HostStatus = {
  ok: boolean;
  status: number;
  text: string;
  checkedAt: number;
};

export type CommandRequest = {
  baseUrl: string;
  token?: string;
  workspace: string;
  prompt: string;
  endpoint: string;
};

export type CommandResult = {
  ok: boolean;
  status: number;
  body: string;
};

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, endpoint: string) {
  const base = normalizeBaseUrl(baseUrl);
  const path = endpoint.trim().startsWith("/") ? endpoint.trim() : `/${endpoint.trim()}`;
  return `${base}${path}`;
}

function authHeaders(token?: string) {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

export async function checkHost(baseUrl: string, token?: string): Promise<HostStatus> {
  const startedAt = Date.now();
  try {
    const res = await fetch(joinUrl(baseUrl, "/health"), {
      method: "GET",
      headers: authHeaders(token),
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text: text || `${res.status} ${res.statusText}`,
      checkedAt: startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: error instanceof Error ? error.message : String(error),
      checkedAt: startedAt,
    };
  }
}

export async function sendCommand(request: CommandRequest): Promise<CommandResult> {
  const res = await fetch(joinUrl(request.baseUrl, request.endpoint), {
    method: "POST",
    headers: authHeaders(request.token),
    body: JSON.stringify({
      workspace: request.workspace.trim(),
      prompt: request.prompt.trim(),
      input: request.prompt.trim(),
      source: "codex-mobile-react-native",
    }),
  });
  const body = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    body,
  };
}

export function buildWebSocketUrl(baseUrl: string, endpoint: string) {
  const url = joinUrl(baseUrl, endpoint);
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}
