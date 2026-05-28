/**
 * Remote Control WebSocket relay.
 *
 * Flow:
 *  1. ECDSA key-pair generated in software (no hardware required — confirmed working).
 *  2. POST /enroll/start → receive challenge_id.
 *  3. Sign challenge_id with private key → POST /enroll/finish → remote_control_token.
 *  4. Open persistent WSS connection using token.
 *  5. Send ipc-request messages, correlate responses by requestId.
 */

import { buildCodexHttpHeaders, CHATGPT_BASE } from "../libs/chatgpt";
import type { Account } from "../schemas";

const RC_ENROLL_START = `${CHATGPT_BASE}/backend-api/codex/remote/control/client/enroll/start`;
const RC_ENROLL_FINISH = `${CHATGPT_BASE}/backend-api/codex/remote/control/client/enroll/finish`;
const RC_WS_URL = `wss://chatgpt.com/backend-api/codex/remote/control/client`;

// ─── Types ────────────────────────────────────────────────────────────────────

type Enrollment = {
  clientId: string;
  token: string;
  enrolledAt: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type RemoteProject = {
  id: string;
  hostId: string;
  remotePath: string;
  label: string;
};

export type RemoteChat = {
  id: string;
  title: string;
  workspaceRoot?: string;
  updatedAt?: string;
  isPinned?: boolean;
};

// ─── Per-account state ────────────────────────────────────────────────────────

const enrollments = new Map<string, Enrollment>();
const connections = new Map<string, WebSocket>();

// requestId → pending promise callbacks
const pending = new Map<string, PendingRequest>();

// conversationId → set of broadcast handlers (for ipc-broadcast messages)
const broadcastHandlers = new Map<string, Set<(msg: Record<string, unknown>) => void>>();

export function addBroadcastListener(conversationId: string, handler: (msg: Record<string, unknown>) => void) {
  let set = broadcastHandlers.get(conversationId);
  if (!set) { set = new Set(); broadcastHandlers.set(conversationId, set); }
  set.add(handler);
}

export function removeBroadcastListener(conversationId: string, handler: (msg: Record<string, unknown>) => void) {
  const set = broadcastHandlers.get(conversationId);
  if (!set) return;
  set.delete(handler);
  if (set.size === 0) broadcastHandlers.delete(conversationId);
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

async function doEnroll(account: Account): Promise<Enrollment> {
  const headers = buildCodexHttpHeaders(account, "application/json");

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  // Step 1 — start
  const startRes = await fetch(RC_ENROLL_START, {
    method: "POST",
    headers,
    body: JSON.stringify({
      client_type: "CODEX_MOBILE_APP",
      device_name: "codex-proxy",
      public_key: pubJwk,
    }),
  });
  if (!startRes.ok) {
    const body = await startRes.text().catch(() => "");
    throw new Error(`RC enroll/start ${startRes.status}: ${body.slice(0, 300)}`);
  }
  const startData = (await startRes.json()) as {
    client_id: string;
    device_key_challenge: { challenge_id: string };
  };

  const { client_id, device_key_challenge: { challenge_id } } = startData;

  // Step 2 — sign challenge
  const sigBytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    keyPair.privateKey,
    new TextEncoder().encode(challenge_id)
  );
  const signature = Buffer.from(sigBytes).toString("base64url");

  // Step 3 — finish
  const finishRes = await fetch(RC_ENROLL_FINISH, {
    method: "POST",
    headers,
    body: JSON.stringify({ client_id, challenge_id, signature, public_key: pubJwk }),
  });
  if (!finishRes.ok) {
    const body = await finishRes.text().catch(() => "");
    throw new Error(`RC enroll/finish ${finishRes.status}: ${body.slice(0, 300)}`);
  }
  const finishData = (await finishRes.json()) as {
    client_id: string;
    remote_control_token: string;
  };

  return {
    clientId: finishData.client_id,
    token: finishData.remote_control_token,
    enrolledAt: Date.now(),
  };
}

async function getEnrollment(account: Account): Promise<Enrollment> {
  const cached = enrollments.get(account.id);
  if (cached) return cached;
  console.log(`[rc] enrolling account ${account.email}…`);
  const state = await doEnroll(account);
  enrollments.set(account.id, state);
  console.log(`[rc] enrolled ${account.email} → client_id=${state.clientId}`);
  return state;
}

// ─── WebSocket connection ─────────────────────────────────────────────────────

function buildRcWsHeaders(account: Account, token: string): Record<string, string> {
  const hdrs = buildCodexHttpHeaders(account, "application/json");
  const map: Record<string, string> = {};
  for (const [k, v] of hdrs.entries()) map[k] = v;
  map["x-codex-client-session-token"] = `Bearer ${token}`;
  return map;
}

function openConnection(account: Account, enrollment: Enrollment): WebSocket {
  const ws = new WebSocket(RC_WS_URL, {
    // @ts-ignore Bun extension: headers in WebSocket constructor
    headers: buildRcWsHeaders(account, enrollment.token),
  });

  ws.addEventListener("message", (ev) => {
    try {
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      const msg = JSON.parse(raw) as Record<string, unknown>;

      // Dispatch broadcast messages to registered handlers
      if (msg.type === "ipc-broadcast") {
        const params = msg.params as Record<string, unknown> | undefined;
        const cid = params?.conversationId as string | undefined;
        if (cid) {
          const handlers = broadcastHandlers.get(cid);
          if (handlers) { for (const h of handlers) h(msg); }
        }
        return;
      }

      const rid = msg.requestId as string | undefined;
      if (!rid) return;
      const p = pending.get(rid);
      if (!p) return;
      pending.delete(rid);
      clearTimeout(p.timeoutId);
      if (msg.error) {
        p.reject(new Error(JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result ?? msg);
      }
    } catch {}
  });

  ws.addEventListener("close", (ev) => {
    console.log(`[rc] WS closed for ${account.email}: ${ev.code} ${ev.reason ?? ""}`);
    connections.delete(account.id);
    // Reject any requests that were waiting on this connection
    for (const [rid, p] of pending) {
      pending.delete(rid);
      clearTimeout(p.timeoutId);
      p.reject(new Error("Remote control connection closed"));
    }
  });

  ws.addEventListener("error", () => {
    console.error(`[rc] WS error for ${account.email}`);
  });

  connections.set(account.id, ws);
  return ws;
}

export async function getConnection(account: Account): Promise<WebSocket> {
  const existing = connections.get(account.id);

  if (existing?.readyState === WebSocket.OPEN) return existing;

  if (existing?.readyState === WebSocket.CONNECTING) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("open", () => resolve(existing), { once: true });
      existing.addEventListener("close", () => reject(new Error("WS connect failed")), { once: true });
    });
  }

  const enrollment = await getEnrollment(account);
  const ws = openConnection(account, enrollment);

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      console.log(`[rc] WS open for ${account.email}`);
      resolve(ws);
    }, { once: true });
    ws.addEventListener("close", (ev) => reject(new Error(`WS failed to open: ${ev.code}`)), { once: true });
  });
}

