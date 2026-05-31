// ─── Enrollment ───────────────────────────────────────────────────────────────

export type RCEnrollment = {
  clientId: string;
  token: string;
  keyId: string;
  privateKeyPkcs8Base64: string;
};

// ─── Protocol ─────────────────────────────────────────────────────────────────

export type DeviceKeyChallenge = {
  type: "device_key_challenge";
  nonce: string;
  sessionId: string;
  targetOrigin: string;
  targetPath: string;
  accountUserId: string;
  clientId: string;
  tokenSha256Base64url: string;
  tokenExpiresAt: number;
  scopes: string[];
  audience: string;
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

// ─── Events / status ───────────────────────────────────────────────────────────

/** Một event notification từ relay — đẩy qua Subject để lắng nghe (per-chat / per-turn / host-wide).
 *  `envId` = host phát ra event (1 connection/account phục vụ nhiều host → cần để demux theo host). */
export type RelayEvent = { method: string; params: Record<string, unknown>; envId: string };

/** Trạng thái kết nối relay — action chờ "ready" trước khi gửi. */
export type RelayStatus = "idle" | "connecting" | "ready" | "closed";

// ─── Remote data ──────────────────────────────────────────────────────────────

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
  createdAt?: string;
  updatedAt?: string;
  isPinned?: boolean;
  /** Trạng thái remote map về "in_progress" (agent đang chạy) | "idle" (xong). */
  status?: string;
};

/** Map status.type của thread (remote) → trạng thái chat đơn giản. */
export function mapThreadStatus(statusType: unknown): string {
  const t = typeof statusType === "string" ? statusType : "";
  // active / working / thinking / running / streaming → agent đang xử lý
  return /^(active|working|thinking|running|streaming|inprogress|in_progress)$/i.test(t) ? "in_progress" : "idle";
}
