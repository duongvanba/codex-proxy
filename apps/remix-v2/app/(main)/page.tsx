import { type LivequeryDocument, type LivequeryLoadingState } from "@livequery/client";
import { BehaviorSubject } from "rxjs";
import { useAction, useCollection, useObservable } from "@livequery/react";
import { useEffect, useState } from "react";
import {
  Badge, Box, Button, Container, Flex, Heading, HStack, NativeSelectField, NativeSelectIndicator, NativeSelectRoot, Spinner, Stack, Text,
} from "@chakra-ui/react";
import type { AccountDoc } from "@codex/types";
import { AccountCard } from "@components/AccountCard";
import { ReportsPanel } from "@components/ReportsPanel";
import { ThemeToggle } from "@components/ThemeToggle";
import { useAccounts, useAccountSnapshots } from "@context/accounts-context";
import { useTrigger } from "@helpers/use-trigger";
import type { ReportDoc } from "@codex/types";

// ─── Sort ─────────────────────────────────────────────────────────────────────

type SortKey = "" | "daily:desc" | "daily:asc" | "weekly:desc" | "weekly:asc" | "reset:asc" | "reset:desc";

function sortValue(doc: LivequeryDocument<AccountDoc>, key: SortKey): number {
  const a = doc.getValue();
  const u = a.codexUsage;
  if (key === "daily:asc" || key === "daily:desc") {
    if (u?.primaryWindow) return 100 - (u.primaryWindow.usedPercent ?? 0);
    const d = a.dailyUsage;
    return d && d.limit > 0 ? ((d.limit - d.count) / d.limit) * 100 : 0;
  }
  if (key === "weekly:asc" || key === "weekly:desc") {
    if (u?.secondaryWindow) return 100 - (u.secondaryWindow.usedPercent ?? 0);
    const w = a.weeklyUsage;
    return w && w.limit > 0 ? ((w.limit - w.count) / w.limit) * 100 : 0;
  }
  if (key === "reset:asc" || key === "reset:desc") {
    return u?.secondaryWindow?.resetAfterSeconds ?? u?.primaryWindow?.resetAfterSeconds ?? 0;
  }
  return 0;
}

function applySortKey(docs: LivequeryDocument<AccountDoc>[], key: SortKey): LivequeryDocument<AccountDoc>[] {
  if (!key) return docs;
  const dir = key.endsWith(":asc") ? 1 : -1;
  return [...docs].sort((a, b) => (sortValue(a, key) - sortValue(b, key)) * dir);
}


function LinkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
function ImportIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function GaugeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 18a9 9 0 1 1 17 0" />
      <line x1="12" y1="14" x2="16" y2="9.5" />
    </svg>
  );
}

function AccountListEmpty({ loading$ }: { loading$: BehaviorSubject<LivequeryLoadingState | null> }) {
  const loading = useObservable(loading$);
  return (
    <Flex align="center" gap="2" color="fg.muted" fontSize="sm" py="4" justify="center">
      {loading ? <><Spinner size="sm" /> Đang tải danh sách...</> : "Chưa có account nào."}
    </Flex>
  );
}

