import type { Doc } from "@livequery/client";

export type UsageWindow = {
  key: string;
  count: number;
  limit: number;
};

export type CodexUsageWindow = {
  usedPercent: number;
  resetAfterSeconds: number;
};

export type AccountDoc = Doc<{
  email: string;
  status: "active" | "rate_limited" | "expired";
  rateLimitUntil?: number;
  requestCount: number;
  lastUsed?: number;
  dailyUsage?: UsageWindow;
  weeklyUsage?: UsageWindow;
  codexUsage?: {
    error?: string;
    limitReached: boolean;
    primaryWindow?: CodexUsageWindow;
    secondaryWindow?: CodexUsageWindow;
  };
  chatgptPlanType?: string;
  selected?: boolean;
}>;

export type ReportDoc = Doc<{
  timestamp: number;
  type: string;
  method?: string;
  path?: string;
  status?: number;
  latencyMs?: number;
  email?: string;
  error?: string;
  errorSnippet?: string;
  enabled?: boolean;
  usage?: Record<string, number>;
  from?: string;
  to?: string;
  reason?: string;
}>;

export type Notice = {
  type: "error" | "info";
  message: string;
};
