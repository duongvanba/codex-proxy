import { useState } from "react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { AccountDoc } from "./types";
import { ProjectSidebar } from "./ProjectSidebar";
import { ChatPanel } from "./ChatPanel";

type ActiveChat = {
  chatId: string;
  environmentId: string;
};

export function WorkspacePage({
  accountId,
  onBack,
}: {
  accountId: string;
  onBack: () => void;
}) {
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [pendingNewChat, setPendingNewChat] = useState<{ projectPath: string; hostId: string; envId: string } | null>(null);

  // Load account info for header
  const accountsCollection = useCollection<AccountDoc>("accounts", { mode: "local-first", lazy: false });
  const accountDocs = useObservable(accountsCollection.items, []) as LivequeryDocument<AccountDoc>[];
  const account = accountDocs.find((d) => d.value.id === accountId)?.value;

  function handleNewChat(projectPath: string, hostId: string, envId: string) {
    // Clear active chat — ChatPanel will create one when user sends first message
    setActiveChat(null);
    setPendingNewChat({ projectPath, hostId, envId });
  }

  function handleChatSelect(chatId: string, envId: string) {
    setActiveChat({ chatId, environmentId: envId });
    setPendingNewChat(null);
  }

  function handleChatCreated(chatId: string) {
    const envId = pendingNewChat?.envId ?? activeChat?.environmentId ?? "";
    setActiveChat({ chatId, environmentId: envId });
    setPendingNewChat(null);
  }

  const activeChatId = activeChat?.chatId ?? null;
  const activeEnvId = pendingNewChat?.envId ?? activeChat?.environmentId;

  return (
    <div className="workspace">
      {/* Top bar */}
      <div className="workspace-topbar">
        <button className="secondary-btn workspace-back" onClick={onBack}>← Back</button>
        <span className="workspace-account">
          {account?.email ?? accountId}
          {account?.chatgptPlanType && (
            <span className="workspace-plan">{account.chatgptPlanType.toUpperCase()}</span>
          )}
        </span>
      </div>

      {/* Main layout */}
      <div className="workspace-body">
        <ProjectSidebar
          accountId={accountId}
          selectedChatId={activeChatId}
          onChatSelect={handleChatSelect}
          onNewChat={handleNewChat}
        />

        <main className="workspace-main">
          <ChatPanel
            accountId={accountId}
            chatId={activeChatId}
            environmentId={activeEnvId}
            onChatCreated={handleChatCreated}
          />
        </main>
      </div>
    </div>
  );
}
