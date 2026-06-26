import { useEffect, useState } from "react";
import { useNavigate } from "@remix-run/react";
import { useAction, useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import {
  Badge, Box, Button, CloseButton, Dialog, Flex, HStack, IconButton, Portal, Spinner, Stack, Text,
} from "@chakra-ui/react";
import { LuRotateCw } from "react-icons/lu";
import type { AccountDoc, HostDoc } from "@codex/types";
import { useAccounts } from "@context/accounts-context";

function HostRow({ doc, onOpen }: { doc: LivequeryDocument<HostDoc>; onOpen: () => void }) {
  const host = useObservable(doc);
  const dot = !host.online ? "gray.solid" : host.busy ? "yellow.solid" : "green.solid";
  const badge = !host.online ? { c: "gray", t: "Offline" } : host.busy ? { c: "yellow", t: "Busy" } : { c: "green", t: "Ready" };
  return (
    <Flex
      align="center"
      gap="3"
      p="3.5"
      rounded="md"
      borderWidth="1px"
      borderColor="border"
      cursor="pointer"
      transition="background 0.15s"
      _hover={{ bg: "bg.muted" }}
      onClick={onOpen}
      opacity={host.online ? 1 : 0.7}
    >
      <Box boxSize="2.5" rounded="full" bg={dot} flexShrink={0} />
      <Box flex="1" minW="0">
        <Text fontWeight="medium" truncate>{host.display_name || host.host_name}</Text>
        {host.display_name && host.host_name !== host.display_name && (
          <Text fontSize="xs" color="fg.muted" truncate>{host.host_name}</Text>
        )}
      </Box>
      <Badge colorPalette={badge.c} size="sm" flexShrink={0}>{badge.t}</Badge>
    </Flex>
  );
}

/** Modal chọn host của một account. Chưa enroll → Enroll. Đã enroll → danh sách host. */
export function HostModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { accountsCollection, accountDocs, accountsLoading } = useAccounts();
  const accountDoc = accountDocs.find((d) => d.getValue().id === accountId);
  const account = useObservable(accountDoc as any, undefined as any) as AccountDoc | undefined;
  const enrollStatus = account?.enrollStatus ?? (account?.enrolled ? "ready" : "none");
  const enrolled = enrollStatus === "ready";
  const enrolling = enrollStatus === "enrolling";
  const resolving = account === undefined && !!accountsLoading;

  const hostsCollection = useCollection<HostDoc>(`accounts/${accountId}/hosts`, { mode: "server-first", filters: {} });
  const hostDocs = useObservable(hostsCollection.items, []) as LivequeryDocument<HostDoc>[];
  const hostsLoading = useObservable(hostsCollection.loading, null);

  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const callAction = useAction(async <T,>(action: string, payload?: Record<string, unknown>): Promise<T> =>
    await accountsCollection.trigger<T>(action, payload) as T);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "enroll-success") accountsCollection.query({}).catch(() => {});
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [accountsCollection]);

  // An toàn: khi chọn host, modal đóng (onClose) ĐỒNG THỜI điều hướng → Dialog bị unmount giữa lúc
  // còn mở, Ark/Chakra có thể để sót pointer-events:none + data-scroll-lock/inert trên <body> →
  // khoá click toàn trang đích. Dọn dẹp khi unmount để trang sau luôn bấm được.
  useEffect(() => () => {
    document.body.style.pointerEvents = "";
    document.body.removeAttribute("data-scroll-lock");
    document.body.removeAttribute("data-inert");
  }, []);

  async function handleEnroll() {
    setError(null);
    try {
      const res = await callAction<{ enrollUrl: string }>("rc-enroll-start", { account_id: accountId });
      if (res?.enrollUrl) window.open(res.enrollUrl, "_blank", "width=600,height=700");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRevoke() {
    if (cancelling) return;
    if (!confirm("Remove remote control enrollment?")) return;
    setError(null);
    setCancelling(true);
    try {
      await accountsCollection.trigger("rc-enroll-delete", { account_id: accountId });
      await accountsCollection.query({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }

  async function importEnrollCallback() {
    const callback_url = prompt("Dán callback URL của Remote Control (sau khi đăng nhập cấp quyền)");
    if (!callback_url) return;
    setError(null);
    try {
      await callAction("rc-enroll-callback", { account_id: accountId, callback_url });
      await accountsCollection.query({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import enroll callback thất bại");
    }
  }

  const refresh = () => accountsCollection.query({}).catch(() => {});

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center" size="md">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Chọn host{account?.email ? ` · ${account.email}` : ""}</Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" onClick={onClose} />
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body>
              <Stack gap="5" pb="2">
                {resolving ? (
                  <Flex justify="center" py="6"><Spinner /></Flex>
                ) : enrolling ? (
                  <Stack gap="4">
                    <HStack gap="3" wrap="wrap">
                      <Spinner size="sm" />
                      <Text fontSize="sm" fontWeight="medium" mr="auto">Remote Control: đang enroll…</Text>
                      <IconButton aria-label="Kiểm tra lại" title="Kiểm tra lại" variant="subtle" size="xs" onClick={refresh}>
                        <LuRotateCw />
                      </IconButton>
                      <Button variant="subtle" size="xs" disabled={callAction.loading} onClick={() => void importEnrollCallback()}>
                        Import
                      </Button>
                      <Button variant="outline" colorPalette="red" size="xs" disabled={cancelling} onClick={() => void handleRevoke()}>
                        {cancelling ? "Đang huỷ…" : "Huỷ"}
                      </Button>
                    </HStack>
                    <Text fontSize="sm" color="fg.muted">
                      Hoàn tất đăng nhập ở tab vừa mở. Trạng thái sẽ tự chuyển sang “connected” khi server xác nhận.
                    </Text>
                  </Stack>
                ) : !enrolled ? (
                  <Stack gap="4">
                    <HStack gap="2.5">
                      <Box boxSize="2.5" rounded="full" bg="fg.muted" />
                      <Text fontSize="sm" fontWeight="medium">Remote Control: not enrolled</Text>
                    </HStack>
                    <Button colorPalette="blue" loading={callAction.loading} onClick={() => void handleEnroll()}>
                      Enroll Remote Control
                    </Button>
                  </Stack>
                ) : (
                  <Stack gap="5">
                    <HStack gap="3" wrap="wrap">
                      <Box boxSize="2.5" rounded="full" bg="green.solid" boxShadow="0 0 5px var(--chakra-colors-green-solid)" />
                      <Text fontSize="sm" fontWeight="medium" mr="auto">Remote Control: connected</Text>
                      <IconButton aria-label="Refresh status" title="Refresh status" variant="subtle" size="xs" onClick={refresh}>
                        <LuRotateCw />
                      </IconButton>
                      <Button variant="outline" colorPalette="red" size="xs" disabled={cancelling} onClick={() => void handleRevoke()}>
                        {cancelling ? "Đang huỷ…" : "Revoke"}
                      </Button>
                    </HStack>
                    <Stack gap="2.5">
                      {hostsLoading && hostDocs.length === 0 && (
                        <Flex justify="center" py="4"><Spinner size="sm" /></Flex>
                      )}
                      {!hostsLoading && hostDocs.length === 0 && (
                        <Text color="fg.muted" fontSize="sm" textAlign="center" py="2">No hosts online for this account.</Text>
                      )}
                      {hostDocs.map((doc) => (
                        <HostRow
                          key={doc.getValue().env_id}
                          doc={doc}
                          onOpen={() => { onClose(); navigate(`/accounts/${accountId}/hosts/${doc.getValue().env_id}`); }}
                        />
                      ))}
                    </Stack>
                  </Stack>
                )}

                {error && <Text fontSize="sm" color="red.fg">{error}</Text>}
              </Stack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
