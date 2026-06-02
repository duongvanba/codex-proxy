import { createContextFromHook } from "@livequery/react";

type WorkspaceCtx = {
  pendingEnvId: string | null;
  setPendingEnvId: (id: string | null) => void;
  pendingCwd: string | null;
  setPendingCwd: (cwd: string | null) => void;
  onChatCreated: (chatId: string) => void;
  setChatScrolledUp: (scrolled: boolean) => void;
};

export const [useWorkspace, WorkspaceProvider] = createContextFromHook((props: WorkspaceCtx) => props);
