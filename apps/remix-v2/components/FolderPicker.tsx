import { useEffect, useMemo, useState } from "react";
import { useTrigger } from "@helpers/use-trigger";

type FolderNode = { path: string; name: string };
type FolderListResponse = { path: string; dirs: FolderNode[] };
type TreeState = {
  children: FolderNode[];
  loading: boolean;
  loaded: boolean;
  error?: string;
};

export type FolderPickerProps = {
  accountId: string;
  hostId: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
};

function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i > 0 ? clean.slice(0, i) : "/";
}

function joinPath(parent: string, name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return parent;
  return parent === "/" ? `/${trimmed}` : `${parent.replace(/\/+$/, "")}/${trimmed}`;
}

function FolderTreeNode({
  node, selected, expanded, tree, onSelect, onToggle,
}: {
  node: FolderNode;
  selected: string;
  expanded: Set<string>;
  tree: Map<string, TreeState>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const state = tree.get(node.path);
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
  const hasKnownChildren = Boolean(state?.children.length);
  return (
    <div className="folder-tree-node">
      <div className={`folder-tree-row${isSelected ? " active" : ""}`}>
        <button className="folder-expander" type="button" onClick={() => onToggle(node.path)}>
          {state?.loading ? <span className="inline-spinner compact" /> : isOpen ? "▾" : "▸"}
        </button>
        <button className="folder-select" type="button" onClick={() => onSelect(node.path)} title={node.path}>
          <span className="folder-icon">{hasKnownChildren || isOpen ? "▣" : "▢"}</span>
          <span className="folder-name">{node.name || node.path}</span>
          <span className="folder-full-path">{node.path}</span>
        </button>
      </div>
      {state?.error && <div className="folder-tree-error">{state.error}</div>}
      {isOpen && state?.children && (
        <div className="folder-tree-children">
          {state.children.length === 0 && state.loaded
            ? <div className="folder-tree-empty">Không có thư mục con</div>
            : state.children.map((child) => (
              <FolderTreeNode
                key={child.path}
                node={child}
                selected={selected}
                expanded={expanded}
                tree={tree}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export function FolderPicker({ accountId, hostId, onConfirm, onCancel }: FolderPickerProps) {
  const [root, setRoot] = useState<FolderNode | null>(null);
  const [tree, setTree] = useState<Map<string, TreeState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const trigger = useTrigger();

  const finalPath = custom.trim() || selected;
  const selectedParent = useMemo(() => selected || root?.path || "", [selected, root]);

  async function loadFolder(path?: string, force = false) {
    const key = path || "__root__";
    const existing = tree.get(key);
    if (existing?.loading || (existing?.loaded && !force)) return;
    setTree((prev) => new Map(prev).set(key, { children: existing?.children ?? [], loaded: existing?.loaded ?? false, loading: true }));
    try {
      const data = await trigger<FolderListResponse>(`accounts/${accountId}/hosts/${hostId}`, "folder-list", path ? { path } : {});
      const base = data.path;
      const rootNode = { path: base, name: base.split("/").filter(Boolean).pop() || base };
      if (!path) {
        setRoot(rootNode);
        setSelected((prev) => prev || base);
        setExpanded((prev) => new Set(prev).add(base));
      }
      setTree((prev) => {
        const next = new Map(prev);
        next.delete(key);
        next.set(base, { children: data.dirs ?? [], loaded: true, loading: false });
        return next;
      });
    } catch (error) {
      setTree((prev) => new Map(prev).set(key, {
        children: existing?.children ?? [],
        loaded: existing?.loaded ?? false,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  useEffect(() => {
    void loadFolder();
  }, [accountId, hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  async function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    await loadFolder(path);
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name || !selectedParent) return;
    const path = name.startsWith("/") ? name : joinPath(selectedParent, name);
    setNotice(null);
    try {
      const data = await trigger<{ path: string }>(`accounts/${accountId}/hosts/${hostId}`, "folder-create", { path });
      const created = data.path || path;
      const parent = parentPath(created);
      setNewFolderName("");
      setSelected(created);
      setCustom("");
      setExpanded((prev) => new Set(prev).add(parent));
      await loadFolder(parent, true);
      setNotice(`Đã tạo ${created}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal folder-picker">
        <div className="modal-title">Select workspace folder</div>
        <div className="folder-tree">
          {!root ? (
            <div className="empty"><span className="inline-spinner" /> Loading folders...</div>
          ) : (
            <FolderTreeNode
              node={root}
              selected={selected}
              expanded={expanded}
              tree={tree}
              onSelect={(path) => { setSelected(path); setCustom(""); }}
              onToggle={toggle}
            />
          )}
        </div>
        <div className="folder-create">
          <label className="folder-custom-label">Create folder under selected path</label>
          <div className="folder-create-row">
            <input
              className="folder-input"
              type="text"
              placeholder={selectedParent ? `${selectedParent}/new-folder` : "new-folder"}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
            />
            <button className="secondary-btn" disabled={!newFolderName.trim() || trigger.loading} onClick={() => void createFolder()}>Create</button>
          </div>
        </div>
        <div className="folder-custom">
          <label className="folder-custom-label">Custom path</label>
          <input
            className="folder-input" type="text" placeholder="/path/to/project"
            value={custom} onChange={(e) => setCustom(e.target.value)}
          />
        </div>
        {notice && <div className="folder-notice">{notice}</div>}
        <div className="modal-actions">
          <button className="secondary-btn" onClick={onCancel}>Cancel</button>
          <button disabled={!finalPath} onClick={() => finalPath && onConfirm(finalPath)}>
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}
