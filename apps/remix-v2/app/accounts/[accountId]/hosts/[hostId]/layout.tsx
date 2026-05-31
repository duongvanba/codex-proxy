import { useState } from "react";
import { Outlet, useNavigate, useParams } from "@remix-run/react";
import { WorkspaceContext } from "@context/workspace-context";
import { ProjectSidebar } from "@components/ProjectSidebar";

function LayoutContent({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { accountId, hostId, chatId } = useParams<{ accountId: string; hostId: string; chatId?: string }>();
  const [pendingEnvId, setPendingEnvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const envId = `selfhost:${hostId}`;

  function handleChatSelect(selectedChatId: string) {
    navigate(`/accounts/${accountId}/hosts/${hostId}/chats/${selectedChatId}`);
    if (window.innerWidth < 640) setSidebarOpen(false);
  }

  function handleNewChat(_projectPath: string) {
    setPendingEnvId(envId);
    navigate(`/accounts/${accountId}/hosts/${hostId}`);
    if (window.innerWidth < 640) setSidebarOpen(false);
  }

  function handleChatCreated(newChatId: string) {
    navigate(`/accounts/${accountId}/hosts/${hostId}/chats/${newChatId}`);
  }

  return (
    <WorkspaceContext.Provider value={{ pendingEnvId, setPendingEnvId, onChatCreated: handleChatCreated }}>
      <div className="workspace">
        {!sidebarOpen && (
          <button
            className="btn-sidebar-toggle sidebar-show-float"
            onClick={() => setSidebarOpen(true)}
            title="Show chats"
          >☰</button>
        )}
        <div className="workspace-body">
          <ProjectSidebar
            accountId={accountId!}
            hostId={hostId!}
            chatId={chatId ?? null}
            sidebarOpen={sidebarOpen}
            onToggle={() => setSidebarOpen((v) => !v)}
            onChatSelect={handleChatSelect}
            onNewChat={handleNewChat}
          />
          <main className="workspace-main">{children}</main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}

export default function Layout() {
  return (
    <LayoutContent>
      <Outlet />
    </LayoutContent>
  );
}
