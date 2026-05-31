import { useAction } from "@livequery/react";
import { lastValueFrom } from "rxjs";
import { livequeryClient } from "./livequery-client";

/**
 * Hook chuẩn để gọi MỌI action của LiveQuery.
 *
 * Bọc `useAction` (quản lý `loading` / `error`) quanh `livequeryClient.trigger`,
 * nên RestTransporter tự build URL `/<ref>/~<action>` + gắn header bind socket.
 * KHÔNG dùng `fetch` thô cho action ở component nữa — luôn đi qua hook này.
 *
 *   const trigger = useTrigger();
 *   await trigger(`accounts/${accountId}/hosts/${hostId}`, "workspace-options");
 *   await trigger(`accounts/${accountId}/chats/${chatId}`, "send-message", { input });
 *
 * `ref` là phần trước `/~action` (đúng các route action của backend):
 *   - `accounts`                              → action cấp collection (start-login, set-config…)
 *   - `accounts/:id`                          → action cấp account (select-account, rc-enroll-start…)
 *   - `accounts/:id/hosts/:hostId`            → action cấp host (workspace-options, create-chat…)
 *   - `accounts/:id/chats/:chatId`            → action cấp chat (send-message, cancel-chat…)
 */
export function useTrigger() {
  return useAction(
    <T = unknown>(ref: string, action: string, payload?: Record<string, unknown>): Promise<T> =>
      lastValueFrom(livequeryClient.trigger<T>({ ref, action, payload }))
  );
}
