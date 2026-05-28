import { useState, useEffect } from "react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { ChatDoc, HostDoc } from "./types";
import { FolderPicker } from "./FolderPicker";

// ─── Group chats by workspace_root ────────────────────────────────────────────

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

// ─── Chat item row ────────────────────────────────────────────────────────────

function ChatItem({
  doc,
  selectedChatId,
  onChatSelect,
}: {
  doc: LivequeryDocument<ChatDoc>;
  selectedChatId: string | null;
  onChatSelect: (chatId: string, envId: string) => void;
}) {
  const chat = useObservable(doc);
  const isSelected = chat.id === selectedChatId;
  const envId = (chat as Record<string, unknown>).environment_id as string | undefined ?? "";
  return (
    <div
      className={`chat-item ${isSelected ? "selected" : ""}`}
      onClick={() => onChatSelect(chat.id, envId)}
      title={chat.title ?? chat.id}
    >
      <span className="chat-status-dot" data-status={chat.status ?? "idle"} />
      <span className="chat-title">{chat.title ?? "Untitled"}</span>
    </div>
  );
}

// ─── Project group row ────────────────────────────────────────────────────────

function ProjectGroup({
  group,
  selectedChatId,
  onChatSelect,
  onNewChat,
}: {
  group: ProjectGroup;
  selectedChatId: string | null;
  onChatSelect: (chatId: string, envId: string) => void;
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

// ─── ProjectSidebar ───────────────────────────────────────────────────────────

export type ProjectSidebarProps = {
  accountId: string;
  selectedChatId: string | null;
  onChatSelect: (chatId: string, envId: string) => void;
  onNewChat: (projectPath: string, hostId: string, envId: string) => void;
};

export function ProjectSidebar({ accountId, selectedChatId, onChatSelect, onNewChat }: ProjectSidebarProps) {
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);

  const hostsCollection = useCollection<HostDoc>(`accounts/${accountId}/hosts`, {
    mode: "local-first",
    lazy: false,
  });
  const hostDocs = useObservable(hostsCollection.items, []) as LivequeryDocument<HostDoc>[];

  const activeHostId = selectedHostId ?? hostDocs[0]?.value.env_id ?? null;
  const activeHost = hostDocs.find((d) => d.value.env_id === activeHostId) ?? hostDocs[0];
  const envId = activeHost ? `selfhost:${activeHost.value.env_id}` : "";

  useEffect(() => {
    hostsCollection.query({});
  }, [hostsCollection]);

  const chatsCollection = useCollection<ChatDoc>(
    activeHostId
      ? `accounts/${accountId}/hosts/${activeHostId}/chats`
      : null,
    { mode: "local-first", lazy: true }
  );
  const chatDocs = useObservable(chatsCollection.items, []) as LivequeryDocument<ChatDoc>[];
  const groups = groupChatsByProject(chatDocs);

  useEffect(() => {
    if (!activeHostId) return;
    chatsCollection.query({});
  }, [chatsCollection, activeHostId]);

  function handleNewChatInProject(projectPath: string) {
    if (!activeHostId) return;
    onNewChat(projectPath, activeHostId, envId);
  }

  function handleFolderConfirm(path: string) {
    setShowFolderPicker(false);
    if (!activeHostId) return;
    onNewChat(path, activeHostId, envId);
  }

  return (
    <aside className="workspace-sidebar">
      {/* Host selector (only show if multiple hosts) */}
      {hostDocs.length > 1 && (
        <div className="host-selector">
          <select
            value={activeHostId ?? ""}
            onChange={(e) => setSelectedHostId(e.target.value)}
          >
            {hostDocs.map((doc) => (
              <option key={doc.value.env_id} value={doc.value.env_id}>
                {doc.value.display_name || doc.value.host_name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* New project button */}
      <div className="sidebar-header">
        <span className="sidebar-title">Projects</span>
        <button
          className="btn-icon"
          title="New project"
          disabled={!activeHostId}
          onClick={() => setShowFolderPicker(true)}
        >
          + New
        </button>
      </div>

      {/* Project list */}
      <div className="project-list">
        {hostDocs.length === 0 && (
          <div className="empty">No hosts online</div>
        )}
        {hostDocs.length > 0 && groups.length === 0 && (
          <div className="empty">No projects yet.<br />Click + New to start.</div>
        )}
        {groups.map((group) => (
          <ProjectGroup
            key={group.path}
            group={group}
            selectedChatId={selectedChatId}
            onChatSelect={onChatSelect}
            onNewChat={handleNewChatInProject}
          />
        ))}
      </div>

      {/* Folder picker modal */}
      {showFolderPicker && activeHostId && (
        <FolderPicker
          accountId={accountId}
          hostId={activeHostId}
          onConfirm={handleFolderConfirm}
          onCancel={() => setShowFolderPicker(false)}
        />
      )}
    </aside>
  );
}
