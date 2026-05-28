import { useEffect } from "react";

export type ConfirmModalProps = {
  title: string;
  content: string;
  onAlways: () => void;
  onOnce: () => void;
  onCancel: () => void;
};

export function ConfirmModal({ title, content, onAlways, onOnce, onCancel }: ConfirmModalProps) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal-title">{title}</div>
        <div className="modal-content">{content}</div>
        <div className="modal-actions">
          <button className="modal-btn always" onClick={onAlways}>Always Accept</button>
          <button className="modal-btn once" onClick={onOnce}>Accept Once</button>
          <button className="modal-btn cancel" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
