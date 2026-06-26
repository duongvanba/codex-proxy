import type { Account } from "../../schemas";
import type { HostItem, ProjectItem, ChatItem, TurnItem } from "../../libs/chatgpt";

// ─── Constants ───────────────────────────────────────────────────────────────

export const REPORT_LIMIT = 250;
export const LIVEQUERY_PATH_PREFIX = "/livequery";
export const LIVEQUERY_SOCKET_PATH = "/livequery/realtime-updates";

export const HOSTS_TTL_MS = 30_000;
export const PROJECTS_TTL_MS = 60_000;
export const CHATS_TTL_MS = 60_000;

// ─── Document / response types ───────────────────────────────────────────────

export type ReportDocument = {
  id: string;
  timestamp: number;
  type: string;
  [key: string]: unknown;
};

export type AccountDocument = Omit<Account, "accessToken" | "refreshToken" | "idToken">;

export type HostDocument = HostItem & { account_id: string };
export type ProjectDocument = ProjectItem & { account_id: string };
export type ChatDocument = ChatItem & { account_id: string };
export type TurnDocument = TurnItem & { account_id: string; chat_id: string };

export type LivequeryResult<T> =
  | { data: T }
  | { error: { code: string; message: string } };

export type LivequeryCollectionResponse<T extends { id: string }> = {
  items: T[];
  summary?: Record<string, unknown>;
  count: { prev: number; next: number; total: number; current: number };
  has: { prev: boolean; next: boolean };
  cursor: { first: string; last: string };
};

export type RealtimeChange = {
  ref: string;
  type: "added" | "modified" | "removed";
  data: Record<string, unknown>;
};

/** Local Desktop App chats (selfhost: prefix) */
export type LocalChatEntry = {
  accountId: string;
  hostId: string;
  conversationId: string;
  cwd?: string;
  title?: string;
  rcThreadId?: string;
  isNew?: boolean;
};

export type ActionPathParams = { accountId: string; chatId: string; hostId: string };

/** Bối cảnh truyền cho mỗi action method (đã trích sẵn payload/path/url). */
export type ActionEnv = {
  payload: Record<string, unknown>;
  path: ActionPathParams;
  origin: string;
  /** openaiBaseUrl đã resolve theo payload.publicBaseUrl. */
  openaiBaseUrl: string;
  restartCodex: () => Promise<void>;
};

// ─── Free helpers ────────────────────────────────────────────────────────────

/** Tính lại resetAfterSeconds từ resetAt (absolute Unix seconds) tại thời điểm gọi. */
function recalcWindow(win: NonNullable<Account["codexUsage"]>["primaryWindow"], pending: boolean) {
  if (!win) return undefined;
  if (pending) return { ...win, resetAfterSeconds: -1 };
  const nowSec = Math.floor(Date.now() / 1000);
  return { ...win, resetAfterSeconds: Math.max(0, win.resetAt - nowSec) };
}

export function serializeAccount(account: Account, options: { pendingQuotaTimers?: boolean } = {}): AccountDocument {
  const { accessToken: _accessToken, refreshToken: _refreshToken, idToken: _idToken, ...safeAccount } = account;
  if (safeAccount.codexUsage) {
    const pending = options.pendingQuotaTimers ?? false;
    safeAccount.codexUsage = {
      ...safeAccount.codexUsage,
      primaryWindow: recalcWindow(safeAccount.codexUsage.primaryWindow, pending),
      secondaryWindow: recalcWindow(safeAccount.codexUsage.secondaryWindow, pending),
    };
  }
  return safeAccount;
}

/** Đọc ảnh đính kèm (base64) từ payload action. */
export function parseImages(payload: Record<string, unknown>): { data: string; mimeType: string }[] | undefined {
  const arr = payload.images;
  if (!Array.isArray(arr)) return undefined;
  const imgs = arr
    .filter((x) => x && typeof (x as Record<string, unknown>).data === "string")
    .map((x) => ({ data: String((x as Record<string, unknown>).data), mimeType: String((x as Record<string, unknown>).mimeType ?? "image/png") }));
  return imgs.length ? imgs : undefined;
}

/** JSON response chuẩn LiveQuery. */
export function json<T>(payload: LivequeryResult<T>, init?: ResponseInit): Response {
  return Response.json(payload, init);
}

/** Error response chuẩn LiveQuery. */
export function error(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, { status });
}

/** Parse environment_id: `selfhost:` / `cloud:` / raw (mặc định cloud). */
export function parseEnvId(raw?: string): { kind: "selfhost" | "cloud" | "none"; envId: string } {
  if (!raw) return { kind: "none", envId: "" };
  if (raw.startsWith("selfhost:")) return { kind: "selfhost", envId: raw.slice(9) };
  if (raw.startsWith("cloud:")) return { kind: "cloud", envId: raw.slice(6) };
  return { kind: "cloud", envId: raw };
}

/** Resolve openaiBaseUrl theo payload.publicBaseUrl (fallback nếu không hợp lệ). */
export function resolveOpenaiBaseUrl(publicBaseUrl: unknown, fallbackOpenaiBaseUrl: string): string {
  if (typeof publicBaseUrl !== "string") return fallbackOpenaiBaseUrl;
  try {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallbackOpenaiBaseUrl;
    return `${url.origin}/v1`;
  } catch {
    return fallbackOpenaiBaseUrl;
  }
}

export function collectionResponse<T extends { id: string }>(
  items: T[],
  summary: Record<string, unknown> = {}
): LivequeryCollectionResponse<T> {
  return {
    items,
    summary,
    count: { prev: 0, next: 0, total: items.length, current: items.length },
    has: { prev: false, next: false },
    cursor: { first: items[0]?.id ?? "", last: items[items.length - 1]?.id ?? "" },
  };
}
