import { useRef } from "react";
import { type LivequeryDocument } from "@livequery/client";
import { useAction, useObservable } from "@livequery/react";
import {
  Badge, Box, Center, Flex, HStack, IconButton, Menu, Portal, Progress, SimpleGrid, Skeleton, Spinner, Text,
} from "@chakra-ui/react";
import { ActionError } from "@components/ActionError";
import { useAccounts } from "@context/accounts-context";
import { appStartedAt, formatReset, formatSubscriptionExpiry, timeAgo } from "@/time";
import type { AccountDoc, CodexUsageWindow, UsageWindow } from "@codex/types";

// ─── Icons ────────────────────────────────────────────────────────────────────

function SwitchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9.5" />
      <line x1="7" y1="9.5" x2="16" y2="9.5" /><polyline points="13.5 7 16.5 9.5 13.5 12" />
      <line x1="17" y1="14.5" x2="8" y2="14.5" /><polyline points="10.5 12 7.5 14.5 10.5 17" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4h11" /><path d="M6.5 2.5h3l.5 1.5h-4z" /><path d="M4 4l.5 10h7L12 4" />
    </svg>
  );
}
function ResetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden>
      <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}

// ─── Usage bars ───────────────────────────────────────────────────────────────

function UsageRow({ label, right, value, danger, pending }: {
  label: string; right?: React.ReactNode; value: number; danger?: boolean; pending?: boolean;
}) {
  return (
    <Box minW="0" w="full">
      <Flex justify="space-between" fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide" mb="1">
        <Text fontWeight="medium">{label}</Text>
        <Box as="span" display={{ base: "none", sm: "block" }}>
          {pending ? <Skeleton height="2.5" width="10" rounded="sm" /> : right}
        </Box>
      </Flex>
      {pending ? (
        <Skeleton height="1" rounded="full" />
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
  const resetCount = account.codexUsage?.rateLimitResetCount;
  const expiresAt = account.codexUsage?.subscriptionExpiresAt;

  if (account.codexUsage?.error) {
    return <Text color="red.fg" fontSize="xs" mt="1.5">{account.codexUsage.error}</Text>;
  }

  const expiryLabel = formatSubscriptionExpiry(expiresAt, now);
  const isExpiring = expiresAt && (expiresAt - now) < 7 * 86_400_000;

  return (
    <Box mt="2" overflow="hidden" minW="0">
      <SimpleGrid columns={2} gap="2">
        {hasRemoteUsage ? (
          <>
            <QuotaBar label="Ngày" window={account.codexUsage?.primaryWindow} now={now} />
            <QuotaBar label="Tuần" window={account.codexUsage?.secondaryWindow} now={now} />
          </>
        ) : (
          <>
            <UsageBar label="Ngày" usage={account.dailyUsage} />
            <UsageBar label="Tuần" usage={account.weeklyUsage} />
          </>
        )}
      </SimpleGrid>
      {expiryLabel && (
        <Text fontSize="2xs" color={isExpiring ? "orange.fg" : "fg.subtle"} textTransform="uppercase" letterSpacing="wide" mt="1.5">
          {expiryLabel}
        </Text>
      )}
    </Box>
  );
}

// ─── Actions (3-dot Menu) ──────────────────────────────────────────────────────

function isSwitchableAccount(account: AccountDoc) {
  return account.status !== "expired";
}

function AccountActions({ account, isUsing }: { account: AccountDoc; isUsing: boolean }) {
  const { accountsCollection } = useAccounts();
  const accountAction = useAction(async (action: string, payload?: Record<string, unknown>) => {
    return await accountsCollection.trigger(action, payload);
  });
  const switchDisabled = !isSwitchableAccount(account);
  const resetCount = account.codexUsage?.rateLimitResetCount ?? 0;

  async function selectAccount() {
    await accountAction("select-account", { id: account.id });
  }
  async function removeAccount() {
    if (!confirm("Xoá account này?")) return;
    await accountAction("remove-account", { id: account.id });
    await accountsCollection.query({});
  }
  async function resetRateLimit() {
    if (!confirm(`Reset hạn mức cho ${account.email}?\nBạn còn ${resetCount} lượt reset. Thao tác không thể hoàn tác.`)) return;
    await accountAction("reset-rate-limit", { id: account.id });
  }

  const hasSwitch = !isUsing && !switchDisabled;
  const hasReset = resetCount > 0;
  const hasRemove = !isUsing;
  if (!hasSwitch && !hasReset && !hasRemove) return null;

  return (
    <Box flexShrink={0}>
      <Menu.Root>
        <Menu.Trigger asChild>
          <IconButton
            aria-label="Tùy chọn"
            variant="ghost"
            size="sm"
            loading={accountAction.loading}
          >
            <DotsIcon />
          </IconButton>
        </Menu.Trigger>
        <Portal>
        <Menu.Positioner>
          <Menu.Content minW="44">
            {hasSwitch && (
              <Menu.Item value="switch" onClick={() => void selectAccount()}>
                <HStack gap="2"><SwitchIcon /> Dùng account này</HStack>
              </Menu.Item>
            )}
            {hasReset && (
              <Menu.Item value="reset" color="blue.fg" onClick={() => void resetRateLimit()}>
                <HStack gap="2"><ResetIcon /> Reset hạn mức ({resetCount})</HStack>
              </Menu.Item>
            )}
            {hasRemove && (
              <Menu.Item value="remove" color="red.fg" onClick={() => void removeAccount()}>
                <HStack gap="2"><TrashIcon /> Xoá account</HStack>
              </Menu.Item>
            )}
          </Menu.Content>
        </Menu.Positioner>
        </Portal>
      </Menu.Root>
      <ActionError error={accountAction.error} />
    </Box>
  );
}

// ─── Plan badge palette ───────────────────────────────────────────────────────

function planPalette(plan: string): string {
  const p = plan.toLowerCase();
  if (p === "free") return "gray";
  if (p === "plus") return "teal";
  return "purple";
}

// ─── AccountCard ──────────────────────────────────────────────────────────────

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

  const accentColor = isUsing ? "var(--chakra-colors-green-solid)"
    : account.status === "rate_limited" ? "var(--chakra-colors-yellow-solid)"
    : account.status === "expired" ? "var(--chakra-colors-red-solid)"
    : "transparent";

  return (
    <Box
      bg={isUsing ? "linear-gradient(135deg, #0a1f10 0%, #0f2d18 100%)" : "bg.panel"}
      borderWidth="1px"
      borderColor={isUsing ? "green.subtle" : "border"}
      rounded="xl"
      overflow="hidden"
      position="relative"
      shadow={isUsing ? "sm" : "xs"}
      opacity={account.status === "expired" ? 0.65 : 1}
      cursor={onOpen ? "context-menu" : undefined}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchEnd}
      _hover={{ borderColor: isUsing ? "green.subtle" : "border.emphasized" }}
      transition="border-color 0.15s"
    >
      {/* Left accent strip */}
      <Box
        position="absolute"
        left="0"
        top="0"
        bottom="0"
        w="3px"
        bg={accentColor}
      />

      <Flex align="center" gap="3" p="3" pl="4">
        {/* Avatar / Status */}
        <Center
          flex="0 0 auto"
          boxSize="8"
          rounded="full"
          bg={isUsing ? "green.subtle" : "bg.muted"}
          color={isUsing ? "green.fg" : "fg.muted"}
          fontSize="xs"
          fontWeight="bold"
          title={isUsing ? "Đang dùng account này" : undefined}
        >
          {isUsing ? <Spinner size="xs" color="green.solid" /> : (account.email || "?").charAt(0).toUpperCase()}
        </Center>

        {/* Main content */}
        <Box flex="1" minW="0">
          <HStack gap="1.5" minW="0" mb="0.5" overflow="hidden">
            <Text fontWeight="semibold" fontSize="sm" truncate lineHeight="short" flex="1" minW="0">{account.email}</Text>
            <Badge
              size="sm"
              colorPalette={planPalette(account.chatgptPlanType || "")}
              variant="subtle"
              flexShrink={0}
            >
              {(account.chatgptPlanType || "—").toUpperCase()}
            </Badge>
            {(account.codexUsage?.rateLimitResetCount ?? 0) > 0 && (
              <Badge size="sm" colorPalette="blue" variant="subtle" flexShrink={0}>
                {account.codexUsage!.rateLimitResetCount} reset
              </Badge>
            )}
            {account.enrolled && (
              <Box
                boxSize="1.5"
                rounded="full"
                bg="green.solid"
                boxShadow="0 0 4px var(--chakra-colors-green-solid)"
                title="Remote Control enrolled"
                flexShrink={0}
              />
            )}
          </HStack>
          <Text fontSize="2xs" color="fg.subtle">
            {[`${account.requestCount || 0} req`, timeAgo(account.lastUsed, now)].filter(Boolean).join(" · ")}
          </Text>
          <AccountUsage account={account} now={now} />
        </Box>

        {/* Actions */}
        <AccountActions account={account} isUsing={isUsing} />
      </Flex>
    </Box>
  );
}
