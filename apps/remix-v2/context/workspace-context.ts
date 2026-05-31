import { createContext, useContext } from "react";

type WorkspaceCtx = {
  pendingEnvId: string | null;
  setPendingEnvId: (id: string | null) => void;
  onChatCreated: (chatId: string) => void;
};

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within HostsLayout");
  return ctx;
}
