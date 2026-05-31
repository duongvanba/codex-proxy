import { useParams } from "@remix-run/react";
import { ChatPanel } from "@components/ChatPanel";
import { useWorkspace } from "@context/workspace-context";

export default function Page() {
  const { accountId, hostId, chatId } = useParams<{ accountId: string; hostId: string; chatId: string }>();
  const { pendingEnvId, onChatCreated } = useWorkspace();

  return (
    <ChatPanel
      key={chatId}
      accountId={accountId!}
      chatId={chatId!}
      environmentId={pendingEnvId ?? `selfhost:${hostId}`}
      onChatCreated={onChatCreated}
    />
  );
}
