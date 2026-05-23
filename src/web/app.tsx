import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LivequeryClient,
  LivequeryDocument,
  LivequeryMemoryStorage,
  type Doc,
} from "@livequery/client";
import { RestTransporter } from "@livequery/rest";
import {
  LivequeryClientProvider,
  useAction,
  useCollection,
  useObservable,
} from "@livequery/react";
import "./styles.css";

declare global {
  interface Window {
    __LIVEQUERY_WS_URL__?: string;
  }
}

type UsageWindow = {
  key: string;
  count: number;
  limit: number;
};

type CodexUsageWindow = {
  usedPercent: number;
  resetAfterSeconds: number;
};

type AccountDoc = Doc<{
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

type ReportDoc = Doc<{
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

const livequeryClient = new LivequeryClient({
  storage: new LivequeryMemoryStorage(),
  transporters: {
    rest: new RestTransporter({
      api: `${location.origin}/livequery`,
      ws: window.__LIVEQUERY_WS_URL__,
    }),
  },
});
const appStartedAt = Date.now();

function timeAgo(ms?: number, now = Date.now()) {
  if (!ms) return "never used";
  const diff = ms > now ? ms - now : now - ms;
  const suffix = ms > now ? "from now" : "ago";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ${suffix}`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${suffix}`;
  return `${Math.floor(s / 3600)}h ${suffix}`;
}

function formatReset(seconds?: number) {
  if (!Number.isFinite(seconds) || !seconds) return "00:00:00";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function UsageBar({ label, usage }: { label: string; usage?: UsageWindow }) {
  const count = usage?.count ?? 0;
  const limit = usage?.limit ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.max(0, (count / limit) * 100)) : 0;
  return (
    <div className="usage-row">
      <div className="usage-label">
        <span>{label}</span>
        <span>{limit > 0 ? `${count}/${limit}` : count}</span>
      </div>
      <div className="usage-track">
        <div className={pct >= 90 ? "usage-fill danger" : "usage-fill"} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function QuotaBar({ label, window, now }: { label: string; window?: CodexUsageWindow; now: number }) {
  if (!window) return null;
  const isPending = window.resetAfterSeconds === -1;
  const remaining = Math.max(0, Math.min(100, 100 - Number(window.usedPercent || 0)));
  const resetSeconds = window.resetAfterSeconds
    ? Math.max(0, window.resetAfterSeconds - Math.floor((now - appStartedAt) / 1000))
    : 0;
  return (
    <div className="usage-row">
      <div className="usage-label">
        <span>{label}</span>
        <span>
          {isPending ? <span className="skeleton skeleton-text" /> : `${remaining}% · ${formatReset(resetSeconds)}`}
        </span>
      </div>
      <div className="usage-track">
        {isPending
          ? <div className="skeleton skeleton-bar" />
          : <div className={remaining <= 10 ? "usage-fill danger" : "usage-fill"} style={{ width: `${remaining}%` }} />}
      </div>
    </div>
  );
}

function AccountCard({
  accountDoc,
  now,
}: {
  accountDoc: LivequeryDocument<AccountDoc>;
  now: number;
}) {
  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "server-first", lazy: false });
  const account = useObservable(accountDoc, accountDoc.value);
  const accountAction = useAction(async (action: string, payload?: Record<string, unknown>) => {
    return await accountsCollection.trigger(action, payload);
  });
  const isUsing = account.selected && !["rate_limited", "expired"].includes(account.status);
  const hasRemoteUsage = account.codexUsage?.primaryWindow || account.codexUsage?.secondaryWindow;

  async function selectAccount() {
    await accountAction("select-account", { id: account.id });
    await accountsCollection.query({});
  }

  async function removeAccount() {
    if (!confirm("Remove this account?")) return;
    await accountAction("remove-account", { id: account.id });
    await accountsCollection.query({});
  }

  return (
    <div className={`account-card ${isUsing ? "selected" : account.status}`}>
      <div className="avatar">{(account.email || "?").charAt(0).toUpperCase()}</div>
      <div className="account-info">
        <div className="email">{account.email}</div>
        <div className="meta">
          {[account.chatgptPlanType?.toUpperCase(), `${account.requestCount || 0} req`, timeAgo(account.lastUsed, now)]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {account.codexUsage?.error ? (
          <div className="error-line">{account.codexUsage.error}</div>
        ) : (
          <div className="usage-bars">
            {hasRemoteUsage ? (
              <>
                <QuotaBar label="Daily" window={account.codexUsage?.primaryWindow} now={now} />
                <QuotaBar label="Weekly" window={account.codexUsage?.secondaryWindow} now={now} />
              </>
            ) : (
              <>
                <UsageBar label="Daily" usage={account.dailyUsage} />
                <UsageBar label="Weekly" usage={account.weeklyUsage} />
              </>
            )}
          </div>
        )}
      </div>
      <div className="actions">
        {isUsing ? (
          <span className="running" />
        ) : (
          <button disabled={accountAction.loading} onClick={() => void selectAccount()}>
            {accountAction.loading ? <span className="inline-spinner compact" /> : null}
            Switch
          </button>
        )}
        {!isUsing && (
          <button className="danger-btn" disabled={accountAction.loading} onClick={() => void removeAccount()}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function reportClass(report: ReportDoc) {
  if (report.type === "account_switched") return "report accent";
  if (report.type?.startsWith("login_")) return report.error ? "report danger" : "report accent";
  if (report.status === 429) return "report warn";
  if ((report.status ?? 0) >= 400) return "report danger";
  return "report";
}

function ReportRow({ reportDoc }: { reportDoc: LivequeryDocument<ReportDoc> }) {
  const report = useObservable(reportDoc, reportDoc.value);
  const time = new Date(report.timestamp).toLocaleTimeString("vi-VN", { hour12: false });
  const title = report.type === "request"
    ? `${report.method ?? ""} ${report.path ?? ""}`
    : report.type.replace(/_/g, " ");
  const detail = report.type === "account_switched"
    ? `${report.from} -> ${report.to} [${report.reason}]`
    : report.email || report.error || report.errorSnippet || "";
  return (
    <div className={reportClass(report)}>
      <span className="report-time">{time}</span>
      <span className="report-title">{title}</span>
      {report.status && <span className="report-status">{report.status}</span>}
      {report.latencyMs && <span className="report-dim">{report.latencyMs}ms</span>}
      {detail && <span className="report-dim">{detail}</span>}
    </div>
  );
}

function Dashboard() {
  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "server-first", lazy: false });
  const reportsCollection = useCollection<ReportDoc>("reports", { mode: "server-first", lazy: false });
  const accountDocs = useObservable(accountsCollection.items, []);
  const reportDocs = useObservable(reportsCollection.items, []);
  const accountsLoading = useObservable(accountsCollection.loading, null);
  const reportsLoading = useObservable(reportsCollection.loading, null);
  const accountError = useObservable(accountsCollection.error, null);
  const reportError = useObservable(reportsCollection.error, null);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [now, setNow] = useState(Date.now());

  const callAction = useAction(async <T,>(action: string, payload?: Record<string, unknown>): Promise<T> => {
    return await accountsCollection.trigger<T>(action, payload) as T;
  });

  async function refreshControlState() {
    const login = await accountsCollection.trigger<{ inProgress: boolean }>("login-status") as { inProgress: boolean };
    const config = await accountsCollection.trigger<{ enabled: boolean }>("config-status") as { enabled: boolean };
    setLoginInProgress(Boolean(login.inProgress));
    setProxyEnabled(Boolean(config.enabled));
  }

  useEffect(() => {
    accountsCollection.query({});
    reportsCollection.query({ ":limit": 200 });
    refreshControlState().catch(() => {});
    const id = setInterval(() => {
      accountsCollection.query({});
      refreshControlState().catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, [accountsCollection, reportsCollection]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function startLogin() {
    const win = window.open("about:blank", "_blank");
    const result = await callAction<{ authorizeUrl: string }>("start-login");
    setLoginInProgress(true);
    if (win) win.location.href = result.authorizeUrl;
    else location.href = result.authorizeUrl;
  }

  async function copyLoginLink() {
    const result = await callAction<{ authorizeUrl: string }>("start-login");
    setLoginInProgress(true);
    await navigator.clipboard.writeText(result.authorizeUrl);
  }

  async function cancelLogin() {
    const result = await callAction<{ inProgress: boolean }>("cancel-login");
    setLoginInProgress(Boolean(result.inProgress));
  }

  async function importCallback() {
    const callbackUrl = prompt("Paste OpenAI callback URL");
    if (!callbackUrl) return;
    await callAction("import-callback", { callbackUrl });
    setLoginInProgress(false);
    await accountsCollection.query({});
  }

  async function setConfigProxy(enabled: boolean) {
    setProxyEnabled(enabled);
    const result = await callAction<{ enabled: boolean }>("set-config", { enabled });
    setProxyEnabled(Boolean(result.enabled));
  }

  const accounts = accountDocs as LivequeryDocument<AccountDoc>[];
  const reports = reportDocs as LivequeryDocument<ReportDoc>[];
  const accountSnapshots = accounts.map((doc) => doc.value);
  const active = accountSnapshots.filter((a) => a.status === "active").length;
  const using = accountSnapshots.filter((a) => a.selected && a.status === "active").length;
  const limited = accountSnapshots.filter((a) => a.status === "rate_limited").length;
  const totalRequests = accountSnapshots.reduce((sum, account) => sum + (account.requestCount || 0), 0);

  return (
    <main>
      <header>
        <h1>Codex Proxy</h1>
        <span className="badge">{accountError || reportError ? "Degraded" : "Online"}</span>
      </header>

      <section className="toolbar">
        <div className="toolbar-actions">
          <button disabled={loginInProgress || callAction.loading} onClick={() => void startLogin()}>
            {loginInProgress ? "Logging in..." : "Login"}
          </button>
          <button disabled={callAction.loading} onClick={() => void copyLoginLink()}>Copy login link</button>
          {loginInProgress && <button className="danger-btn" onClick={() => void cancelLogin()}>Cancel</button>}
          <button disabled={callAction.loading} onClick={() => void importCallback()}>Import account</button>
          <button disabled={callAction.loading || proxyEnabled} onClick={() => void setConfigProxy(true)}>Install</button>
          <button className="secondary-btn" disabled={callAction.loading || !proxyEnabled} onClick={() => void setConfigProxy(false)}>Uninstall</button>
        </div>
      </section>

      <section className="stats">
        <div><span>In use</span><strong>{using || active}</strong></div>
        <div><span>Rate limited</span><strong>{limited}</strong></div>
        <div><span>Total requests</span><strong>{totalRequests.toLocaleString()}</strong></div>
        <div><span>Total accounts</span><strong>{accounts.length}</strong></div>
      </section>

      <section>
        <h2>Accounts</h2>
        <div className="account-list">
          {accounts.length === 0 && accountsLoading
            ? <div className="empty"><span className="inline-spinner" /> Loading accounts...</div>
            : accounts.length === 0
              ? <div className="empty">No accounts yet.</div>
              : accounts.map((accountDoc) => (
              <AccountCard
                key={accountDoc.value.id}
                accountDoc={accountDoc}
                now={now}
              />
            ))}
        </div>
      </section>

      <section>
        <h2>Reports {reportsLoading && <span className="section-loading"><span className="inline-spinner" /> loading</span>}</h2>
        <div className="reports">
          {reports.length === 0 && reportsLoading
            ? <div className="empty"><span className="inline-spinner" /> Loading reports...</div>
            : reports.length === 0
              ? <div className="empty">No reports yet.</div>
              : reports.slice(0, 200).map((reportDoc) => <ReportRow key={reportDoc.value.id} reportDoc={reportDoc} />)}
        </div>
      </section>
    </main>
  );
}

function App() {
  return (
    <LivequeryClientProvider core={livequeryClient}>
      <Dashboard />
    </LivequeryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
