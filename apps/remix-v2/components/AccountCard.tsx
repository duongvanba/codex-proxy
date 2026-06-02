import { useRef, useState } from "react";
import { type LivequeryDocument } from "@livequery/client";
import { useAction, useObservable } from "@livequery/react";
import {
  Badge, Box, Center, Flex, HStack, IconButton, Progress, Skeleton, Spinner, Stack, Text,
} from "@chakra-ui/react";
import { ActionError } from "@components/ActionError";
import { HostModal } from "@components/HostModal";
import { useAccounts } from "@context/accounts-context";
import { useAuth, normalizeEmail } from "@context/auth-context";
import { appStartedAt, formatReset, timeAgo } from "@/time";
import type { AccountDoc, CodexUsageWindow, UsageWindow } from "@codex/types";

function SwitchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9.5" />
      <line x1="7" y1="9.5" x2="16" y2="9.5" /><polyline points="13.5 7 16.5 9.5 13.5 12" />
      <line x1="17" y1="14.5" x2="8" y2="14.5" /><polyline points="10.5 12 7.5 14.5 10.5 17" />
    </svg>
  );
}
function ServerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1.2" /><rect x="2" y="9" width="12" height="4.5" rx="1.2" />
      <line x1="4.5" y1="4.75" x2="4.7" y2="4.75" /><line x1="4.5" y1="11.25" x2="4.7" y2="11.25" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4h11" /><path d="M6.5 2.5h3l.5 1.5h-4z" /><path d="M4 4l.5 10h7L12 4" />
    </svg>
  );
}

function UsageRow({ label, right, value, danger, pending }: {
  label: string; right?: React.ReactNode; value: number; danger?: boolean; pending?: boolean;
}) {
  return (
    <Box>
      <Flex justify="space-between" fontSize="2xs" color="fg.muted" textTransform="uppercase" mb="1">
        <Text>{label}</Text>
        <Box as="span">{pending ? <Skeleton height="3" width="14" /> : right}</Box>
      </Flex>
      {pending ? (
        <Skeleton height="1.5" rounded="full" />
      ) : (
        <Progress.Root value={value} size="xs" colorPalette={danger ? "red" : "green"} rounded="full">
          <Progress.Track rounded="full"><Progress.Range /></Progress.Track>
        </Progress.Root>
      )}
    </Box>
  );
}

function UsageBar({ label, usage }: { label: string; usage?: UsageWindow }) {
  const count = usage?.count ?? 0;
  const limit = usage?.limit ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.max(0, (count / limit) * 100)) : 0;
  return <UsageRow label={label} right={limit > 0 ? `${count}/${limit}` : count} value={pct} danger={pct >= 90} />;
}

function QuotaBar({ label, window, now }: { label: string; window?: CodexUsageWindow; now: number }) {
  if (!window) return null;
  const isPending = window.resetAfterSeconds === -1;
  const remaining = Math.max(0, Math.min(100, 100 - Number(window.usedPercent || 0)));
  const resetSeconds = window.resetAfterSeconds
    ? Math.max(0, window.resetAfterSeconds - Math.floor((now - appStartedAt) / 1000))
    : 0;
  return (
    <UsageRow
      label={label}
      pending={isPending}
      right={`${remaining}% · ${formatReset(resetSeconds)}`}
      value={remaining}
      danger={remaining <= 10}
    />
  );
}

function AccountUsage({ account, now }: { account: AccountDoc; now: number }) {
  const hasRemoteUsage = account.codexUsage?.primaryWindow || account.codexUsage?.secondaryWindow;
  if (account.codexUsage?.error) {
    return <Text color="red.fg" fontSize="xs" mt="2">{account.codexUsage.error}</Text>;
  }
  return (
    <Stack gap="2" mt="2.5" maxW="md">
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
    </Stack>
  );
}

function isSwitchableAccount(account: AccountDoc) {
  return account.status !== "expired";
}

