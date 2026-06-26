import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Account, CodexUsage, UsageWindow } from "../schemas";
import { ChatGPTClient } from "../libs/chatgpt";
import type { AuthService } from "../libs/openai";

// ─── Module-level constants ───────────────────────────────────────────────────

const ACCOUNTS_FILE = join(process.env.DATA_DIR ?? process.cwd(), "accounts.json");
const ACCOUNT_STATE_FILE = join(process.env.DATA_DIR ?? process.cwd(), "account-state.json");
const DEFAULT_DAILY_LIMIT = readLimit("CODEX_DAILY_LIMIT", 100);
const DEFAULT_WEEKLY_LIMIT = readLimit("CODEX_WEEKLY_LIMIT", 500);
const CODEX_USAGE_TTL_MS = readLimit("CODEX_USAGE_TTL_SECONDS", 60) * 1000;
const CODEX_USAGE_CONCURRENCY = readLimit("CODEX_USAGE_CONCURRENCY", 3);
const CODEX_USAGE_TIMEOUT_MS = readLimit("CODEX_USAGE_TIMEOUT_MS", 3000);
const TOKEN_REFRESH_MIN_TTL_MS = readLimit("TOKEN_REFRESH_MIN_TTL_SECONDS", 300) * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

type PersistedAccount = Pick<
  Account,
  "id" | "email" | "accessToken" | "refreshToken" | "idToken" | "accountId" | "addedAt"
> & Partial<Account>;

type AccountRuntimeState = {
  status?: Account["status"];
  rateLimitUntil?: number;
  requestCount?: number;
  lastUsed?: number;
  dailyUsage?: UsageWindow;
  weeklyUsage?: UsageWindow;
  codexUsage?: CodexUsage;
  chatgptPlanType?: string;
  selected?: boolean;
};

type AccountStateFile = Record<string, AccountRuntimeState>;
type RefreshResult =
  | { ok: true; account: Account; refreshed: boolean }
  | { ok: false; error: string; status?: number };

// ─── Module-level helper (used before class is defined) ───────────────────────

