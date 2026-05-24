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

export function formatReset(seconds?: number) {
  if (!Number.isFinite(seconds) || !seconds) return "00:00:00";
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}
