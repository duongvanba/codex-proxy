import { useEffect, useState } from "react";

type FolderOption = { path: string; label: string };

async function fetchWorkspaceOptions(accountId: string, hostId: string): Promise<FolderOption[]> {
  const res = await fetch(`/livequery/accounts/${accountId}/hosts/${hostId}/~workspace-options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { options?: FolderOption[] } };
  return json.data?.options ?? [];
}

export type FolderPickerProps = {
  accountId: string;
  hostId: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
};

export function FolderPicker({ accountId, hostId, onConfirm, onCancel }: FolderPickerProps) {
  const [options, setOptions] = useState<FolderOption[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchWorkspaceOptions(accountId, hostId)
      .then((opts) => {
        setOptions(opts);
        if (opts.length > 0) setSelected(opts[0]?.path ?? "");
      })
      .finally(() => setLoading(false));
  }, [accountId, hostId]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const finalPath = custom.trim() || selected;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal folder-picker">
        <div className="modal-title">Select workspace folder</div>

        {loading ? (
          <div className="empty"><span className="inline-spinner" /> Loading folders...</div>
        ) : options.length === 0 ? (
          <div className="empty muted">No suggested folders found.</div>
        ) : (
          <div className="folder-list">
            {options.map((opt) => (
              <label key={opt.path} className={`folder-item ${selected === opt.path && !custom ? "active" : ""}`}>
                <input
                  type="radio"
                  name="folder"
                  value={opt.path}
                  checked={selected === opt.path && !custom}
                  onChange={() => { setSelected(opt.path); setCustom(""); }}
                />
                <span className="folder-path">{opt.label || opt.path}</span>
                <span className="folder-sub">{opt.path}</span>
              </label>
            ))}
          </div>
        )}

        <div className="folder-custom">
          <label className="folder-custom-label">Custom path</label>
          <input
            className="folder-input"
            type="text"
            placeholder="/path/to/project"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </div>

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