// ─── IPC helper ───────────────────────────────────────────────────────────────

export async function ipcRequest(
  account: Account,
  hostId: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000
): Promise<unknown> {
  const ws = await getConnection(account);
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`IPC timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timeoutId });

    ws.send(JSON.stringify({
      type: "ipc-request",
      requestId,
      method,
      params: { hostId, ...params },
    }));
  });
}

// ─── High-level helpers ───────────────────────────────────────────────────────

export async function fetchRemoteProjects(
  account: Account,
  hostId: string
): Promise<RemoteProject[]> {
  const result = await ipcRequest(account, hostId, "workspace-root-options", {});
  // Desktop may return an array directly or { options: [...] }
  const opts = Array.isArray(result) ? result : ((result as any)?.options ?? []);
  return (opts as Record<string, unknown>[]).map((opt) => ({
    id: String(opt.id ?? opt.rootPath ?? opt.path ?? crypto.randomUUID()),
    hostId,
    remotePath: String(opt.rootPath ?? opt.path ?? ""),
    label: String(opt.label ?? opt.name ?? opt.rootPath ?? opt.path ?? ""),
  }));
}

export async function fetchRemoteChats(
  account: Account,
  hostId: string,
  projectPath?: string
): Promise<RemoteChat[]> {
  const params: Record<string, unknown> = {};
  if (projectPath) params.workspaceRoot = projectPath;

  const result = await ipcRequest(account, hostId, "list-pinned-threads", params);
  const threads = Array.isArray(result) ? result : ((result as any)?.threads ?? []);
  return (threads as Record<string, unknown>[]).map((t) => ({
    id: String(t.id ?? t.threadId ?? crypto.randomUUID()),
    title: String(t.title ?? "Untitled"),
    workspaceRoot: t.workspaceRoot as string | undefined,
    updatedAt: t.updatedAt as string | undefined,
    isPinned: t.isPinned as boolean | undefined,
  }));
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function clearRemoteControl(accountId: string) {
  enrollments.delete(accountId);
  const ws = connections.get(accountId);
  if (ws) { try { ws.close(); } catch {} connections.delete(accountId); }
}
