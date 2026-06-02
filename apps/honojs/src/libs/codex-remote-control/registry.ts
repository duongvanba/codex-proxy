import type { Account } from "../../schemas";
import type { EnrollmentService } from "../openai";
import { WebsocketRelay } from "./WebsocketRelay";
import type { RCEnrollment, RemoteProject, RemoteChat } from "./types";
import { mapThreadStatus } from "./types";

// ─── RemoteControlRegistry ──────────────────────────────────────────────────────

export class RemoteControlRegistry {
  private rcInstances = new Map<string, WebsocketRelay>();

  constructor(private readonly enrollment: EnrollmentService) {}

  private async loadEnrollment(account: Account): Promise<RCEnrollment> {
    const stored = await this.freshEnrollment(account);
    return {
      clientId: stored.clientId,
      token: stored.remoteControlToken,
      keyId: stored.keyId,
      privateKeyPkcs8Base64: stored.privateKeyPkcs8Base64,
    };
  }

  /** Enrollment hiện hành, tự refresh nếu token sắp/đã hết hạn (relay token sống ~10 phút). */
  private async freshEnrollment(account: Account) {
    let stored = await this.enrollment.getEnrollment(account.id);
    if (!stored) throw new Error(`Account ${account.email} not enrolled for remote control`);
    const now = Math.floor(Date.now() / 1000);
    if (!stored.tokenExpiresAt || stored.tokenExpiresAt < now + 120) {
      stored = await this.enrollment.refreshEnrollment(account.id);
    }
    return stored;
  }

  /** Token provider truyền cho WebsocketRelay: mỗi lần (re)connect lấy token TƯƠI (auto-refresh). */
  private async freshToken(account: Account): Promise<string> {
    return (await this.freshEnrollment(account)).remoteControlToken;
  }

  /** 1 connection / ACCOUNT (pool theo account.id). `envId` = host handshake; mọi action sau truyền env per-call. */
  async getRC(account: Account, envId: string): Promise<WebsocketRelay> {
    const key = account.id;
    const existing = this.rcInstances.get(key);
    if (existing) {
      if (existing.isConnected) return existing;
      // Tái dùng instance đang auto-reconnect; chỉ tạo mới nếu connect lỗi (vd token hết hạn).
      try { existing.connect(); await existing.whenReady(); return existing; }
      catch { existing.close(); this.rcInstances.delete(key); }
    }
    const enrollment = await this.loadEnrollment(account);
    const rc = new WebsocketRelay(account, enrollment, envId, () => this.freshToken(account));
    this.rcInstances.set(key, rc);
    rc.connect();
    await rc.whenReady();
    return rc;
  }

  invalidateRC(accountId: string): void {
    const rc = this.rcInstances.get(accountId);
    if (rc) { rc.close(); this.rcInstances.delete(accountId); }
  }

  private remoteStatusText(status: unknown): string | undefined {
    if (typeof status === "string") return status;
    if (!status || typeof status !== "object" || Array.isArray(status)) return undefined;
    const s = status as Record<string, unknown>;
    const type = typeof s.type === "string" ? s.type : undefined;
    const flags = Array.isArray(s.activeFlags) ? s.activeFlags.map(String).filter(Boolean) : [];
    if (!type) return flags.length ? flags.join(",") : undefined;
    return flags.length ? `${type}:${flags.join(",")}` : type;
  }

  async fetchRemoteProjects(account: Account, envId: string): Promise<RemoteProject[]> {
    const rc = await this.getRC(account, envId);
    const threads = await rc.listThreads(envId);
    const seen = new Set<string>();
    const projects: RemoteProject[] = [];
    for (const t of threads) {
      const cwd = t.cwd as string | undefined;
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      projects.push({
        id: cwd,
        hostId: envId,
        remotePath: cwd,
        label: cwd.split("/").filter(Boolean).pop() ?? cwd,
      });
    }
    return projects;
  }

  async fetchRemoteChats(
    account: Account,
    envId: string,
    projectPath?: string
  ): Promise<RemoteChat[]> {
    const rc = await this.getRC(account, envId);
    const threads = await rc.listThreads(envId);
    return threads
      .filter((t) => !projectPath || t.cwd === projectPath)
      .map((t) => {
        const remoteStatusText = this.remoteStatusText(t.status);
        return {
          id: String(t.id ?? crypto.randomUUID()),
          title: String(t.name ?? t.preview ?? "Untitled"),
          workspaceRoot: t.cwd as string | undefined,
          // Ưu tiên thời gian tạo thật; nếu relay không trả thì fallback về updatedAt
          // để sort theo created_at không bao giờ thành no-op.
          createdAt: (() => {
            const v = (t.createdAt ?? t.created_at ?? t.updatedAt) as number | string | undefined;
            return v ? new Date(Number(v) * 1000).toISOString() : undefined;
          })(),
          updatedAt: t.updatedAt ? new Date(Number(t.updatedAt) * 1000).toISOString() : undefined,
          isPinned: false,
          status: mapThreadStatus(t.status),
          remoteStatus: remoteStatusText,
        };
      });
  }
}
