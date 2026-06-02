import { type LivequeryDocument, type LivequeryLoadingState } from "@livequery/client";
import { BehaviorSubject } from "rxjs";
import { useObservable } from "@livequery/react";
import { Box, Flex, Heading, HStack, Spinner, Text } from "@chakra-ui/react";
import type { ReportDoc } from "@codex/types";

/** Màu nhấn của một dòng report theo loại/trạng thái. */
function reportColor(report: ReportDoc): string {
  if (report.type === "account_switched") return "blue.fg";
  if (report.type?.startsWith("login_")) return report.error ? "red.fg" : "blue.fg";
  if (report.status === 429) return "yellow.fg";
  if ((report.status ?? 0) >= 400) return "red.fg";
  return "fg";
}

function ReportRow({ reportDoc }: { reportDoc: LivequeryDocument<ReportDoc> }) {
  const report = useObservable(reportDoc);
  const time = new Date(report.timestamp).toLocaleTimeString("en-US", { hour12: false });
  const title =
    report.type === "request"
      ? `${report.method ?? ""} ${report.path ?? ""}`
      : report.type.replace(/_/g, " ");
  const detail =
    report.type === "account_switched"
      ? `${report.from} -> ${report.to} [${report.reason}]`
      : report.email || report.error || report.errorSnippet || "";
  return (
    <HStack gap="2" fontFamily="mono" fontSize="xs" py="1" align="baseline" whiteSpace="nowrap">
      <Text color="fg.subtle" flexShrink={0}>{time}</Text>
      <Text color={reportColor(report)} fontWeight="medium">{title}</Text>
      {report.status != null && <Text color="fg.muted">{report.status}</Text>}
      {report.latencyMs != null && <Text color="fg.subtle">{report.latencyMs}ms</Text>}
      {detail && <Text color="fg.subtle" textOverflow="ellipsis" overflow="hidden">{detail}</Text>}
    </HStack>
  );
}

export function ReportsPanel({
  reports,
  reportsLoading$,
}: {
  reports: LivequeryDocument<ReportDoc>[];
  reportsLoading$: BehaviorSubject<LivequeryLoadingState | null>;
}) {
  const loading = Boolean(useObservable(reportsLoading$));
  return (
    <Box as="section" mt="6">
      <Heading
        size="xs"
        color="fg.muted"
        textTransform="uppercase"
        letterSpacing="wider"
        mb="2.5"
        display="flex"
        alignItems="center"
        gap="2"
      >
        Reports
        {loading && <Spinner size="xs" />}
      </Heading>
      <Box
        bg="bg.panel"
        borderWidth="1px"
        borderColor="border"
        rounded="lg"
        p="3"
        maxH="420px"
        overflow="auto"
      >
        {reports.length === 0 && loading ? (
          <Flex align="center" gap="2" color="fg.muted" fontSize="sm" py="2">
            <Spinner size="xs" /> Loading reports...
          </Flex>
        ) : reports.length === 0 ? (
          <Text color="fg.muted" fontSize="sm" py="2">No reports yet.</Text>
        ) : (
          reports.slice(0, 200).map((reportDoc) => (
            <ReportRow key={reportDoc.getValue().id} reportDoc={reportDoc} />
          ))
        )}
      </Box>
    </Box>
  );
}