export default function Page() {
  const { accountsCollection, accountDocs, accountError } = useAccounts();
  const reportsCollection = useCollection<ReportDoc>("reports", { mode: "server-first", filters: { ":limit": 200 } });
  const reportDocs = useObservable(reportsCollection.items, []);
  const reportError = useObservable(reportsCollection.error, null);
  const checkQuota = useAction(() => accountsCollection.trigger("fetch-quota"));

  const trigger = useTrigger();
  const [now, setNow] = useState(Date.now());
  const [accountBusy, setAccountBusy] = useState<null | "login" | "import">(null);
  const [accountNotice, setAccountNotice] = useState<{ type: "info" | "error"; message: string } | null>(null);
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem("codex:sort") as SortKey) || "");

  async function copyLoginUrl() {
    setAccountNotice(null);
    setAccountBusy("login");
    try {
      const res = await trigger<{ ok: boolean; authorize_url?: string }>("accounts", "start-login");
      const url = res?.authorize_url;
      if (!url) throw new Error("Server không trả về login URL.");
      try {
        await navigator.clipboard.writeText(url);
        setAccountNotice({ type: "info", message: "Đã copy login URL. Mở để đăng nhập, xong dùng Import session để dán callback." });
      } catch {
        window.prompt("Copy login URL này:", url);
      }
    } catch (e) {
      setAccountNotice({ type: "error", message: e instanceof Error ? e.message : "Không khởi tạo được phiên login." });
    } finally {
      setAccountBusy(null);
    }
  }

  async function importLoginSession() {
    const input = window.prompt("Dán callback URL của OpenAI hoặc account JSON (JWT)");
    if (!input?.trim()) return;
    setAccountNotice(null);
    setAccountBusy("import");
    try {
      const res = await trigger<{ ok: boolean; email?: string }>("accounts", "import-callback", { import_input: input.trim() });
      setAccountNotice({ type: "info", message: `Đã thêm account${res?.email ? `: ${res.email}` : ""}.` });
    } catch (e) {
      setAccountNotice({ type: "error", message: e instanceof Error ? e.message : "Import session thất bại." });
    } finally {
      setAccountBusy(null);
    }
  }

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const accounts = applySortKey(accountDocs, sort);
  const reports = reportDocs as LivequeryDocument<ReportDoc>[];
  const accountSnapshots = useAccountSnapshots();

  return (
    <Box
      minH="100dvh"
      bg="var(--app-page-gradient)"
    >
      <Container maxW="6xl" py="6">
      <Flex as="header" align="center" gap="3" wrap="wrap" mb="2">
        <Heading size="lg">Codex Proxy</Heading>
        <HStack gap="2" ml="auto">
          <ThemeToggle />
        </HStack>
      </Flex>

      <Flex justify="center" gap="2" mt="4" wrap="wrap">
        <Button variant="subtle" size="sm" loading={accountBusy === "login"} disabled={accountBusy !== null} onClick={() => void copyLoginUrl()} title="Khởi tạo phiên đăng nhập & copy login URL">
          <LinkIcon /> Copy URL đăng nhập
        </Button>
        <Button variant="subtle" size="sm" loading={accountBusy === "import"} disabled={accountBusy !== null} onClick={() => void importLoginSession()} title="Dán callback URL hoặc account JSON để thêm account">
          <ImportIcon /> Nhập phiên
        </Button>
        <Button variant="subtle" size="sm" loading={checkQuota.loading} onClick={() => void checkQuota()} title="Kiểm tra quota toàn bộ account">
          <GaugeIcon /> Kiểm tra quota
        </Button>
      </Flex>

      <Box
        display="grid"
        gridTemplateColumns={{ base: "1fr", lg: "3fr 2fr" }}
        gap="6"
        mt="6"
        alignItems="start"
      >
        {/* Cột trái: accounts */}
        <Box as="section">
          <Flex align="center" justify="space-between" mb="2" h="8">
            <Heading size="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider">Accounts ({accounts.length})</Heading>
            <NativeSelectRoot size="xs" variant="subtle" w="auto">
              <NativeSelectField
                value={sort}
                onChange={(e) => { const v = e.target.value as SortKey; setSort(v); localStorage.setItem("codex:sort", v); }}
                color="fg.muted"
                fontSize="2xs"
                pr="6"
              >
                <option value="">Sắp xếp: mặc định</option>
                <optgroup label="Còn lại hằng ngày">
                  <option value="daily:desc">Daily ↓ nhiều nhất</option>
                  <option value="daily:asc">Daily ↑ ít nhất</option>
                </optgroup>
                <optgroup label="Còn lại hằng tuần">
                  <option value="weekly:desc">Weekly ↓ nhiều nhất</option>
                  <option value="weekly:asc">Weekly ↑ ít nhất</option>
                </optgroup>
                <optgroup label="Thời gian reset">
                  <option value="reset:asc">Reset ↑ sớm nhất</option>
                  <option value="reset:desc">Reset ↓ muộn nhất</option>
                </optgroup>
              </NativeSelectField>
              <NativeSelectIndicator />
            </NativeSelectRoot>
          </Flex>
          {accountNotice && (
            <Box
              rounded="md" px="3" py="2" fontSize="sm" mb="3"
              bg={accountNotice.type === "error" ? "red.subtle" : "bg.muted"}
              color={accountNotice.type === "error" ? "red.fg" : "fg.muted"}
            >
              {accountNotice.message}
            </Box>
          )}

          <Stack gap="2">
            {accounts.length === 0
              ? <AccountListEmpty loading$={accountsCollection.loading} />
              : accounts.map((accountDoc) => (
                <AccountCard key={accountDoc.getValue().id} accountDoc={accountDoc} now={now} />
              ))}
          </Stack>
        </Box>

        {/* Cột phải: nhật ký */}
        <Box position={{ lg: "sticky" }} top={{ lg: "6" }}>
          <ReportsPanel reports={reports} reportsLoading$={reportsCollection.loading} />
        </Box>
      </Box>
      </Container>
    </Box>
  );
}
