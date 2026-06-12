export const appStartedAt = Date.now();

export function timeAgo(ms?: number, now = Date.now()) {
  if (!ms) return "never used";
  const diff = ms > now ? ms - now : now - ms;
  const suffix = ms > now ? "from now" : "ago";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ${suffix}`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${suffix}`;
  return `${Math.floor(s / 3600)}h ${suffix}`;
}

export function formatSubscriptionExpiry(expiresAtMs?: number, now = Date.now()): string | null {
  if (!expiresAtMs) return null;
  const diffMs = expiresAtMs - now;
  if (diffMs <= 0) return null;
  const d = new Date(expiresAtMs);
  const dateStr = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  const countdown = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
  return `renews ${dateStr} (${countdown})`;
}

export function formatReset(seconds?: number) {
  if (!Number.isFinite(seconds) || !seconds) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
