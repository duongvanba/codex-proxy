import { type LivequeryDocument } from "@livequery/client";
import { useAction, useCollection, useObservable } from "@livequery/react";
import { ActionError } from "./ActionError";
import { appStartedAt, formatReset, timeAgo } from "./time";
import type { AccountDoc, CodexUsageWindow, UsageWindow } from "./types";

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

function AccountUsage({ account, now }: { account: AccountDoc; now: number }) {
  const hasRemoteUsage = account.codexUsage?.primaryWindow || account.codexUsage?.secondaryWindow;

  if (account.codexUsage?.error) {
    return <div className="error-line">{account.codexUsage.error}</div>;
  }

  return (
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
  );
}

function hasFallbackQuota(account: AccountDoc) {
  const dailyRemaining = (account.dailyUsage?.limit ?? 0) - (account.dailyUsage?.count ?? 0);
  return dailyRemaining > 0;
}

function hasRemoteQuota(account: AccountDoc) {
  const primary = account.codexUsage?.primaryWindow;
  const hasPrimary = primary && primary.resetAfterSeconds !== -1;

  if (!hasPrimary) return true;

  const primaryRemaining = hasPrimary ? 100 - Number(primary.usedPercent || 0) : 1;
  return primaryRemaining > 0;
}

function isSwitchableAccount(account: AccountDoc) {
  return account.status !== "expired";
}

function AccountActions({ account, isUsing }: { account: AccountDoc; isUsing: boolean }) {
  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "local-first", lazy: false });
  const accountAction = useAction(async (action: string, payload?: Record<string, unknown>) => {
    return await accountsCollection.trigger(action, payload);
  });
  const switchDisabled = accountAction.loading || !isSwitchableAccount(account);

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
    <div className="action-stack">
      <div className="actions">
        {isUsing ? (
          <span className="running" />
        ) : (
          <button disabled={switchDisabled} title={switchDisabled ? "This account is not currently usable" : undefined} onClick={() => void selectAccount()}>
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
      <ActionError error={accountAction.error} />
    </div>
  );
}

export function AccountCard({
  accountDoc,
  now,
  onOpen,
}: {
  accountDoc: LivequeryDocument<AccountDoc>;
  now: number;
  onOpen?: () => void;
}) {
  const account = useObservable(accountDoc);
  const isUsing = Boolean(account.selected && !["rate_limited", "expired"].includes(account.status));

  function handleContextMenu(e: React.MouseEvent) {
    if (!onOpen) return;
    e.preventDefault();
    onOpen();
  }

  return (
    <div
      className={`account-card ${isUsing ? "selected" : account.status} ${onOpen ? "right-clickable" : ""}`}
      onContextMenu={handleContextMenu}
    >
      <div className="avatar">{(account.email || "?").charAt(0).toUpperCase()}</div>
      <div className="account-info">
        <div className="email">{account.email}</div>
        <div className="meta">
          {[account.chatgptPlanType?.toUpperCase(), `${account.requestCount || 0} req`, timeAgo(account.lastUsed, now)]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <AccountUsage account={account} now={now} />
      </div>
      <AccountActions account={account} isUsing={isUsing} />
    </div>
  );
}