function readLimit(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// ─── AccountsService ──────────────────────────────────────────────────────────

export class AccountsService {
  private refreshInFlight = new Map<string, Promise<RefreshResult>>();
  private readonly onNewAccountHandlers: Array<(account: Account) => void> = [];

  constructor(private readonly auth: AuthService) {}

  onNewAccount(handler: (account: Account) => void): void {
    this.onNewAccountHandlers.push(handler);
  }

  // ─── Date helpers ───────────────────────────────────────────────────────────

  private localDateKey(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private localWeekKey(date = new Date()): string {
    const monday = new Date(date);
    const day = monday.getDay() || 7;
    monday.setDate(monday.getDate() - day + 1);
    return this.localDateKey(monday);
  }

  // ─── Usage window helpers ───────────────────────────────────────────────────

  private ensureUsageWindows(account: Account): boolean {
    let changed = false;
    const dayKey = this.localDateKey();
    const weekKey = this.localWeekKey();

    if (
      !account.dailyUsage ||
      account.dailyUsage.key !== dayKey ||
      account.dailyUsage.limit !== DEFAULT_DAILY_LIMIT
    ) {
      account.dailyUsage = {
        key: dayKey,
        count: account.dailyUsage?.key === dayKey ? account.dailyUsage.count : 0,
        limit: DEFAULT_DAILY_LIMIT,
      };
      changed = true;
    }

    if (
      !account.weeklyUsage ||
      account.weeklyUsage.key !== weekKey ||
      account.weeklyUsage.limit !== DEFAULT_WEEKLY_LIMIT
    ) {
      account.weeklyUsage = {
        key: weekKey,
        count: account.weeklyUsage?.key === weekKey ? account.weeklyUsage.count : 0,
        limit: DEFAULT_WEEKLY_LIMIT,
      };
      changed = true;
    }

    return changed;
  }

  // ─── Persistence helpers ────────────────────────────────────────────────────

  private loadAccountState(): AccountStateFile {
    if (!existsSync(ACCOUNT_STATE_FILE)) return {};
    try {
      return JSON.parse(readFileSync(ACCOUNT_STATE_FILE, "utf8"));
    } catch {
      return {};
    }
  }

  private saveAccountState(state: AccountStateFile) {
    writeFileSync(ACCOUNT_STATE_FILE, JSON.stringify(state, null, 2));
  }

  private stripAccountState(account: Account): PersistedAccount {
    return {
      id: account.id,
      email: account.email,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
      accountId: account.accountId,
      addedAt: account.addedAt,
    };
  }

  private extractAccountState(account: Partial<Account>): AccountRuntimeState {
    const state: AccountRuntimeState = {};
    if (account.status) state.status = account.status;
    if (account.rateLimitUntil !== undefined) state.rateLimitUntil = account.rateLimitUntil;
    if (account.requestCount !== undefined) state.requestCount = account.requestCount;
    if (account.lastUsed !== undefined) state.lastUsed = account.lastUsed;
    if (account.dailyUsage) state.dailyUsage = account.dailyUsage;
    if (account.weeklyUsage) state.weeklyUsage = account.weeklyUsage;
    if (account.codexUsage) state.codexUsage = account.codexUsage;
    if (account.chatgptPlanType) state.chatgptPlanType = account.chatgptPlanType;
    if (account.selected !== undefined) state.selected = account.selected;
    return state;
  }

  private loadAccounts(): Account[] {
    if (!existsSync(ACCOUNTS_FILE)) return [];
    try {
      const accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as PersistedAccount[];
      const state = this.loadAccountState();
      let migrated = false;
      const merged = accounts.map((account) => {
        const embeddedState = this.extractAccountState(account);
        if (Object.keys(embeddedState).length > 0) migrated = true;
        return {
          status: "active",
          requestCount: 0,
          ...account,
          ...embeddedState,
          ...state[account.id],
        } as Account;
      });
      if (migrated) this.saveAccounts(merged);
      return merged;
    } catch {
      return [];
    }
  }

  private saveAccounts(accounts: Account[]) {
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts.map(this.stripAccountState.bind(this)), null, 2));
    this.saveAccountState(
      Object.fromEntries(accounts.map((account) => [account.id, this.extractAccountState(account)]))
    );
  }

  // ─── JWT helpers ────────────────────────────────────────────────────────────

  private decodeJwtPayload(token: string): Record<string, any> {
    try {
      const [, payload] = token.split(".");
      if (!payload) return {};
      const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      return {};
    }
  }

  private tokenExpiresWithin(token: string, minTtlMs: number): boolean {
    const payload = this.decodeJwtPayload(token);
    if (!payload.exp) return false;
    return Number(payload.exp) * 1000 - Date.now() <= minTtlMs;
  }

  private copyAccountTokens(target: Account, source: Account) {
    target.accessToken = source.accessToken;
    target.refreshToken = source.refreshToken;
    target.idToken = source.idToken;
    target.accountId = source.accountId;
    target.status = source.status;
    target.rateLimitUntil = source.rateLimitUntil;
  }

  // ─── Usage helpers ──────────────────────────────────────────────────────────

  private resolveSubscriptionExpiry(fresh: number | undefined, cached: number | undefined): number | undefined {
    if (fresh !== undefined) return fresh;
    // Không giữ giá trị cũ nếu đã hết hạn — tránh hiện "EXPIRED" cho account vẫn active.
    return cached && cached > Date.now() ? cached : undefined;
  }

  private normalizeUsageWindow(value: any) {
    if (!value) return undefined;
    return {
      usedPercent: Number(value.used_percent ?? 0),
      limitWindowSeconds: Number(value.limit_window_seconds ?? 0),
      resetAfterSeconds: Number(value.reset_after_seconds ?? 0),
      resetAt: Number(value.reset_at ?? 0),
    };
  }

  private async fetchSubscriptionExpiresAt(account: Account): Promise<number | undefined> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
      const res = await ChatGPTClient.fetchInvoices(account.accessToken, account.accountId, controller.signal)
        .finally(() => clearTimeout(timeout));
      if (!res.ok) return undefined;
      const body = await res.json();
      return this.parseSubscriptionExpiresAt(body);
    } catch {
      return undefined;
    }
  }

  private parseSubscriptionExpiresAt(body: any): number | undefined {
    try {
      const items: any[] = body?.data ?? body?.invoices ?? [];
      // amount_paid=0 vẫn là "paid" khi dùng Apple IAP / credits — chỉ filter theo status
      const paid = items.filter((inv: any) => inv?.status === "paid");
      if (!paid.length) return undefined;

      const toMs = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? (n < 4_000_000_000 ? n * 1000 : n) : 0;
      };

      // invoice.period_end === invoice.period_start (billing date, vô dụng).
      // Ngày thực tế nằm trong lines.data[].period.end
      let bestExpiresMs = 0;
      let bestIntervalMs = 0;
      for (const inv of paid) {
        const lines: any[] = inv?.lines?.data ?? [];
        for (const line of lines) {
          const end = toMs(line?.period?.end);
          const start = toMs(line?.period?.start);
          if (end > bestExpiresMs) {
            bestExpiresMs = end;
            if (start > 0 && end > start) bestIntervalMs = end - start;
          }
        }
      }

      if (!bestExpiresMs) return undefined;

      // Nếu đã qua (renew hôm nay chưa có invoice mới), project forward theo billing interval
      if (bestExpiresMs <= Date.now()) {
        if (bestIntervalMs > 0) {
          while (bestExpiresMs <= Date.now()) bestExpiresMs += bestIntervalMs;
          return bestExpiresMs;
        }
        return undefined;
      }

      return bestExpiresMs;
    } catch {
      return undefined;
    }
  }

  private async fetchRateLimitResetCount(account: Account): Promise<number | undefined> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
      const res = await ChatGPTClient.fetchRateLimitResetCredits(account, controller.signal)
        .finally(() => clearTimeout(timeout));
      if (!res.ok) return undefined;
      const body = await res.json() as { available_count?: number };
      const count = body?.available_count;
      return typeof count === "number" ? count : undefined;
    } catch {
      return undefined;
    }
  }

  async resetRateLimit(accountId: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
    const account = this.loadAccounts().find((a) => a.id === accountId);
    if (!account) return { ok: false, error: "Account not found" };

    try {
      const creditsRes = await ChatGPTClient.fetchRateLimitResetCredits(account);
      if (!creditsRes.ok) return { ok: false, error: `Failed to fetch credits: HTTP ${creditsRes.status}` };
      const creditsBody = await creditsRes.json() as { available_count?: number; credits?: Array<{ id: string; status: string }> };
      const credit = creditsBody.credits?.find((c) => c.status === "available");
      if (!credit) return { ok: false, error: "No available reset credits" };

      const redeemRequestId = crypto.randomUUID();
      const consumeRes = await ChatGPTClient.consumeRateLimitResetCredit(account, credit.id, redeemRequestId);
      const consumeBody = await consumeRes.json() as { code?: string };
      const code = consumeBody?.code ?? (consumeRes.ok ? "reset" : "error");
      if (code !== "reset") return { ok: false, error: code };
      return { ok: true, code };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private usageErrorMessage(status: number, text: string): string {
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.code || parsed?.error?.message || `HTTP ${status}`;
    } catch {
      return text.slice(0, 120) || `HTTP ${status}`;
    }
  }

  // ─── Token refresh ──────────────────────────────────────────────────────────

  private async refreshAccountAccessTokenInner(account: Account): Promise<RefreshResult> {
    const accounts = this.loadAccounts();
    const persisted = accounts.find((a) => a.id === account.id || a.accountId === account.accountId || a.email === account.email);
    const refreshToken = persisted?.refreshToken || account.refreshToken;
    if (!refreshToken) return { ok: true, account: persisted ?? account, refreshed: false };

    const result = await this.auth.exchangeRefreshToken(refreshToken);
    if (!result.ok) return { ok: false, error: result.error };
    const { status, text } = result;
    if (status < 200 || status >= 300) return { ok: false, status, error: this.usageErrorMessage(status, text) };

    let tokens: Record<string, any>;
    try {
      tokens = JSON.parse(text);
    } catch {
      return { ok: false, error: "Refresh token response was not valid JSON" };
    }

    if (!tokens.access_token) return { ok: false, error: "Refresh token response did not include access_token" };

    tokens.refresh_token = tokens.refresh_token ?? refreshToken;
    tokens.account_id = tokens.account_id ?? persisted?.accountId ?? account.accountId;

    const updated = this.importFromTokens(tokens);
    if (!updated) return { ok: false, error: "Could not import refreshed access token" };
    return { ok: true, account: updated, refreshed: true };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  getAccounts(): Account[] {
    const accounts = this.loadAccounts();
    let changed = false;
    for (const account of accounts) {
      if (this.ensureUsageWindows(account)) changed = true;
    }
    if (changed) this.saveAccounts(accounts);
    return accounts;
  }

  async refreshAccountAccessToken(
    account: Account,
    options: { force?: boolean; minTtlMs?: number } = {}
  ): Promise<RefreshResult> {
    const minTtlMs = options.minTtlMs ?? TOKEN_REFRESH_MIN_TTL_MS;
    if (!options.force && !this.tokenExpiresWithin(account.accessToken, minTtlMs)) {
      return { ok: true, account, refreshed: false };
    }

    const key = account.id || account.accountId || account.email;
    let pending = this.refreshInFlight.get(key);
    if (!pending) {
      pending = this.refreshAccountAccessTokenInner(account).finally(() => this.refreshInFlight.delete(key));
      this.refreshInFlight.set(key, pending);
    }

    const result = await pending;
    if (result.ok) this.copyAccountTokens(account, result.account);
    return result;
  }

  /**
   * Tự refresh access token cho MỌI account sắp hết hạn & có refresh token.
   * `refreshAccountAccessToken` đã tự bỏ qua account chưa sắp hết hạn (trả refreshed:false)
   * và dedup request đang bay, nên gọi lặp lại an toàn. Trả về số account thực sự refresh được
   * để caller quyết định có cần đẩy realtime hay không.
   */
  async autoRefreshExpiringTokens(minTtlMs = TOKEN_REFRESH_MIN_TTL_MS): Promise<number> {
    const accounts = this.loadAccounts();
    let refreshed = 0;
    for (const account of accounts) {
      if (!account.refreshToken) continue;
      if (!this.tokenExpiresWithin(account.accessToken, minTtlMs)) continue;
      try {
        const result = await this.refreshAccountAccessToken(account, { minTtlMs });
        if (result.ok && result.refreshed) refreshed++;
      } catch {
        // Lỗi 1 account không được chặn các account còn lại.
      }
    }
    return refreshed;
  }

  async refreshCodexUsageForAccounts(force = false): Promise<void> {
    const accounts = this.loadAccounts();
    const now = Date.now();
    let changed = false;

    const pending = accounts.filter((account) => {
      if (!force && account.codexUsage?.fetchedAt && now - account.codexUsage.fetchedAt < CODEX_USAGE_TTL_MS) {
        return false;
      }
      return true;
    });

    const refreshOne = async (account: Account) => {
      try {
        let refreshedBeforeQuota = false;
        const refresh = await this.refreshAccountAccessToken(account, { minTtlMs: TOKEN_REFRESH_MIN_TTL_MS });
        if (!refresh.ok) {
          const info = ChatGPTClient.decodeToken(account.accessToken);
          if (info.isExpired) {
            account.status = "expired";
            account.codexUsage = {
              fetchedAt: now,
              allowed: false,
              limitReached: false,
              error: `Token refresh failed before quota fetch: ${refresh.error}`,
            };
            changed = true;
            return;
          }
        } else if (refresh.refreshed) {
          refreshedBeforeQuota = true;
          changed = true;
        }

        const fetchQuota = async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
          return ChatGPTClient.fetchUsage(account.accessToken, controller.signal)
            .finally(() => clearTimeout(timeout));
        };

        let res = await fetchQuota();
        const text = await res.text();

        if (!res.ok) {
          if (res.status === 401 && !refreshedBeforeQuota) {
            const retryRefresh = await this.refreshAccountAccessToken(account, { force: true });
            if (retryRefresh.ok && retryRefresh.refreshed) {
              changed = true;
              const [retryRes, subscriptionExpiresAt] = await Promise.all([
                fetchQuota(),
                this.fetchSubscriptionExpiresAt(account),
              ]);
              res = retryRes;
              const retryText = await res.text();
              if (res.ok) {
                const body = JSON.parse(retryText);
                const rateLimit = body.rate_limit;
                account.codexUsage = {
                  fetchedAt: now,
                  allowed: Boolean(rateLimit?.allowed),
                  limitReached: Boolean(rateLimit?.limit_reached),
                  primaryWindow: this.normalizeUsageWindow(rateLimit?.primary_window),
                  secondaryWindow: this.normalizeUsageWindow(rateLimit?.secondary_window),
                  subscriptionExpiresAt: this.resolveSubscriptionExpiry(subscriptionExpiresAt, account.codexUsage?.subscriptionExpiresAt),
                };
                if (body.plan_type && !account.chatgptPlanType) account.chatgptPlanType = body.plan_type;
                if (account.status === "expired") account.status = "active";
                changed = true;
                return;
              }
              account.codexUsage = {
                fetchedAt: now,
                allowed: false,
                limitReached: false,
                error: this.usageErrorMessage(res.status, retryText),
              };
              if (res.status === 401) account.status = "expired";
              changed = true;
              return;
            }
          }

          account.codexUsage = {
            fetchedAt: now,
            allowed: false,
            limitReached: false,
            error: this.usageErrorMessage(res.status, text),
          };
          if (res.status === 401) account.status = "expired";
          changed = true;
          return;
        }

        const [body, subscriptionExpiresAt, rateLimitResetCount] = await Promise.all([
          Promise.resolve(JSON.parse(text)),
          this.fetchSubscriptionExpiresAt(account),
          this.fetchRateLimitResetCount(account),
        ]);
        const rateLimit = body.rate_limit;
        account.codexUsage = {
          fetchedAt: now,
          allowed: Boolean(rateLimit?.allowed),
          limitReached: Boolean(rateLimit?.limit_reached),
          primaryWindow: this.normalizeUsageWindow(rateLimit?.primary_window),
          secondaryWindow: this.normalizeUsageWindow(rateLimit?.secondary_window),
          subscriptionExpiresAt: this.resolveSubscriptionExpiry(subscriptionExpiresAt, account.codexUsage?.subscriptionExpiresAt),
          rateLimitResetCount,
        };
        if (body.plan_type && !account.chatgptPlanType) account.chatgptPlanType = body.plan_type;
        if (account.status === "expired") account.status = "active";
        changed = true;
      } catch (error) {
        account.codexUsage = {
          fetchedAt: now,
          allowed: false,
          limitReached: false,
          error: error instanceof Error ? error.message : String(error),
        };
        changed = true;
      }
    };

    for (let i = 0; i < pending.length; i += CODEX_USAGE_CONCURRENCY) {
      await Promise.all(pending.slice(i, i + CODEX_USAGE_CONCURRENCY).map(refreshOne));
    }

    if (changed) this.saveAccounts(accounts);
  }

  getActiveAccount(): Account | null {
    const accounts = this.loadAccounts();
    const now = Date.now();

    // reset rate limits that have expired
    let changed = false;
    for (const a of accounts) {
      if (this.ensureUsageWindows(a)) changed = true;
      if (a.status === "rate_limited" && a.rateLimitUntil && now > a.rateLimitUntil) {
        a.status = "active";
        a.rateLimitUntil = undefined;
        changed = true;
      }
    }
    if (changed) this.saveAccounts(accounts);

    // prefer the manually selected account if it's usable
    const selected = accounts.find(
      (a) => a.selected && this.isUsableAccount(a)
    );
    if (selected) return selected;

    // fallback: first non-rate-limited active account
    return accounts.find((a) => this.isUsableAccount(a)) ?? null;
  }

  hasRemainingQuota(account: Account): boolean {
    this.ensureUsageWindows(account);

    const dailyRemaining = (account.dailyUsage?.limit ?? 0) - (account.dailyUsage?.count ?? 0);
    const weeklyRemaining = (account.weeklyUsage?.limit ?? 0) - (account.weeklyUsage?.count ?? 0);
    if (dailyRemaining <= 0 || weeklyRemaining <= 0) return false;

    const usage = account.codexUsage;
    if (usage?.limitReached) return false;

    const primaryRemaining = usage?.primaryWindow
      ? 100 - usage.primaryWindow.usedPercent
      : 1;
    const secondaryRemaining = usage?.secondaryWindow
      ? 100 - usage.secondaryWindow.usedPercent
      : 1;

    return primaryRemaining > 0 && secondaryRemaining > 0;
  }

  isUsableAccount(account: Account): boolean {
    return account.status === "active" && this.hasRemainingQuota(account);
  }

  getSwitchCandidates(excludeAccountId?: string): Account[] {
    const accounts = this.loadAccounts();
    let changed = false;
    for (const account of accounts) {
      if (this.ensureUsageWindows(account)) changed = true;
    }
    if (changed) this.saveAccounts(accounts);

    return accounts.filter((account) => account.id !== excludeAccountId && this.isUsableAccount(account));
  }

  setSelectedAccount(accountId: string): { ok: boolean; error?: string } {
    const accounts = this.loadAccounts();
    const target = accounts.find((a) => a.id === accountId);
    if (!target) return { ok: false, error: "Account does not exist" };

    for (const a of accounts) {
      a.selected = a.id === accountId;
    }
    if (target.status === "rate_limited") {
      target.status = "active";
      target.rateLimitUntil = undefined;
    }
    this.saveAccounts(accounts);
    console.log(`[accounts] Selected account: ${target.email}`);
    return { ok: true };
  }

  /** Gỡ mọi cờ chặn của 1 account (expired / rate_limit / codexUsage.limitReached) → trở lại usable.
   *  Dùng cho switch thủ công: tin tưởng lựa chọn của user, để upstream tự quyết 401/429. */
  clearBlockedState(accountId: string) {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.status = "active";
    account.rateLimitUntil = undefined;
    if (account.codexUsage?.limitReached) {
      account.codexUsage = { ...account.codexUsage, limitReached: false };
    }
    this.saveAccounts(accounts);
    console.log(`[accounts] Cleared blocked state for ${account.email} (manual switch)`);
  }

  markRateLimited(accountId: string, retryAfterMs: number = 60_000) {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.status = "rate_limited";
    account.rateLimitUntil = Date.now() + retryAfterMs;
    this.saveAccounts(accounts);
    console.log(`[accounts] Marked ${account.email} as rate limited for ${retryAfterMs / 1000}s`);
  }

  markExpired(accountId: string) {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.status = "expired";
    this.saveAccounts(accounts);
    console.log(`[accounts] Marked ${account.email} as expired (401)`);
  }

  recordRequest(accountId: string) {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    this.ensureUsageWindows(account);
    account.requestCount++;
    account.dailyUsage!.count++;
    account.weeklyUsage!.count++;
    account.lastUsed = Date.now();
    this.saveAccounts(accounts);
  }

  removeAccount(accountId: string): { ok: boolean; error?: string } {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return { ok: false, error: "Account does not exist" };
    if (account.selected && account.status === "active") {
      return { ok: false, error: "Cannot remove the active account" };
    }
    const nextAccounts = accounts.filter((a) => a.id !== accountId);
    this.saveAccounts(nextAccounts);
    return { ok: true };
  }

  importFromTokens(tokens: Record<string, any>): Account | null {
    const { access_token, refresh_token, id_token } = tokens;
    if (!access_token) return null;

    const payload = this.decodeJwtPayload(access_token);
    const authPayload = payload["https://api.openai.com/auth"] ?? {};
    const email: string = payload.email ?? payload["https://api.openai.com/profile"]?.email ?? "unknown";
    const planType: string = authPayload.chatgpt_plan_type ?? "";
    const account_id: string =
      tokens.account_id ??
      authPayload.chatgpt_account_id ??
      authPayload.account_id ??
      payload.sub ??
      crypto.randomUUID();

    const accounts = this.loadAccounts();
    const existing = accounts.find((a) => a.accountId === account_id || a.email === email);
    if (existing) {
      existing.accessToken = access_token;
      existing.refreshToken = refresh_token ?? existing.refreshToken;
      if (id_token) existing.idToken = id_token;
      existing.accountId = account_id;
      existing.status = "active";
      existing.rateLimitUntil = undefined;
      this.saveAccounts(accounts);
      console.log(`[accounts] Updated existing account: ${email}`);
      return existing;
    }

    const account: Account = {
      id: crypto.randomUUID(),
      email,
      accessToken: access_token,
      refreshToken: refresh_token ?? "",
      idToken: id_token,
      accountId: account_id,
      addedAt: Date.now(),
      status: "active",
      requestCount: 0,
      dailyUsage: { key: this.localDateKey(), count: 0, limit: DEFAULT_DAILY_LIMIT },
      weeklyUsage: { key: this.localWeekKey(), count: 0, limit: DEFAULT_WEEKLY_LIMIT },
      chatgptPlanType: planType,
    };
    accounts.push(account);
    this.saveAccounts(accounts);
    console.log(`[accounts] Added new account from login: ${email} (${planType})`);
    this.onNewAccountHandlers.forEach((h) => { try { h(account); } catch {} });
    return account;
  }

  updateAccountToken(accountId: string, accessToken: string) {
    const accounts = this.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    account.accessToken = accessToken;
    account.status = "active";
    account.rateLimitUntil = undefined;
    this.saveAccounts(accounts);
  }
}
