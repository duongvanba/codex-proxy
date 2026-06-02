import { WebsocketGateway } from "@livequery/core";
import type { AccountsService } from "./accounts";
import type { EnrollmentService } from "../libs/openai";
import type { Account } from "../schemas";
import { serializeAccount, type AccountDocument, type RealtimeChange } from "./livequery/types";

export type EnrollStatus = "none" | "enrolling" | "ready";
export type AccountSyncDocument = AccountDocument & { enrollStatus: EnrollStatus; enrolled: boolean };

/**
 * Service chuyên trách domain ACCOUNT — tầng nghiệp vụ + realtime đứng trên `AccountsService`
 * (tầng persistence: đọc/ghi accounts.json + account-state.json).
 *
 * Nhận `WebsocketGateway` (sync socket của LiveQuery) qua constructor và TỰ publish snapshot
 * vào ref `accounts` mỗi khi state đổi — controller không phải tự gọi publish nữa.
 *
 * 4 chức năng đối ngoại:
 *   - list()        : lấy danh sách tài khoản (đã serialize + kèm enroll status).
 *   - fetchQuota()  : fetch quota tất cả account, lưu state rồi đồng bộ realtime.
 *   - switch(id)    : user chọn tài khoản → gỡ cờ chặn để proxy dùng được ngay + đồng bộ.
 *   - pickForProxy(): chọn tài khoản để phục vụ proxy (account active còn quota).
 */
export class AccountService {
  private knownAccountIds: Set<string>;

  constructor(
    private readonly accounts: AccountsService,
    private readonly enrollment: EnrollmentService,
    private readonly gateway: WebsocketGateway
  ) {
    this.knownAccountIds = new Set(this.accounts.getAccounts().map((a) => a.id));
    // Enroll status đổi (start/complete/delete) → service tự đồng bộ lại snapshot.
    this.enrollment.onChange(() => this.notifyChanged());
  }

  // ─── 1) Lấy danh sách tài khoản ────────────────────────────────────────────────

  /** Danh sách account đã bỏ token nhạy cảm + đính kèm enroll status (cho collection `accounts`). */
  async list(options: { pendingQuotaTimers?: boolean } = {}): Promise<AccountSyncDocument[]> {
    const raw = this.accounts.getAccounts();
    return Promise.all(
      raw.map(async (account) => {
        const enrollStatus = await this.enrollment.getEnrollStatus(account.id);
        return { ...serializeAccount(account, options), enrollStatus, enrolled: enrollStatus === "ready" };
      })
    );
  }

  // ─── 2) Fetch quota ──────────────────────────────────────────────────────────────

  /** Fetch quota (force) cho TẤT CẢ account, `AccountsService` lưu state, xong đồng bộ realtime một lần. */
  async fetchQuota(): Promise<void> {
    await this.accounts.refreshCodexUsageForAccounts(true);
    this.notifyChanged();
  }

  // ─── 3) Switch tài khoản (thủ công) ───────────────────────────────────────────────

  /**
   * User chủ động chọn account. Tin tưởng lựa chọn → gỡ mọi cờ chặn (expired / rate_limit /
   * limitReached) để `pickForProxy()` phục vụ account này NGAY. Upstream vẫn là nơi quyết định
   * 401/429 thực tế (nếu token chết, proxy sẽ tự refresh hoặc đổi account ở vòng request).
   */
  switch(accountId: string): { ok: boolean; error?: string } {
    const result = this.accounts.setSelectedAccount(accountId);
    if (!result.ok) return result;
    this.accounts.clearBlockedState(accountId);
    this.notifyChanged();
    return { ok: true };
  }

  // ─── 4) Chọn tài khoản phục vụ proxy ──────────────────────────────────────────────

  /** Account đang dùng để proxy: ưu tiên account user đã chọn (nếu usable), fallback account usable đầu tiên. */
  pickForProxy(): Account | null {
    return this.accounts.getActiveAccount();
  }

  // ─── 5) Auto refresh token nền ────────────────────────────────────────────────────

  /**
   * Định kỳ tự refresh access token cho account sắp hết hạn (và có refresh token), rồi đẩy
   * realtime nếu có thay đổi. Chạy ngay 1 lần khi start để xử lý token đã sắp hết hạn lúc boot.
   */
  startTokenAutoRefresh(intervalMs: number): { stop: () => void } {
    const tick = async () => {
      try {
        const refreshed = await this.accounts.autoRefreshExpiringTokens();
        if (refreshed > 0) {
          console.log(`[accounts] Auto-refreshed ${refreshed} expiring token(s)`);
          this.notifyChanged();
        }
      } catch (error) {
        console.error("[accounts] Auto refresh failed:", error instanceof Error ? error.message : error);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return { stop: () => clearInterval(timer) };
  }

  // ─── 6) Auto reload quota nền ───────────────────────────────────────────────────

  /**
   * Định kỳ reload quota cho mọi account. Dùng chung `fetchQuota()` để đảm bảo kết quả
   * được lưu qua `AccountsService` rồi mới publish realtime. Có guard để request chậm
   * không tạo nhiều lượt fetch quota chồng nhau.
   */
  startQuotaAutoReload(intervalMs: number): { stop: () => void } {
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        await this.fetchQuota();
      } catch (error) {
        console.error("[accounts] Auto quota reload failed:", error instanceof Error ? error.message : error);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  // ─── Realtime sync (tự publish vào LiveQuery WS) ──────────────────────────────────

  /** Đẩy snapshot toàn bộ account vào ref `accounts` (added cho id mới, modified cho id đã biết). */
  notifyChanged(): void {
    void this.publishSnapshot();
  }

  /** Account bị xoá → publish `removed` + quên id để lần thêm lại tính là `added`. */
  publishRemoved(id: string): void {
    this.knownAccountIds.delete(id);
    this.publish([{ ref: "accounts", type: "removed", data: { id } }]);
  }

  private async publishSnapshot(): Promise<void> {
    const docs = await this.list();
    const changes: RealtimeChange[] = docs.map((doc) => ({
      ref: "accounts",
      type: this.knownAccountIds.has(doc.id) ? "modified" : "added",
      data: doc as unknown as Record<string, unknown>,
    }));
    this.knownAccountIds = new Set(docs.map((d) => d.id));
    this.publish(changes);
  }

  private publish(changes: RealtimeChange[]): void {
    for (const change of changes) {
      this.gateway.next({ ref: change.ref, type: change.type, data: change.data } as Parameters<WebsocketGateway["next"]>[0]);
    }
  }
}
