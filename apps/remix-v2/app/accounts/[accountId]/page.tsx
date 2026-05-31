import { useNavigate, useParams } from "@remix-run/react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { AccountDoc, HostDoc } from "@codex/types";
import { useState, useEffect } from "react";
import { useHosts } from "@context/hosts-context";
import { useTrigger } from "@helpers/use-trigger";

function HostCard({ doc, onOpen }: { doc: LivequeryDocument<HostDoc>; onOpen: () => void }) {
  const host = useObservable(doc);
  return (
    <div className={`host-card ${host.online ? "online" : "offline"}`} onClick={onOpen}>
      <div className="host-status-dot" data-online={host.online} />
      <div className="host-info">
        <div className="host-name">{host.display_name || host.host_name}</div>
        {host.display_name && host.host_name !== host.display_name && (
          <div className="host-meta">{host.host_name}</div>
        )}
      </div>
      <span className={`host-badge ${host.online ? (host.busy ? "busy" : "ready") : "offline"}`}>
        {host.online ? (host.busy ? "Busy" : "Ready") : "Offline"}
      </span>
    </div>
  );
}

function EnrollSection({ accountId }: { accountId: string }) {
  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "server-first", filters: {} });
  const accountDocs = useObservable(accountsCollection.items, []) as LivequeryDocument<AccountDoc>[];
  const account = accountDocs.find((d) => d.getValue().id === accountId)?.getValue();
  const enrolled = account?.enrolled ?? false;
  const [error, setError] = useState<string | null>(null);
  const trigger = useTrigger();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "enroll-success") {
        accountsCollection.query({}).catch(() => {});
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [accountsCollection]);

  async function handleEnroll() {
    setError(null);
    try {
      const res = await trigger<{ enrollUrl: string }>(`accounts/${accountId}`, "rc-enroll-start");
      if (res?.enrollUrl) window.open(res.enrollUrl, "_blank", "width=600,height=700");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRevoke() {
    if (!confirm("Remove remote control enrollment?")) return;
    setError(null);
    try {
      await trigger(`accounts/${accountId}`, "rc-enroll-delete");
      await accountsCollection.query({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="enroll-section">
      <div className="enroll-header">
        <span className={`enroll-dot ${enrolled ? "enrolled" : "unenrolled"}`} />
        <span className="enroll-label">
          {enrolled ? "Remote Control: connected" : "Remote Control: not enrolled"}
        </span>
        <button className="enroll-revoke-btn secondary-btn" onClick={() => accountsCollection.query({}).catch(() => {})} disabled={trigger.loading} title="Refresh status">↻</button>
        {enrolled && (
          <button className="enroll-revoke-btn" onClick={handleRevoke} disabled={trigger.loading}>Revoke</button>
        )}
      </div>
      {!enrolled && (
        <div className="enroll-actions">
          <button className="primary-btn" onClick={handleEnroll} disabled={trigger.loading}>
            {trigger.loading ? "Working…" : "Enroll Remote Control"}
          </button>
        </div>
      )}
      {error && <div className="enroll-msg err">{error}</div>}
    </div>
  );
}

export default function Page() {
  const navigate = useNavigate();
  const { accountId } = useParams<{ accountId: string }>();
  const { hostsCollection } = useHosts();
  const hostDocs = useObservable(hostsCollection.items, []) as LivequeryDocument<HostDoc>[];

  return (
    <div className="host-list-page">
      <div className="host-list-header">
        <button className="btn-sidebar-back" title="Back to accounts" onClick={() => navigate("/")}>←</button>
        <h2>Hosts</h2>
      </div>
      <EnrollSection accountId={accountId!} />
      <div className="host-list">
        {hostDocs.length === 0 && <div className="empty">No hosts online for this account.</div>}
        {hostDocs.map((doc) => (
          <HostCard
            key={doc.getValue().env_id}
            doc={doc}
            onOpen={() => navigate(`/accounts/${accountId}/hosts/${doc.getValue().env_id}`)}
          />
        ))}
      </div>
    </div>
  );
}
