import { type LivequeryDocument, type LivequeryLoadingState } from "@livequery/client";
import { BehaviorSubject } from "rxjs";
import { useAction, useCollection, useObservable } from "@livequery/react";
import { useEffect, useState } from "react";
import { useNavigate } from "@remix-run/react";
import { AccountCard } from "@components/AccountCard";
import { ReportsPanel } from "@components/ReportsPanel";
import { StatsGrid } from "@components/StatsGrid";
import type { AccountDoc, Notice, ReportDoc } from "@codex/types";

function AccountListEmpty({ loading$ }: { loading$: BehaviorSubject<LivequeryLoadingState | null> }) {
  const loading = useObservable(loading$);
  if (loading) return <div className="empty"><span className="inline-spinner" /> Loading accounts...</div>;
  return <div className="empty">No accounts yet.</div>;
}

export default function Page() {
  const navigate = useNavigate();

  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "server-first", filters: {} });
  const accountDocs = useObservable(accountsCollection.items, []) as LivequeryDocument<AccountDoc>[];
  const reportsCollection = useCollection<ReportDoc>("reports", { mode: "server-first", filters: { ":limit": 200 } });
  const reportDocs = useObservable(reportsCollection.items, []);
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
    const login = await accountsCollection.trigger<{ in_progress: boolean }>("login-status") as { in_progress: boolean };
    const config = await accountsCollection.trigger<{ enabled: boolean }>("config-status", { public_base_url: location.origin }) as { enabled: boolean };
    setLoginInProgress(Boolean(login.in_progress));
    setProxyEnabled(Boolean(config.enabled));
  }

  useEffect(() => {
    refreshControlState().catch(() => {});
    const id = setInterval(() => refreshControlState().catch(() => {}), 30000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function startLogin() {
    try {
      const result = await callAction<{ authorize_url: string }>("start-login");
      setLoginInProgress(true);
      const opened = window.open(result.authorize_url, "_blank");
      if (!opened) window.location.href = result.authorize_url;
      setNotice({ type: "info", message: "Login page opened. Complete login in the browser." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not start login." });
    }
  }

  async function copyLoginLink() {
    try {
      const result = await callAction<{ authorize_url: string }>("start-login");
      setLoginInProgress(true);
      await navigator.clipboard.writeText(result.authorize_url);
      setNotice({ type: "info", message: "Login link copied." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not copy login link." });
    }
  }

  async function cancelLogin() {
    try {
      const result = await callAction<{ in_progress: boolean }>("cancel-login");
      setLoginInProgress(Boolean(result.in_progress));
      setNotice({ type: "info", message: "Login flow cancelled." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not cancel login." });
    }
  }

  async function importCallback() {
    const import_input = prompt("Paste OpenAI callback URL or account JSON");
    if (!import_input) return;
    try {
      await callAction("import-callback", { import_input });
      setLoginInProgress(false);
      await accountsCollection.query({});
      setNotice({ type: "info", message: "Account imported." });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Could not import callback." });
    }
  }

  async function setConfigProxy(enabled: boolean) {
    try {
      const restart_codex = confirm(`${enabled ? "Install" : "Uninstall"} proxy config. Restart Codex now?`);
      setProxyEnabled(enabled);
      const result = await callAction<{ enabled: boolean; restarted: boolean }>("set-config", {
        enabled, restart_codex, public_base_url: location.origin,
      });
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

  const accounts = accountDocs;
  const reports = reportDocs as LivequeryDocument<ReportDoc>[];
  const accountSnapshots = accounts.map((doc) => doc.getValue());
  const active = accountSnapshots.filter((a) => a.status === "active").length;
  const using = accountSnapshots.filter((a) => a.selected && a.status === "active").length;
  const limited = accountSnapshots.filter((a) => a.status === "rate_limited").length;
  const totalRequests = accountSnapshots.reduce((sum, a) => sum + (a.requestCount || 0), 0);

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

      <StatsGrid using={using} active={active} limited={limited} totalRequests={totalRequests} accountCount={accounts.length} />

      <section>
        <h2>Accounts</h2>
        <div className="account-list">
          {accounts.length === 0
            ? <AccountListEmpty loading$={accountsCollection.loading} />
            : accounts.map((accountDoc) => (
              <AccountCard
                key={accountDoc.getValue().id}
                accountDoc={accountDoc}
                now={now}
                onOpen={() => navigate(`/accounts/${accountDoc.getValue().id}`)}
              />
            ))}
        </div>
      </section>

      <ReportsPanel reports={reports} reportsLoading$={reportsCollection.loading} />
    </main>
  );
}
