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
    subscriptionExpiresAt?: number;
    rateLimitResetCount?: number;
  };
  chatgptPlanType?: string;
  selected?: boolean;
  enrolled?: boolean;
  enrollStatus?: "none" | "enrolling" | "ready";
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

export type HostDoc = Doc<{
  env_id: string;
  display_name: string;
  host_name: string;
  online: boolean;
  busy?: boolean;
  account_id: string;
}>;

export type ChatDoc = Doc<{
  title?: string;
  status?: string;
  remote_status?: string;
  environment_id?: string;
  workspace_root?: string;
  created_at?: string;
  updated_at?: string;
  account_id: string;
}>;

export type TurnDoc = Doc<{
  type: string;
  role: string;
  input_items: unknown[];
  output_items: unknown[];
  status?: string;
  created_at?: string;
  /** Stream token-by-token: mỗi delta đẩy 1 mảnh + _seq tăng dần; client tự gộp. */
  _delta?: string;
  _seq?: number;
  account_id: string;
  chat_id: string;
}>;

export type RcHost = {
  env_id: string;
  name?: string;
};

export type RcStatus = {
  enrolled: boolean;
  client_id?: string;
  token_expires_at?: number;
  hosts: RcHost[];
};
