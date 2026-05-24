import { type LivequeryDocument } from "@livequery/client";
import { useObservable } from "@livequery/react";
import type { ReportDoc } from "./types";

function reportClass(report: ReportDoc) {
  if (report.type === "account_switched") return "report accent";
  if (report.type?.startsWith("login_")) return report.error ? "report danger" : "report accent";
  if (report.status === 429) return "report warn";
  if ((report.status ?? 0) >= 400) return "report danger";
  return "report";
}

function ReportRow({ reportDoc }: { reportDoc: LivequeryDocument<ReportDoc> }) {
  const report = useObservable(reportDoc, reportDoc.value);
  const time = new Date(report.timestamp).toLocaleTimeString("en-US", { hour12: false });
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

export function ReportsPanel({
  reports,
  reportsLoading,
}: {
  reports: LivequeryDocument<ReportDoc>[];
  reportsLoading: unknown;
}) {
  const loading = Boolean(reportsLoading);
  return (
    <section>
      <h2>Reports {loading && <span className="section-loading"><span className="inline-spinner" /> loading</span>}</h2>
      <div className="reports">
        {reports.length === 0 && loading
          ? <div className="empty"><span className="inline-spinner" /> Loading reports...</div>
          : reports.length === 0
            ? <div className="empty">No reports yet.</div>
            : reports.slice(0, 200).map((reportDoc) => <ReportRow key={reportDoc.value.id} reportDoc={reportDoc} />)}
      </div>
    </section>
  );
}
