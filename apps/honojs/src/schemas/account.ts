export interface Account {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId: string;
  addedAt: number;
  status: "active" | "rate_limited" | "expired";
  rateLimitUntil?: number;
  requestCount: number;
  lastUsed?: number;
  dailyUsage?: UsageWindow;
  weeklyUsage?: UsageWindow;
  codexUsage?: CodexUsage;
  chatgptPlanType?: string;
  selected?: boolean;
}

export interface UsageWindow {
  key: string;
  count: number;
  limit: number;
}

export interface CodexUsage {
  fetchedAt: number;
  allowed: boolean;
  limitReached: boolean;
  primaryWindow?: CodexUsageWindow;
  secondaryWindow?: CodexUsageWindow;
  subscriptionExpiresAt?: number;
  error?: string;
}

export interface CodexUsageWindow {
  usedPercent: number;
  limitWindowSeconds: number;
  resetAfterSeconds: number;
  resetAt: number;
}

export interface ProxyConfig {
  port: number;
  targetBase: string;
  activeAccountId?: string;
}

export interface StatsEntry {
  timestamp: number;
  accountId: string;
  path: string;
  status: number;
  latencyMs: number;
}
