import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Account, CodexUsage, UsageWindow } from "./types";
import { CODEX_USAGE_URL } from "./libs/chatgpt";

const ACCOUNTS_FILE = join(import.meta.dir, "..", "..", "accounts.json");
const ACCOUNT_STATE_FILE = join(import.meta.dir, "..", "..", "account-state.json");
const DEFAULT_DAILY_LIMIT = readLimit("CODEX_DAILY_LIMIT", 100);
const DEFAULT_WEEKLY_LIMIT = readLimit("CODEX_WEEKLY_LIMIT", 500);
const CODEX_USAGE_TTL_MS = readLimit("CODEX_USAGE_TTL_SECONDS", 60) * 1000;
const CODEX_USAGE_CONCURRENCY = readLimit("CODEX_USAGE_CONCURRENCY", 3);
const CODEX_USAGE_TIMEOUT_MS = readLimit("CODEX_USAGE_TIMEOUT_MS", 3000);

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

function readLimit(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localWeekKey(date = new Date()): string {
  const monday = new Date(date);
  const day = monday.getDay() || 7;
  monday.setDate(monday.getDate() - day + 1);
  return localDateKey(monday);
}

function ensureUsageWindows(account: Account): boolean {
  let changed = false;
  const dayKey = localDateKey();
  const weekKey = localWeekKey();

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

function ensureProxyHome() {
  // accounts.json lives at project root, directory always exists
}

function decodeJwtPayload(token: string): Record<string, any> {
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

function loadAccounts(): Account[] {
  ensureProxyHome();
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try {
    const accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as PersistedAccount[];
    const state = loadAccountState();
    let migrated = false;
    const merged = accounts.map((account) => {
      const embeddedState = extractAccountState(account);
      if (Object.keys(embeddedState).length > 0) migrated = true;
      return {
        status: "active",
        requestCount: 0,
        ...account,
        ...embeddedState,
        ...state[account.id],
      } as Account;
    });
    if (migrated) saveAccounts(merged);
    return merged;
  } catch {
    return [];
  }
}

function saveAccounts(accounts: Account[]) {
  ensureProxyHome();
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts.map(stripAccountState), null, 2));
  saveAccountState(Object.fromEntries(accounts.map((account) => [account.id, extractAccountState(account)])));
}

function loadAccountState(): AccountStateFile {
  if (!existsSync(ACCOUNT_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ACCOUNT_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveAccountState(state: AccountStateFile) {
  writeFileSync(ACCOUNT_STATE_FILE, JSON.stringify(state, null, 2));
}

function stripAccountState(account: Account): PersistedAccount {
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

function extractAccountState(account: Partial<Account>): AccountRuntimeState {
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

export function getAccounts(): Account[] {
  const accounts = loadAccounts();
  let changed = false;
  for (const account of accounts) {
    if (ensureUsageWindows(account)) changed = true;
  }
  if (changed) saveAccounts(accounts);
  return accounts;
}

function normalizeUsageWindow(value: any) {
  if (!value) return undefined;
  return {
    usedPercent: Number(value.used_percent ?? 0),
    limitWindowSeconds: Number(value.limit_window_seconds ?? 0),
    resetAfterSeconds: Number(value.reset_after_seconds ?? 0),
    resetAt: Number(value.reset_at ?? 0),
  };
}

function usageErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.code || parsed?.error?.message || `HTTP ${status}`;
  } catch {
    return text.slice(0, 120) || `HTTP ${status}`;
  }
}

export async function refreshCodexUsageForAccounts(force = false): Promise<void> {
  const accounts = loadAccounts();
  const now = Date.now();
  let changed = false;

  const pending = accounts.filter((account) => {
    if (!force && account.codexUsage?.fetchedAt && now - account.codexUsage.fetchedAt < CODEX_USAGE_TTL_MS) {
      return false;
    }
    return true;
  });

  async function refreshOne(account: Account) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
      const res = await fetch(CODEX_USAGE_URL, {
          signal: controller.signal,
          headers: {
            accept: "*/*",
            authorization: `Bearer ${account.accessToken}`,
            "cache-control": "no-cache",
            pragma: "no-cache",
            referer: "https://chatgpt.com/codex/cloud/settings/analytics",
            "x-openai-target-path": "/backend-api/wham/usage",
            "x-openai-target-route": "/backend-api/wham/usage",
            "user-agent": "Mozilla/5.0",
          },
        })
        .finally(() => clearTimeout(timeout));
      const text = await res.text();

      if (!res.ok) {
        account.codexUsage = {
          fetchedAt: now,
          allowed: false,
          limitReached: false,
          error: usageErrorMessage(res.status, text),
        };
        if (res.status === 401) account.status = "expired";
        changed = true;
        return;
      }

      const body = JSON.parse(text);
      const rateLimit = body.rate_limit;
      account.codexUsage = {
        fetchedAt: now,
        allowed: Boolean(rateLimit?.allowed),
        limitReached: Boolean(rateLimit?.limit_reached),
        primaryWindow: normalizeUsageWindow(rateLimit?.primary_window),
        secondaryWindow: normalizeUsageWindow(rateLimit?.secondary_window),
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
  }

  for (let i = 0; i < pending.length; i += CODEX_USAGE_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + CODEX_USAGE_CONCURRENCY).map(refreshOne));
  }

  if (changed) saveAccounts(accounts);
}

export function getActiveAccount(): Account | null {
  const accounts = loadAccounts();
  const now = Date.now();

  // reset rate limits that have expired
  let changed = false;
  for (const a of accounts) {
    if (ensureUsageWindows(a)) changed = true;
    if (a.status === "rate_limited" && a.rateLimitUntil && now > a.rateLimitUntil) {
      a.status = "active";
      a.rateLimitUntil = undefined;
      changed = true;
    }
  }
  if (changed) saveAccounts(accounts);

  // prefer the manually selected account if it's usable
  const selected = accounts.find(
    (a) => a.selected && isUsableAccount(a)
  );
  if (selected) return selected;

  // fallback: first non-rate-limited active account
  return accounts.find((a) => isUsableAccount(a)) ?? null;
}

export function hasRemainingQuota(account: Account): boolean {
  ensureUsageWindows(account);

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

export function isUsableAccount(account: Account): boolean {
  return account.status === "active" && hasRemainingQuota(account);
}

export function getSwitchCandidates(excludeAccountId?: string): Account[] {
  const accounts = loadAccounts();
  let changed = false;
  for (const account of accounts) {
    if (ensureUsageWindows(account)) changed = true;
  }
  if (changed) saveAccounts(accounts);

  return accounts.filter((account) => account.id !== excludeAccountId && isUsableAccount(account));
}

export function setSelectedAccount(accountId: string): { ok: boolean; error?: string } {
  const accounts = loadAccounts();
  const target = accounts.find((a) => a.id === accountId);
  if (!target) return { ok: false, error: "Account does not exist" };

  for (const a of accounts) {
    a.selected = a.id === accountId;
  }
  if (target.status === "rate_limited") {
    target.status = "active";
    target.rateLimitUntil = undefined;
  }
  saveAccounts(accounts);
  console.log(`[accounts] Selected account: ${target.email}`);
  return { ok: true };
}

export function markRateLimited(accountId: string, retryAfterMs: number = 60_000) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;
  account.status = "rate_limited";
  account.rateLimitUntil = Date.now() + retryAfterMs;
  saveAccounts(accounts);
  console.log(`[accounts] Marked ${account.email} as rate limited for ${retryAfterMs / 1000}s`);
}

export function markExpired(accountId: string) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;
  account.status = "expired";
  saveAccounts(accounts);
  console.log(`[accounts] Marked ${account.email} as expired (401)`);
}

export function recordRequest(accountId: string) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;
  ensureUsageWindows(account);
  account.requestCount++;
  account.dailyUsage!.count++;
  account.weeklyUsage!.count++;
  account.lastUsed = Date.now();
  saveAccounts(accounts);
}

