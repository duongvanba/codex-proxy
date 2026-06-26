import { useCallback, useEffect, useRef, useState } from "react";
import type { RcHost, RcStatus } from "@codex/types";
import { WORKER_SERVICES, useService } from "@/hooks/useWorkerService";

async function authHeaders(getAccessToken: () => Promise<string | null>, headers: Record<string, string> = {}) {
  const token = await getAccessToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

async function runShellStream(
  accountId: string,
  envId: string,
  command: string,
  getAccessToken: () => Promise<string | null>,
  onDelta: (delta: string) => void
): Promise<{ exitCode: number; threadId?: string }> {
  const res = await fetch(`/livequery/accounts/${accountId}/~rc-shell`, {
    method: "POST",
    headers: await authHeaders(getAccessToken, { "Content-Type": "application/json" }),
    body: JSON.stringify({ env_id: envId, command }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exitCode = 0;
  let threadId: string | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(chunk.slice(6)) as { delta?: string; done?: boolean; exit_code?: number; thread_id?: string; error?: string };
        if (data.delta) onDelta(data.delta);
        if (data.error) throw new Error(data.error);
        if (data.done) { exitCode = data.exit_code ?? 0; threadId = data.thread_id; }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return { exitCode, threadId };
}

export function RemoteEnrollPanel({ accountId }: { accountId: string }) {
  const auth = useService(WORKER_SERVICES.auth);
  const [status, setStatus] = useState<RcStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEnvId, setSelectedEnvId] = useState<string>("");
  const [shellCmd, setShellCmd] = useState("");
  const [shellOutput, setShellOutput] = useState("");
  const [shellRunning, setShellRunning] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/livequery/accounts/${accountId}/rc-hosts`, { headers: await authHeaders(auth.getAccessToken) });
      const data = await res.json() as { data?: { item?: RcStatus }; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      const item = data.data?.item ?? { enrolled: false, hosts: [] };
      setStatus(item);
      if (item.hosts.length > 0 && !selectedEnvId) setSelectedEnvId(item.hosts[0]!.env_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load RC status");
    } finally {
      setLoading(false);
    }
  }, [accountId, auth, selectedEnvId]);

  useEffect(() => { loadStatus(); }, [accountId]);
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [shellOutput]);

  async function handleEnroll() {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/livequery/accounts/${accountId}/~rc-enroll-start`, {
        method: "POST", headers: await authHeaders(auth.getAccessToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ account_id: accountId }),
      });
      const data = await res.json() as { data?: { authorize_url?: string }; error?: { message?: string } };
      if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      if (data.data?.authorize_url) window.open(data.data.authorize_url, "_blank");
      setTimeout(() => { loadStatus(); }, 3000);
    } catch (e) { setError(e instanceof Error ? e.message : "Enrollment failed");
    } finally { setLoading(false); }
  }

  async function handleDisconnect() {
    if (!confirm("Ngắt kết nối điều khiển từ xa?")) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/livequery/accounts/${accountId}/~rc-enroll-delete`, {
        method: "POST", headers: await authHeaders(auth.getAccessToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ account_id: accountId }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})) as any; throw new Error(d.error?.message ?? `HTTP ${res.status}`); }
      await loadStatus();
    } catch (e) { setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally { setLoading(false); }
  }

  async function handleRunShell() {
    if (!shellCmd.trim() || !selectedEnvId || shellRunning) return;
    setShellRunning(true); setShellError(null); setLastExitCode(null); setShellOutput("");
    try {
      const result = await runShellStream(accountId, selectedEnvId, shellCmd.trim(), auth.getAccessToken, (d) => setShellOutput((o) => o + d));
      setLastExitCode(result.exitCode);
    } catch (e) { setShellError(e instanceof Error ? e.message : "Shell command failed");
    } finally { setShellRunning(false); }
  }

  const activeHosts: RcHost[] = status?.hosts ?? [];
  const activeHost = activeHosts.find((h) => h.env_id === selectedEnvId) ?? activeHosts[0];
  const canRunShell = !!selectedEnvId && status?.enrolled;

  return (
    <div className="rc-panel">
      <div className="rc-enrollment">
        <div className="rc-enrollment-header">
          <span className="rc-label">Điều khiển từ xa</span>
          <span className={`rc-status-badge ${status?.enrolled ? "enrolled" : "not-enrolled"}`}>
            {loading ? "..." : status?.enrolled ? "Đã kết nối" : "Chưa kết nối"}
          </span>
        </div>
        {error && <div className="rc-error">{error}</div>}
        <div className="rc-enrollment-actions">
          {!status?.enrolled ? (
            <button disabled={loading} onClick={() => void handleEnroll()}>
              {loading ? <span className="inline-spinner compact" /> : null} Kết nối
            </button>
          ) : (
            <button className="danger-btn" disabled={loading} onClick={() => void handleDisconnect()}>Ngắt kết nối</button>
          )}
          <button className="secondary-btn" disabled={loading} onClick={() => void loadStatus()}>Làm mới</button>
        </div>
      </div>
      {status?.enrolled && activeHosts.length > 0 && (
        <div className="rc-hosts">
          <div className="rc-section-label">Máy từ xa</div>
          {activeHosts.length > 1 ? (
            <select value={selectedEnvId} onChange={(e) => setSelectedEnvId(e.target.value)} className="rc-host-select">
              {activeHosts.map((h) => <option key={h.env_id} value={h.env_id}>{h.name ?? h.env_id}</option>)}
            </select>
          ) : (
            <div className="rc-host-name">{activeHost?.name ?? activeHost?.env_id}</div>
          )}
        </div>
      )}
      {status?.enrolled && (
        <div className="rc-shell">
          <div className="rc-section-label">Shell</div>
          <div className="rc-shell-input-row">
            <input className="rc-shell-input" type="text" placeholder={canRunShell ? "Nhập lệnh..." : "Chưa chọn máy"}
              value={shellCmd} disabled={!canRunShell || shellRunning}
              onChange={(e) => setShellCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleRunShell()}
            />
            <button disabled={!shellCmd.trim() || !canRunShell || shellRunning} onClick={() => void handleRunShell()}>
              {shellRunning ? <span className="inline-spinner compact" /> : "Chạy"}
            </button>
          </div>
          {shellError && <div className="rc-error">{shellError}</div>}
          {(shellOutput || shellRunning) && (
            <div className="rc-shell-output-wrap">
              {lastExitCode !== null && (
                <div className={`rc-exit-code ${lastExitCode === 0 ? "ok" : "fail"}`}>Thoát {lastExitCode}</div>
              )}
              <pre className="rc-shell-output" ref={outputRef}>
                {shellOutput}
                {shellRunning && <span className="streaming-dot" />}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