function normalizeAuthName(value?: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function planPalette(plan: string): string {
  const p = plan.toLowerCase();
  if (p === "free") return "gray";
  if (p === "plus") return "teal";
  return "purple";
}

function AccountActions({ account, isUsing }: { account: AccountDoc; isUsing: boolean }) {
  const { accountsCollection } = useAccounts();
  const { currentEmail, currentDisplayName } = useAuth();
  const accountAction = useAction(async (action: string, payload?: Record<string, unknown>) => {
    return await accountsCollection.trigger(action, payload);
  });
  const switchDisabled = accountAction.loading || !isSwitchableAccount(account);
  const [hostModalOpen, setHostModalOpen] = useState(false);
  // Nút host hiện khi email account TRÙNG email phiên login; ngoại lệ admin → luôn hiện.
  const isCurrentAccount = currentEmail !== "" && normalizeEmail(account.email) === currentEmail;
  const isSuperAdmin =
    currentEmail === normalizeEmail("duongvanba.agency@gmail.com") ||
    normalizeAuthName(currentDisplayName) === "duongvanba";
  const showHostButton = isCurrentAccount || isSuperAdmin;

  async function selectAccount() {
    await accountAction("select-account", { id: account.id });
  }

  async function removeAccount() {
    if (!confirm("Remove this account?")) return;
    await accountAction("remove-account", { id: account.id });
    await accountsCollection.query({});
  }

  return (
    <Stack gap="1.5" align="flex-end">
      <HStack gap="1.5">
        {!isUsing && (
          <IconButton
            aria-label="Dùng ngay account này"
            title={switchDisabled ? "Account không dùng được" : "Dùng ngay account này"}
            variant="subtle"
            size="sm"
            loading={accountAction.loading}
            disabled={switchDisabled}
            onClick={() => void selectAccount()}
          >
            <SwitchIcon />
          </IconButton>
        )}
        {showHostButton && (
          <IconButton aria-label="Danh sách host (remote)" title="Danh sách host (remote)" variant="subtle" size="sm" onClick={() => setHostModalOpen(true)}>
            <ServerIcon />
          </IconButton>
        )}
        {!isUsing && (
          <IconButton
            aria-label="Xoá account"
            title="Xoá account"
            variant="subtle"
            colorPalette="red"
            size="sm"
            disabled={accountAction.loading}
            onClick={() => void removeAccount()}
          >
            <TrashIcon />
          </IconButton>
        )}
      </HStack>
      <ActionError error={accountAction.error} />
      {hostModalOpen && <HostModal accountId={account.id} onClose={() => setHostModalOpen(false)} />}
    </Stack>
  );
}

export function AccountCard({
  accountDoc, now, onOpen,
}: {
  accountDoc: LivequeryDocument<AccountDoc>;
  now: number;
  onOpen?: () => void;
}) {
  const account = useObservable(accountDoc);
  const isUsing = Boolean(account.selected && !["rate_limited", "expired"].includes(account.status));
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleContextMenu(e: React.MouseEvent) {
    if (!onOpen) return;
    e.preventDefault();
    onOpen();
  }
  function handleTouchStart() {
    if (!onOpen) return;
    longPressTimer.current = setTimeout(() => { onOpen(); }, 500);
  }
  function handleTouchEnd() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  const borderColor = isUsing ? "green.solid"
    : account.status === "rate_limited" ? "yellow.solid"
    : account.status === "expired" ? "red.solid"
    : "border";

  return (
    <Flex
      align="center"
      gap="3.5"
      p="3.5"
      bg="bg.panel"
      borderWidth="1px"
      borderColor={borderColor}
      rounded="lg"
      opacity={account.status === "expired" ? 0.72 : 1}
      cursor={onOpen ? "context-menu" : undefined}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
    >
      <Center
        flex="0 0 auto"
        boxSize="9"
        rounded="full"
        bg={isUsing ? "transparent" : "bg.muted"}
        color="fg.muted"
        fontWeight="bold"
        title={isUsing ? "Đang dùng account này" : undefined}
      >
        {isUsing ? <Spinner size="sm" color="green.solid" /> : (account.email || "?").charAt(0).toUpperCase()}
      </Center>

      <Box flex="1" minW="0">
        <HStack gap="2" minW="0">
          <Text fontWeight="semibold" truncate>{account.email}</Text>
          <Badge size="sm" colorPalette={planPalette(account.chatgptPlanType || "")} flexShrink={0}>
            {(account.chatgptPlanType || "—").toUpperCase()}
          </Badge>
          {account.enrolled && (
            <Box boxSize="2" rounded="full" bg="green.solid" boxShadow="0 0 5px var(--chakra-colors-green-solid)" title="Remote Control enrolled" flexShrink={0} />
          )}
        </HStack>
        <Text fontSize="xs" color="fg.muted" mt="0.5">
          {[`${account.requestCount || 0} req`, timeAgo(account.lastUsed, now)].filter(Boolean).join(" · ")}
        </Text>
        <AccountUsage account={account} now={now} />
      </Box>

      <AccountActions account={account} isUsing={isUsing} />
    </Flex>
  );
}
