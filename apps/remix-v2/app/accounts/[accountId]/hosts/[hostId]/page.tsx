import { useParams } from "@remix-run/react";
import { ChatPanel } from "@components/ChatPanel";
import { useWorkspace } from "@context/workspace-context";

export default function Page() {
  const { accountId, hostId } = useParams<{ accountId: string; hostId: string }>();
  const { pendingEnvId, onChatCreated } = useWorkspace();

  return (
    <ChatPanel
      accountId={accountId!}
      chatId={null}
      environmentId={pendingEnvId ?? `selfhost:${hostId}`}
      onChatCreated={onChatCreated}
    />
  );
}
