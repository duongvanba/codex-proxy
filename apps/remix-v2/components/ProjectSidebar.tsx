import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@remix-run/react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { ChatDoc } from "@codex/types";
import { FolderPicker } from "@components/FolderPicker";
import { useTheme } from "@helpers/use-theme";
import { useTrigger } from "@helpers/use-trigger";

type ProjectGroup = {
  path: string;
  label: string;
  chats: LivequeryDocument<ChatDoc>[];
  lastUpdated: number;
};

function chatUpdatedAt(doc: LivequeryDocument<ChatDoc>): number {
  const value = doc.getValue();
  const raw = value.updated_at ?? value.created_at;
  const parsed = raw ? Date.parse(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupChatsByProject(chatDocs: LivequeryDocument<ChatDoc>[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  for (const doc of chatDocs) {
    const path = (doc.value as Record<string, unknown>).workspace_root as string | undefined ?? "";
    const label = path ? path.replace(/^.*\//, "") || path : "General";
    if (!map.has(path)) map.set(path, { path, label, chats: [], lastUpdated: 0 });
    const group = map.get(path)!;
    group.chats.push(doc);
    group.lastUpdated = Math.max(group.lastUpdated, chatUpdatedAt(doc));
  }
  return [...map.values()].sort((a, b) => {
    if (!a.path) return 1;
    if (!b.path) return -1;
    return (b.lastUpdated - a.lastUpdated) || a.path.localeCompare(b.path);
  });
}

function ChatItem({
  doc, selectedChatId, onChatSelect, onDeleteChat, onRenameChat,
}: {
  doc: LivequeryDocument<ChatDoc>;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
  onDeleteChat: (chatId: string, title?: string) => void;
  onRenameChat: (chatId: string, title?: string) => void;
}) {
  const chat = useObservable(doc);
  const isSelected = chat.id === selectedChatId;
  const processing = chat.status === "in_progress";
  const remoteStatus = (chat as ChatDoc & { remote_status?: string }).remote_status;
  const statusLabel = chat.status === "system_error" || remoteStatus === "systemError"
    ? { className: "error", text: "systemError" }
    : chat.status === "needs_response"
      ? { className: "needs-response", text: "Cần xác nhận" }
      : null;
  return (
    <div className={`chat-item ${isSelected ? "selected" : ""}`} title={chat.title ?? chat.id}>
      <div
        className="chat-item-main"
        onClick={() => onChatSelect(chat.id)}
        onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onRenameChat(chat.id, chat.title); }}
      >
      {processing
        ? <span className="chat-spinner" title="Agent đang xử lý" />
        : <span className={`chat-status-dot ${isSelected ? "active" : "done"}`} title={isSelected ? "Đang mở" : "Hoàn tất"} />}
      <span className="chat-title">{chat.title ?? "Untitled"}</span>
      {statusLabel && <span className={`chat-state-label ${statusLabel.className}`}>{statusLabel.text}</span>}
      </div>
      <button
        className="chat-delete-btn"
        title="Xoá chat"
        aria-label="Xoá chat"
        onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id, chat.title); }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function ProjectGroupItem({
  group, selectedChatId, onChatSelect, onNewChat, onDeleteChat, onRenameChat,
}: {
  group: ProjectGroup;
  selectedChatId: string | null;
  onChatSelect: (chatId: string) => void;
  onNewChat: (projectPath: string) => void;
  onDeleteChat: (chatId: string, title?: string) => void;
  onRenameChat: (chatId: string, title?: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="project-group">
      <div className="project-header" onClick={() => setExpanded((v) => !v)}>
        <span className="project-chevron">{expanded ? "▾" : "▸"}</span>
        <FolderIcon />
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
                onDeleteChat={onDeleteChat}
                onRenameChat={onRenameChat}
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
  const [renameTarget, setRenameTarget] = useState<{ chatId: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
  const trigger = useTrigger();

  async function deleteChat(chatId: string, title?: string) {
    if (!confirm(`Xoá chat "${title || chatId}"?`)) return;
    try {
      await trigger(`accounts/${accountId}/hosts/${hostId}/chats/${chatId}`, "archive-chat");
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  function openRenameChat(chatId: string, title?: string) {
    setRenameTarget({ chatId, title: title || "" });
    setRenameValue(title || "");
  }

  async function submitRenameChat() {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) return;
    try {
      await trigger(`accounts/${accountId}/hosts/${hostId}/chats/${renameTarget.chatId}`, "rename-chat", { title });
      setRenameTarget(null);
      setRenameValue("");
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <aside
      className={`workspace-sidebar${sidebarOpen ? "" : " sidebar-hidden"}`}
      style={{ "--sidebar-w": `${sidebarW}px` } as React.CSSProperties}
    >
      <div className="workspace-sidebar-inner">
      <div className="sidebar-header">
        <button className="btn-sidebar-back" title="Về trang chủ" onClick={() => navigate("/")}>←</button>
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
            onDeleteChat={deleteChat}
            onRenameChat={openRenameChat}
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
      {renameTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setRenameTarget(null); }}>
          <div className="modal rename-chat-modal">
            <div className="modal-title">Rename chat</div>
            <input
              className="modal-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenameTarget(null);
                if (e.key === "Enter") void submitRenameChat();
              }}
            />
            <div className="modal-actions">
              <button className="secondary-btn" onClick={() => setRenameTarget(null)}>Cancel</button>
              <button disabled={!renameValue.trim()} onClick={() => void submitRenameChat()}>Rename</button>
            </div>
          </div>
        </div>
      )}
      {sidebarOpen && <div className="sidebar-resizer" onMouseDown={startResize} title="Kéo để đổi rộng" />}
    </aside>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4h11" />
      <path d="M6.5 2.5h3l.5 1.5h-4z" />
      <path d="M5 6v6.5" />
      <path d="M8 6v6.5" />
      <path d="M11 6v6.5" />
      <path d="M4 4l.5 10h7L12 4" />
    </svg>
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

function FolderIcon() {
  return (
    <svg className="project-folder-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.2 4.2h4l1.3 1.6h6.3v6.6a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.2z" />
      <path d="M2.2 4.2v-.6a1.2 1.2 0 0 1 1.2-1.2h2.8l1.1 1.8" />
    </svg>
  );
}
