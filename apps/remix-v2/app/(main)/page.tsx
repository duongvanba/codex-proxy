import { type LivequeryDocument, type LivequeryLoadingState } from "@livequery/client";
import { BehaviorSubject } from "rxjs";
import { useAction, useCollection, useObservable } from "@livequery/react";
import { useEffect, useState } from "react";
import {
  Badge, Box, Button, Container, Flex, Heading, HStack, IconButton, NativeSelectField, NativeSelectIndicator, NativeSelectRoot, Spinner, Stack, Text,
} from "@chakra-ui/react";
import type { AccountDoc } from "@codex/types";
import { AccountCard } from "@components/AccountCard";
import { ReportsPanel } from "@components/ReportsPanel";
import { StatsGrid } from "@components/StatsGrid";
import { ThemeToggle } from "@components/ThemeToggle";
import { useAccounts, useAccountSnapshots } from "@context/accounts-context";
import { useAuth } from "@context/auth-context";
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

function LogoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
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
      {loading ? <><Spinner size="sm" /> Loading accounts...</> : "No accounts yet."}
    </Flex>
  );
}

export default function Page() {
  const { accountsCollection, accountDocs, accountError } = useAccounts();
  const reportsCollection = useCollection<ReportDoc>("reports", { mode: "server-first", filters: { ":limit": 200 } });
  const reportDocs = useObservable(reportsCollection.items, []);
  const reportError = useObservable(reportsCollection.error, null);
  const { logout: authLogout, currentEmail, currentDisplayName } = useAuth();

  const checkQuota = useAction(() => accountsCollection.trigger("fetch-quota"));

  const trigger = useTrigger();
  const [now, setNow] = useState(Date.now());
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountBusy, setAccountBusy] = useState<null | "login" | "import">(null);
  const [accountNotice, setAccountNotice] = useState<{ type: "info" | "error"; message: string } | null>(null);
  const [sort, setSort] = useState<SortKey>("");

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

  async function logout() {
    if (!confirm("Đăng xuất khỏi phiên hiện tại?")) return;
    setLoggingOut(true);
    try {
      authLogout();
    } finally {
      setLoggingOut(false);
    }
  }

  const accounts = applySortKey(accountDocs, sort);
  const reports = reportDocs as LivequeryDocument<ReportDoc>[];
  const accountSnapshots = useAccountSnapshots();
  const active = accountSnapshots.filter((a) => a.status === "active").length;
  const using = accountSnapshots.filter((a) => a.selected && a.status === "active").length;
  const limited = accountSnapshots.filter((a) => a.status === "rate_limited").length;
  const totalRequests = accountSnapshots.reduce((sum, a) => sum + (a.requestCount || 0), 0);
  const degraded = Boolean(accountError || reportError);

  return (
    <Box
      minH="100dvh"
      bg="var(--app-page-gradient)"
    >
      <Container maxW="5xl" py="6">
      <Flex as="header" align="center" gap="3" wrap="wrap" mb="2">
        <Heading size="lg">Codex Proxy</Heading>
        <Badge
          colorPalette={degraded ? "red" : "green"}
          variant="surface"
          maxW={{ base: "55vw", md: "sm" }}
          title={currentDisplayName || currentEmail || undefined}
        >
          <Text truncate>{degraded ? "Degraded" : (currentDisplayName || currentEmail || "Online")}</Text>
        </Badge>
        <HStack gap="2" ml="auto">
          <ThemeToggle />
          <IconButton
            aria-label="Đăng xuất"
            title="Đăng xuất"
            colorPalette="red"
            variant="subtle"
            size="sm"
            loading={loggingOut}
            onClick={() => void logout()}
          >
            <LogoutIcon />
          </IconButton>
        </HStack>
      </Flex>

      <StatsGrid using={using} active={active} limited={limited} totalRequests={totalRequests} accountCount={accounts.length} />

      <Box as="section" mt="6">
        <Flex justify="space-between" align={{ base: "stretch", sm: "center" }} direction={{ base: "column", sm: "row" }} gap="2.5" mb="3">
          <HStack gap="3">
            <Heading size="xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider">Accounts</Heading>
            <NativeSelectRoot size="xs" variant="subtle" minW="36">
              <NativeSelectField
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                color="fg.muted"
                fontSize="2xs"
              >
                <option value="">Sort: default</option>
                <optgroup label="Daily remaining">
                  <option value="daily:desc">Daily ↓ most first</option>
                  <option value="daily:asc">Daily ↑ least first</option>
                </optgroup>
                <optgroup label="Weekly remaining">
                  <option value="weekly:desc">Weekly ↓ most first</option>
                  <option value="weekly:asc">Weekly ↑ least first</option>
                </optgroup>
                <optgroup label="Reset time">
                  <option value="reset:asc">Reset ↑ soonest</option>
                  <option value="reset:desc">Reset ↓ latest</option>
                </optgroup>
              </NativeSelectField>
              <NativeSelectIndicator />
            </NativeSelectRoot>
          </HStack>
          <HStack gap="2" wrap="wrap">
            <Button variant="subtle" size="sm" loading={accountBusy === "login"} disabled={accountBusy !== null} onClick={() => void copyLoginUrl()} title="Khởi tạo phiên đăng nhập & copy login URL">
              <LinkIcon /> Copy login URL
            </Button>
            <Button variant="subtle" size="sm" loading={accountBusy === "import"} disabled={accountBusy !== null} onClick={() => void importLoginSession()} title="Dán callback URL hoặc account JSON để thêm account">
              <ImportIcon /> Import session
            </Button>
            <Button variant="subtle" size="sm" loading={checkQuota.loading} onClick={() => void checkQuota()} title="Check quota toàn bộ account">
              <GaugeIcon /> Check quota
            </Button>
          </HStack>
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

        <Stack gap="3">
          {accounts.length === 0
            ? <AccountListEmpty loading$={accountsCollection.loading} />
            : accounts.map((accountDoc) => (
              <AccountCard key={accountDoc.getValue().id} accountDoc={accountDoc} now={now} />
            ))}
        </Stack>
      </Box>

      <ReportsPanel reports={reports} reportsLoading$={reportsCollection.loading} />
      </Container>
    </Box>
  );
}
