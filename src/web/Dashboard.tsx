import { type LivequeryDocument } from "@livequery/client";
import { useAction, useCollection, useObservable } from "@livequery/react";
import { useEffect, useState } from "react";
import { AccountCard } from "./AccountCard";
import { ReportsPanel } from "./ReportsPanel";
import { StatsGrid } from "./StatsGrid";
import type { AccountDoc, Notice, ReportDoc } from "./types";

export function Dashboard() {
  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "local-first", lazy: false });
  const reportsCollection = useCollection<ReportDoc>("reports", { mode: "local-first", lazy: false });
  const accountDocs = useObservable(accountsCollection.items, []);
  const reportDocs = useObservable(reportsCollection.items, []);
  const accountsLoading = useObservable(accountsCollection.loading, null);
  const reportsLoading = useObservable(reportsCollection.loading, null);
  const accountError = useObservable(accountsCollection.error, null);
  const reportError = useObservable(reportsCollection.error, null);
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<Notice | null>(null);

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
    try {
      const win = window.open("about:blank", "_blank");
      const result = await callAction<{ authorizeUrl: string }>("start-login");
      setLoginInProgress(true);
      setNotice({ type: "info", message: "Login flow started." });
      if (win) win.location.href = result.authorizeUrl;
      else location.href = result.authorizeUrl;
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not start login." });
    }
  }

  async function copyLoginLink() {
    try {
      const result = await callAction<{ authorizeUrl: string }>("start-login");
      setLoginInProgress(true);
      await navigator.clipboard.writeText(result.authorizeUrl);
      setNotice({ type: "info", message: "Login link copied." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not copy login link." });
    }
  }

  async function cancelLogin() {
    try {
      const result = await callAction<{ inProgress: boolean }>("cancel-login");
      setLoginInProgress(Boolean(result.inProgress));
      setNotice({ type: "info", message: "Login flow cancelled." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not cancel login." });
    }
  }

  async function importCallback() {
    const callbackUrl = prompt("Paste OpenAI callback URL");
    if (!callbackUrl) return;
    try {
      await callAction("import-callback", { callbackUrl });
      setLoginInProgress(false);
      await accountsCollection.query({});
      setNotice({ type: "info", message: "Account imported." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not import callback." });
    }
  }

  async function setConfigProxy(enabled: boolean) {
    try {
      const restartCodex = confirm(`${enabled ? "Install" : "Uninstall"} proxy config. Restart Codex now?`);
      setProxyEnabled(enabled);
      const result = await callAction<{ enabled: boolean; restarted: boolean }>("set-config", { enabled, restartCodex });
      setProxyEnabled(Boolean(result.enabled));
      setNotice({
        type: "info",
        message: `Proxy config ${result.enabled ? "installed" : "uninstalled"}${result.restarted ? " and Codex restarted" : ""}.`,
      });
    } catch (error) {
      await refreshControlState().catch(() => {});
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not update proxy config." });
    }
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
      {notice && <div className={`notice ${notice.type}`}>{notice.message}</div>}

      <StatsGrid
        using={using}
        active={active}
        limited={limited}
        totalRequests={totalRequests}
        accountCount={accounts.length}
      />

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

      <ReportsPanel reports={reports} reportsLoading={reportsLoading} />
    </main>
  );
}
