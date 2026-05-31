import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@remix-run/react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { ChatDoc } from "@codex/types";
import { FolderPicker } from "@components/FolderPicker";
import { useTheme } from "@helpers/use-theme";

type ProjectGroup = {
  path: string;
  label: string;
  chats: LivequeryDocument<ChatDoc>[];
};

function groupChatsByProject(chatDocs: LivequeryDocument<ChatDoc>[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const doc of chatDocs) {
    const path = (doc.value as Record<string, unknown>).workspace_root as string | undefined ?? "";
    const label = path ? path.replace(/^.*\//, "") || path : "General";
    if (!map.has(path)) map.set(path, { path, label, chats: [] });
    map.get(path)!.chats.push(doc);
  }
  return [...map.values()].sort((a, b) => {
    if (!a.path) return 1;
    if (!b.path) return -1;
    return a.path.localeCompare(b.path);
  });
}

function ChatItem({
  doc, selectedChatId, onChatSelect,
}: {
  doc: LivequeryDocument<ChatDoc>;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
}) {
  const chat = useObservable(doc);
  const isSelected = chat.id === selectedChatId;
  const processing = chat.status === "in_progress";
  return (
    <div
      className={`chat-item ${isSelected ? "selected" : ""}`}
      onClick={() => onChatSelect(chat.id)}
      title={chat.title ?? chat.id}
    >
      {processing
        ? <span className="chat-spinner" title="Agent đang xử lý" />
        : <span className={`chat-status-dot ${isSelected ? "active" : "done"}`} title={isSelected ? "Đang mở" : "Hoàn tất"} />}
      <span className="chat-title">{chat.title ?? "Untitled"}</span>
    </div>
  );
}

function ProjectGroupItem({
  group, selectedChatId, onChatSelect, onNewChat,
}: {
  group: ProjectGroup;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
  onNewChat: (projectPath: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="project-group">
      <div className="project-header" onClick={() => setExpanded((v) => !v)}>
        <span className="project-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="project-label" title={group.path || "General"}>{group.label || "General"}</span>
        <button
          className="btn-icon"
          title="New chat"
          onClick={(e) => { e.stopPropagation(); onNewChat(group.path); }}
        >
          +
        </button>
      </div>
      {expanded && (
        <div className="project-chats">
          {group.chats.length === 0 ? (
            <div className="chat-item muted">No chats yet</div>
          ) : (
            group.chats.map((doc) => (
              <ChatItem
                key={doc.getValue().id}
                doc={doc}
                selectedChatId={selectedChatId}
                onChatSelect={onChatSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export type ProjectSidebarProps = {
  accountId: string;
  hostId: string;
  chatId?: string | null;
  sidebarOpen?: boolean;
  onToggle?: () => void;
  onChatSelect: (chatId: string) => void;
  onNewChat: (projectPath: string) => void;
};

export function ProjectSidebar({
  accountId, hostId, chatId: selectedChatId,
  sidebarOpen = true, onToggle, onChatSelect, onNewChat,
}: ProjectSidebarProps) {
  const navigate = useNavigate();
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();

  // ─── Kéo đổi rộng sidebar ──────────────────────────────────────────────────
  const [sidebarW, setSidebarW] = useState<number>(260);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("codex-sidebar-w"));
      if (saved >= 180 && saved <= 480) setSidebarW(saved);
    } catch { /* ignore */ }
  }, []);
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarW;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
      setSidebarW(w);
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const w = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
      try { localStorage.setItem("codex-sidebar-w", String(w)); } catch { /* ignore */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const chatsCollection = useCollection<ChatDoc>(
    `accounts/${accountId}/hosts/${hostId}/chats`,
    { mode: "server-first", filters: { "created_at:sort": "asc" } as any }
  );
  const chatDocs = useObservable(chatsCollection.items, []) as LivequeryDocument<ChatDoc>[];
  const loading = useObservable(chatsCollection.loading, null);
  const error = useObservable(chatsCollection.error, null) as { code?: string; message?: string } | null;
  const groups = groupChatsByProject(chatDocs);

  return (
    <aside
      className={`workspace-sidebar${sidebarOpen ? "" : " sidebar-hidden"}`}
      style={{ "--sidebar-w": `${sidebarW}px` } as React.CSSProperties}
    >
      <div className="workspace-sidebar-inner">
      <div className="sidebar-header">
        <button className="btn-sidebar-back" title="Back to hosts" onClick={() => navigate(`/accounts/${accountId}`)}>←</button>
        <span className="sidebar-title">Projects</span>
        <button className="btn-sidebar-toggle" onClick={toggleTheme} title="Đổi sáng/tối" aria-label="Đổi theme">{theme === "dark" ? "☀" : "☾"}</button>
        <button className="btn-icon" title="Dự án mới" onClick={() => setShowFolderPicker(true)}>+</button>
        {onToggle && (
          <button className="btn-sidebar-toggle" onClick={onToggle} title="Ẩn sidebar" aria-label="Ẩn sidebar"><HamburgerIcon /></button>
        )}
      </div>
      <div className="project-list">
        {error && (
          <div className="empty err">
            <div>Không tải được danh sách chat từ máy remote.</div>
            <div className="err-detail">{error.message ?? error.code ?? "Lỗi không xác định"}</div>
            <button className="secondary-btn" onClick={() => { void chatsCollection.query({ "created_at:sort": "asc" } as any); }}>Thử lại</button>
          </div>
        )}
        {loading && !error && <div className="loading-row"><span className="inline-spinner compact" /></div>}
        {!loading && !error && groups.length === 0 && (
          <div className="empty">No projects yet.<br />Click + New to start.</div>
        )}
        {groups.map((group) => (
          <ProjectGroupItem
            key={group.path}
            group={group}
            selectedChatId={selectedChatId ?? null}
            onChatSelect={onChatSelect}
            onNewChat={onNewChat}
          />
        ))}
      </div>
      </div>
      {showFolderPicker && (
        <FolderPicker
          accountId={accountId}
          hostId={hostId}
          onConfirm={(path) => { setShowFolderPicker(false); onNewChat(path); }}
          onCancel={() => setShowFolderPicker(false)}
        />
      )}
      {sidebarOpen && <div className="sidebar-resizer" onMouseDown={startResize} title="Kéo để đổi rộng" />}
    </aside>
  );
}

function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
    </svg>
  );
}
