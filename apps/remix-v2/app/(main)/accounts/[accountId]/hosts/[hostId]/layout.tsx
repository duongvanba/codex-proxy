import { useState } from "react";
import { Outlet, useNavigate, useParams } from "@remix-run/react";
import { WorkspaceProvider } from "@context/workspace-context";
import { ProjectSidebar } from "@components/ProjectSidebar";

function LayoutContent({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { accountId, hostId, chatId } = useParams<{ accountId: string; hostId: string; chatId?: string }>();
  const [pendingEnvId, setPendingEnvId] = useState<string | null>(null);
  const [pendingCwd, setPendingCwd] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatScrolledUp, setChatScrolledUp] = useState(false);
  const envId = `selfhost:${hostId}`;

  function handleChatSelect(selectedChatId: string) {
    navigate(`/accounts/${accountId}/hosts/${hostId}/chats/${selectedChatId}`);
    if (window.innerWidth < 640) setSidebarOpen(false);
  }

  function handleNewChat(projectPath: string) {
    setPendingEnvId(envId);
    setPendingCwd(projectPath || null);
    navigate(`/accounts/${accountId}/hosts/${hostId}`);
    if (window.innerWidth < 640) setSidebarOpen(false);
  }

  function handleChatCreated(newChatId: string) {
    setPendingEnvId(null);
    setPendingCwd(null);
    navigate(`/accounts/${accountId}/hosts/${hostId}/chats/${newChatId}`);
  }

  return (
    <WorkspaceProvider
      pendingEnvId={pendingEnvId}
      setPendingEnvId={setPendingEnvId}
      pendingCwd={pendingCwd}
      setPendingCwd={setPendingCwd}
      onChatCreated={handleChatCreated}
      setChatScrolledUp={setChatScrolledUp}
    >
      <div className={`workspace${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`}>
        {!sidebarOpen && (
          <button
            className="btn-sidebar-toggle sidebar-show-float"
            onClick={() => setSidebarOpen(true)}
            title="Show chats"
          >☰</button>
        )}
        {sidebarOpen && chatScrolledUp && (
          <button
            className="btn-sidebar-toggle sidebar-collapse-float"
            onClick={() => setSidebarOpen(false)}
            title="Hide chats"
            aria-label="Ẩn sidebar"
          >‹</button>
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
    </WorkspaceProvider>
  );
}

export default function Layout() {
  return (
    <LayoutContent>
      <Outlet />
    </LayoutContent>
  );
}
