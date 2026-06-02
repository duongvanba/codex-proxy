import { useEffect, useState } from "react";

export type ConfirmModalProps = {
  title: string;
  content: string;
  command?: string;
  requestKind?: "approval" | "option_picker";
  /** Các lựa chọn tuỳ chọn (nếu approval có sẵn danh sách). */
  options?: string[];
  optionDescriptions?: string[];
  allowMultiple?: boolean;
  submitLabel?: string;
  skipLabel?: string;
  /** Nếu yêu cầu nhập text thay vì chọn. */
  requiresInput?: boolean;
  /** decision: "approve" | "approve_persist" | "reject" | "input" | "option"; input nếu có feedback/lựa chọn. */
  onChoose: (decision: string, input?: string) => void;
  onCancel: () => void;
};

function decisionForOption(option: string, index: number): "approve" | "approve_persist" | "reject" {
  const normalized = option.toLowerCase();
  if (normalized.startsWith("no") || normalized.includes("deny") || normalized.includes("reject") || normalized.includes("từ chối")) {
    return "reject";
  }
  if (index === 1 || normalized.includes("don't ask again") || normalized.includes("luôn") || normalized.includes("session")) {
    return "approve_persist";
  }
  return "approve";
}

export function ConfirmModal({ title, content, command, requestKind = "approval", options, optionDescriptions, allowMultiple, submitLabel, skipLabel, requiresInput, onChoose, onCancel }: ConfirmModalProps) {
  const [text, setText] = useState("");
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const isOptionPicker = requestKind === "option_picker";
  const feedbackLabel = "No, and tell Codex what to do differently";
  const visibleOptions = isOptionPicker && options?.some((opt) => opt.toLowerCase() === feedbackLabel.toLowerCase())
    ? options
    : isOptionPicker
      ? [...(options ?? []), feedbackLabel]
      : options;

  useEffect(() => {
    setText("");
    setFeedbackMode(false);
    setSelected([]);
  }, [title, content, command, requestKind]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  function toggleOption(option: string) {
    if (!allowMultiple) {
      setSelected([option]);
      return;
    }
    setSelected((prev) => prev.includes(option) ? prev.filter((item) => item !== option) : [...prev, option]);
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal modal-confirm">
        <div className="modal-title">{title}</div>
        <div className="modal-content">{content}</div>
        {command && <pre className="modal-command"><code>{command}</code></pre>}

        {(requiresInput || feedbackMode) && (
          <div className="modal-input-wrap">
            <textarea
              className="modal-input"
              value={text}
              placeholder={feedbackMode ? "Nói Codex cần làm gì khác đi..." : "Nhập câu trả lời..."}
              rows={3}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
            <div className="modal-input-actions">
              {feedbackMode && <button className="modal-btn cancel" onClick={() => onChoose("reject")}>{skipLabel ?? "Skip"}</button>}
              <button
                className="modal-btn always"
                disabled={!text.trim()}
                onClick={() => onChoose(feedbackMode ? "reject" : "input", text.trim())}
              >
                Submit
              </button>
            </div>
          </div>
        )}

        {!requiresInput && !feedbackMode && visibleOptions && visibleOptions.length > 0 && (
          <div className="modal-options">
            {visibleOptions.map((opt, i) => {
              const isFeedback = isOptionPicker && opt.toLowerCase() === feedbackLabel.toLowerCase();
              const isSelected = selected.includes(opt);
              return (
              <button
                key={i}
                className={`modal-option-row ${decisionForOption(opt, i) === "reject" ? "danger" : ""} ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  if (isFeedback) {
                    setFeedbackMode(true);
                    return;
                  }
                  if (isOptionPicker) {
                    toggleOption(opt);
                    return;
                  }
                  const decision = decisionForOption(opt, i);
                  if (decision === "reject") setFeedbackMode(true);
                  else onChoose(decision);
                }}
              >
                <span className="modal-option-index">{i + 1}.</span>
                <span className="modal-option-text">
                  <span>{opt}</span>
                  {optionDescriptions?.[i] && <small>{optionDescriptions[i]}</small>}
                </span>
              </button>
            );})}
            {isOptionPicker && (
              <div className="modal-input-actions">
                <button className="modal-btn cancel" onClick={() => onChoose("reject")}>{skipLabel ?? "Dismiss"}</button>
                <button
                  className="modal-btn always"
                  disabled={selected.length === 0}
                  onClick={() => onChoose("option", selected.join("\n"))}
                >
                  {submitLabel ?? "Submit"}
                </button>
              </div>
            )}
          </div>
        )}

        {!requiresInput && !feedbackMode && (!options || options.length === 0) && (
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
