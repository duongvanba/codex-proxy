import { useCallback, useEffect, useRef, useState } from "react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { TurnDoc } from "./types";
import { ConfirmModal } from "./ConfirmModal";

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractTurnText(turn: TurnDoc): string {
  const outputItems = turn.output_items as Record<string, unknown>[];
  for (const item of outputItems) {
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "message") {
      const content = item.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => (c as Record<string, unknown>).type === "text")
          .map((c) => String((c as Record<string, unknown>).text ?? ""))
          .join("\n");
      }
    }
  }
  if (outputItems.length > 0) return JSON.stringify(outputItems[0]);
  const inputItems = turn.input_items as Record<string, unknown>[];
  for (const item of inputItems) {
    if (item.type === "message") {
      const content = item.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => (c as Record<string, unknown>).type === "text")
          .map((c) => String((c as Record<string, unknown>).text ?? ""))
          .join("\n");
      }
    }
  }
  return "";
}

function getApprovalRequest(turn: TurnDoc): { title: string; content: string } | null {
  const outputItems = turn.output_items as Record<string, unknown>[];
  for (const item of outputItems) {
    if (
      item.type === "approval_request" ||
      item.type === "confirmation_request" ||
      item.type === "tool_approval"
    ) {
      return {
        title: String(item.title ?? "Command Approval"),
        content: String(item.content ?? item.command ?? item.description ?? "Allow this action?"),
      };
    }
  }
  return null;
}

// ─── Turn row ─────────────────────────────────────────────────────────────────

function TurnRow({ turnDoc }: { turnDoc: LivequeryDocument<TurnDoc> }) {
  const turn = useObservable(turnDoc);
  const text = extractTurnText(turn);
  const isUser = turn.role === "user";
  const isStreaming = turn.status === "in_progress";

  if (!text && !isStreaming) return null;

  return (
    <div className={`turn ${isUser ? "turn-user" : "turn-assistant"}`}>
      <div className="turn-bubble">
        {text || <span className="streaming-dot" />}
        {isStreaming && text && <span className="streaming-dot" />}
      </div>
    </div>
  );
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────

type PendingUserMsg = { id: string; text: string };

export type ChatPanelProps = {
  accountId: string;
  chatId: string | null;
  environmentId?: string;
  onChatCreated?: (chatId: string) => void;
};

export function ChatPanel({ accountId, chatId, environmentId, onChatCreated }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingMsg, setPendingMsg] = useState<PendingUserMsg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; content: string; turnId: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const turnsKey = chatId ? `accounts/${accountId}/chats/${chatId}/turns` : null;
  const turnsCollection = useCollection<TurnDoc>(turnsKey ?? "accounts/__none__/chats/__none__/turns", {
    mode: "local-first",
    lazy: !chatId,
  });
  const turnDocs = useObservable(turnsCollection.items, []) as LivequeryDocument<TurnDoc>[];

  // Detect approval request turns
  useEffect(() => {
    if (!chatId) return;
    for (const doc of turnDocs) {
      const req = getApprovalRequest(doc.getValue());
      if (req && confirm?.turnId !== doc.getValue().id) {
        setConfirm({ ...req, turnId: doc.getValue().id });
        break;
      }
    }
  }, [turnDocs, chatId]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turnDocs, pendingMsg]);

  // Refetch turns to trigger SSE when chatId changes
  useEffect(() => {
    if (!chatId) return;
    turnsCollection.query({}).catch(() => {});
  }, [chatId]);

  // Clear pending message when a server turn arrives
  useEffect(() => {
    if (pendingMsg && turnDocs.length > 0) setPendingMsg(null);
  }, [turnDocs.length]);

  async function sendMessage(text: string) {
    if (!text.trim() || sending) return;
    const msgText = text.trim();
    setInput("");
    setSending(true);
    setError(null);

    try {
      if (!chatId) {
        // Create new chat
        const res = await fetch(`/livequery/accounts/${accountId}/~create-chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: msgText, environment_id: environmentId }),
        });
        const data = (await res.json()) as { data?: { chat_id?: string }; error?: { message?: string } };
        if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
        const newChatId = data.data?.chat_id;
        if (!newChatId) throw new Error("No chat_id returned");
        setPendingMsg({ id: crypto.randomUUID(), text: msgText });
        onChatCreated?.(newChatId);
      } else {
        // Follow-up message
        const res = await fetch(`/livequery/accounts/${accountId}/chats/${chatId}/~send-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: msgText, environment_id: environmentId }),
        });
        const data = (await res.json()) as { error?: { message?: string } };
        if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
        setPendingMsg({ id: crypto.randomUUID(), text: msgText });
        // Re-query turns to trigger SSE subscription
        await turnsCollection.query({}).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
      setInput(msgText);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  async function handleCancel() {
    if (!chatId) return;
    await fetch(`/livequery/accounts/${accountId}/chats/${chatId}/~cancel-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }

  const isStreaming = turnDocs.some((d) => d.getValue().status === "in_progress") || sending;

  // For confirm modal actions, we'd send the approval response here
  function handleConfirmResponse(mode: "always" | "once" | "cancel") {
    // TODO: wire to backend approval API
    console.log("confirm response:", mode);
    setConfirm(null);
  }

  return (
    <div className="chat-panel">
      {/* Turns list */}
      <div className="turn-list">
        {!chatId && (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <div>Chọn một cuộc chat hoặc bắt đầu cuộc hội thoại mới</div>
          </div>
        )}
        {chatId && turnDocs.length === 0 && !pendingMsg && !isStreaming && (
          <div className="chat-empty">
            <div className="chat-empty-icon">✨</div>
            <div>Bắt đầu cuộc hội thoại...</div>
          </div>
        )}
        {turnDocs.map((doc) => <TurnRow key={doc.getValue().id} turnDoc={doc} />)}
        {pendingMsg && (
          <div className="turn turn-user">
            <div className="turn-bubble">{pendingMsg.text}</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Confirm modal */}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          content={confirm.content}
          onAlways={() => handleConfirmResponse("always")}
          onOnce={() => handleConfirmResponse("once")}
          onCancel={() => handleConfirmResponse("cancel")}
        />
      )}

      {/* Error notice */}
      {error && <div className="chat-error">{error}</div>}

      {/* Input area */}
      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          className="chat-input"
          placeholder={chatId ? "Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)" : "Nhập tin nhắn để bắt đầu..."}
          value={input}
          rows={3}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <div className="chat-input-actions">
          {isStreaming && chatId && (
            <button className="secondary-btn" onClick={() => void handleCancel()}>Stop</button>
          )}
          <button
            disabled={!input.trim() || sending}
            onClick={() => void sendMessage(input)}
          >
            {sending ? <span className="inline-spinner compact" /> : null}
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
