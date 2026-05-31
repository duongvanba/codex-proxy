export function StatsGrid({
  using, active, limited, totalRequests, accountCount,
}: {
  using: number; active: number; limited: number;
  totalRequests: number; accountCount: number;
}) {
  return (
    <section className="stats">
      <div><span>In use</span><strong>{using || active}</strong></div>
      <div><span>Rate limited</span><strong>{limited}</strong></div>
      <div><span>Total requests</span><strong>{totalRequests.toLocaleString()}</strong></div>
      <div><span>Total accounts</span><strong>{accountCount}</strong></div>
    </section>
  );
}
