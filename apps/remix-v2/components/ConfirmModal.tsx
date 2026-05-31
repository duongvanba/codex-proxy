import { useEffect, useState } from "react";

export type ConfirmModalProps = {
  title: string;
  content: string;
  /** Các lựa chọn tuỳ chọn (nếu approval có sẵn danh sách). */
  options?: string[];
  /** Nếu yêu cầu nhập text thay vì chọn. */
  requiresInput?: boolean;
  /** decision: "approve" | "reject" | <option> ; input nếu requiresInput. */
  onChoose: (decision: string, input?: string) => void;
  onCancel: () => void;
};

export function ConfirmModal({ title, content, options, requiresInput, onChoose, onCancel }: ConfirmModalProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal modal-confirm">
        <div className="modal-title">{title}</div>
        <div className="modal-content">{content}</div>

        {requiresInput && (
          <div className="modal-input-wrap">
            <textarea
              className="modal-input"
              value={text}
              placeholder="Nhập câu trả lời…"
              rows={3}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
            <button className="modal-btn always" disabled={!text.trim()} onClick={() => onChoose("input", text.trim())}>Gửi</button>
          </div>
        )}

        {!requiresInput && options && options.length > 0 && (
          <div className="modal-options">
            {options.map((opt, i) => (
              <button key={i} className="modal-btn once" onClick={() => onChoose(opt)}>{opt}</button>
            ))}
          </div>
        )}

        {!requiresInput && (!options || options.length === 0) && (
          <div className="modal-actions">
            <button className="modal-btn always" onClick={() => onChoose("approve")}>Đồng ý (luôn)</button>
            <button className="modal-btn once" onClick={() => onChoose("approve")}>Đồng ý 1 lần</button>
            <button className="modal-btn cancel" onClick={() => onChoose("reject")}>Từ chối</button>
          </div>
        )}
      </div>
    </div>
  );
}
