import { useParams } from "@remix-run/react";
import { ChatPanel } from "@components/ChatPanel";
import { useWorkspace } from "@context/workspace-context";

export default function Page() {
  const { accountId, hostId } = useParams<{ accountId: string; hostId: string }>();
  const { pendingEnvId, pendingCwd, onChatCreated, setChatScrolledUp } = useWorkspace();

  return (
    <ChatPanel
      accountId={accountId!}
      chatId={null}
      environmentId={pendingEnvId ?? `selfhost:${hostId}`}
      cwd={pendingCwd ?? undefined}
      onChatCreated={onChatCreated}
      onScrolledUpChange={setChatScrolledUp}
    />
  );
}