export function removeAccount(accountId: string): { ok: boolean; error?: string } {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: "Account does not exist" };
  if (account.selected && account.status === "active") {
    return { ok: false, error: "Cannot remove the active account" };
  }
  const nextAccounts = accounts.filter((a) => a.id !== accountId);
  saveAccounts(nextAccounts);
  return { ok: true };
}

export function importFromTokens(tokens: Record<string, any>): Account | null {
  const { access_token, refresh_token, id_token } = tokens;
  if (!access_token) return null;

  const payload = decodeJwtPayload(access_token);
  const authPayload = payload["https://api.openai.com/auth"] ?? {};
  const email: string = payload.email ?? payload["https://api.openai.com/profile"]?.email ?? "unknown";
  const planType: string = authPayload.chatgpt_plan_type ?? "";
  const account_id: string =
    tokens.account_id ??
    authPayload.chatgpt_account_id ??
    authPayload.account_id ??
    payload.sub ??
    crypto.randomUUID();

  const accounts = loadAccounts();
  const existing = accounts.find((a) => a.accountId === account_id || a.email === email);
  if (existing) {
    existing.accessToken = access_token;
    existing.refreshToken = refresh_token ?? existing.refreshToken;
    if (id_token) existing.idToken = id_token;
    existing.accountId = account_id;
    existing.status = "active";
    existing.rateLimitUntil = undefined;
    saveAccounts(accounts);
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
    dailyUsage: { key: localDateKey(), count: 0, limit: DEFAULT_DAILY_LIMIT },
    weeklyUsage: { key: localWeekKey(), count: 0, limit: DEFAULT_WEEKLY_LIMIT },
    chatgptPlanType: planType,
  };
  accounts.push(account);
  saveAccounts(accounts);
  console.log(`[accounts] Added new account from login: ${email} (${planType})`);
  return account;
}

export function updateAccountToken(accountId: string, accessToken: string) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return;
  account.accessToken = accessToken;
  account.status = "active";
  account.rateLimitUntil = undefined;
  saveAccounts(accounts);
}
