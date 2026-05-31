import { useCallback, useEffect, useRef, useState } from "react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { TurnDoc } from "@codex/types";
import { ConfirmModal } from "@components/ConfirmModal";
import { useTrigger } from "@helpers/use-trigger";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

// Map đuôi file → ngôn ngữ Prism (để tô màu code theo đúng extension).
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
  css: "css", scss: "scss", sass: "sass", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  md: "markdown", mdx: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql", dockerfile: "docker", makefile: "makefile",
};

function langFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (/^dockerfile$/i.test(base)) return "docker";
  if (/^makefile$/i.test(base)) return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? "text";
}

type FileChangeItem = { path: string; kind: string; diff: string };

function getFileChanges(turn: TurnDoc): FileChangeItem[] {
  for (const it of (turn.output_items as Record<string, unknown>[]) ?? []) {
    if (it?.type === "file_change" && Array.isArray(it.changes)) {
      return (it.changes as Record<string, unknown>[]).map((c) => ({
        path: String(c.path ?? ""), kind: String(c.kind ?? "modify"), diff: String(c.diff ?? ""),
      }));
    }
  }
  return [];
}

const KIND_ICON: Record<string, string> = { add: "+", modify: "±", delete: "−", rename: "→" };

function FileChangeBlock({ changes }: { changes: FileChangeItem[] }) {
  return (
    <div className="turn turn-assistant">
      <div className="file-change">
        {changes.map((c, i) => <FileChangeItemView key={i} change={c} />)}
      </div>
    </div>
  );
}

function FileChangeItemView({ change }: { change: FileChangeItem }) {
  const [open, setOpen] = useState(true);
  const lang = langFromPath(change.path);
  const name = change.path.split("/").pop() || change.path;
  const lines = change.diff ? change.diff.split("\n").length : 0;
  return (
    <div className={`fc-item fc-${change.kind}`}>
      <div className="fc-head" onClick={() => setOpen((v) => !v)}>
        <span className={`fc-kind fc-kind-${change.kind}`}>{KIND_ICON[change.kind] ?? "±"}</span>
        <span className="fc-name" title={change.path}>{name}</span>
        <span className="fc-lang">{lang === "text" ? "" : lang}</span>
        <span className="fc-lines">{lines} dòng</span>
        <span className="fc-toggle">{open ? "▾" : "▸"}</span>
      </div>
      {open && change.diff && (
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          customStyle={{ margin: 0, padding: "10px 12px", background: "transparent", fontSize: 12.5, lineHeight: 1.55, maxHeight: 420, overflow: "auto" }}
          wrapLongLines
        >
          {change.diff}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

// Slash commands — builtin client-side (Codex không expose RPC list skill qua relay; đây là tập cố định).
const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
  { cmd: "/init", desc: "Tạo AGENTS.md mô tả dự án" },
  { cmd: "/compact", desc: "Tóm tắt & nén hội thoại" },
  { cmd: "/review", desc: "Review các thay đổi code" },
  { cmd: "/diff", desc: "Xem git diff hiện tại" },
  { cmd: "/clear", desc: "Xoá ngữ cảnh hội thoại" },
  { cmd: "/new", desc: "Bắt đầu hội thoại mới" },
];

function randomUUID(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function extractTurnText(turn: TurnDoc): string {
  const outputItems = turn.output_items as Record<string, unknown>[];
  for (const item of outputItems) {
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "message") {
      const content = item.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => {
            const r = c as Record<string, unknown>;
            return r.type === "text" || r.content_type === "text";
          })
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
          .filter((c) => {
            const r = c as Record<string, unknown>;
            return r.type === "text" || r.content_type === "text";
          })
          .map((c) => String((c as Record<string, unknown>).text ?? ""))
          .join("\n");
      }
    }
  }
  return "";
}

type ApprovalReq = { title: string; content: string; options?: string[]; requiresInput?: boolean };

function getApprovalRequest(turn: TurnDoc): ApprovalReq | null {
  const outputItems = turn.output_items as Record<string, unknown>[];
  for (const item of outputItems) {
    if (
      item.type === "approval_request" ||
      item.type === "confirmation_request" ||
      item.type === "tool_approval" ||
      item.type === "approval" ||
      item.type === "elicitation"
    ) {
      const rawOpts = (item.options ?? item.choices) as unknown;
      const options = Array.isArray(rawOpts) ? rawOpts.map((o) => (typeof o === "string" ? o : String((o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.value ?? ""))).filter(Boolean) : undefined;
      const requiresInput = item.requiresInput === true || item.inputType === "text" || item.type === "elicitation";
      return {
        title: String(item.title ?? "Yêu cầu xác nhận"),
        content: String(item.content ?? item.command ?? item.description ?? item.message ?? "Cho phép hành động này?"),
        options,
        requiresInput,
      };
    }
  }
  return null;
}

function getTurnImages(turn: TurnDoc): { src: string | null; path?: string }[] {
  const out: { src: string | null; path?: string }[] = [];
  for (const list of [turn.output_items, turn.input_items]) {
    for (const it of (list as Record<string, unknown>[]) ?? []) {
      if (it?.type !== "image") continue;
      const data = typeof it.data === "string" ? it.data : undefined;
      const mime = typeof it.mimeType === "string" ? it.mimeType : "image/png";
      const url = typeof it.url === "string" ? it.url : undefined;
      out.push({ src: data ? `data:${mime};base64,${data}` : url ?? null, path: typeof it.path === "string" ? it.path : undefined });
    }
  }
  return out;
}

function getUnsupported(turn: TurnDoc): { itemType: string; raw: string } | null {
  for (const it of (turn.output_items as Record<string, unknown>[]) ?? []) {
    if (it?.type === "unsupported") return { itemType: String(it.item_type ?? "?"), raw: String(it.raw ?? "") };
  }
  return null;
}

function TurnRow({ turnDoc, onImageClick }: { turnDoc: LivequeryDocument<TurnDoc>; onImageClick: (src: string) => void }) {
  const turn = useObservable(turnDoc);
  const [showRaw, setShowRaw] = useState(false);
  // Gộp token delta ngay trong subscription của BehaviorSubject (không qua React batch → không mất delta).
  const [streamText, setStreamText] = useState("");
  useEffect(() => {
    let seq = 0;
    setStreamText("");
    const sub = turnDoc.subscribe((v) => {
      const d = v as TurnDoc & { _delta?: string; _seq?: number };
      if (typeof d._delta === "string" && typeof d._seq === "number" && d._seq > seq) {
        seq = d._seq;
        setStreamText((prev) => prev + d._delta);
      }
    });
    return () => sub.unsubscribe();
  }, [turnDoc]);

  const isUser = turn.role === "user";
  const isStreaming = turn.status === "in_progress";
  const baseText = extractTurnText(turn);
  // Khi xong dùng output_items (chuẩn xác); khi đang stream dùng text gộp từ delta.
  const text = (!isStreaming && baseText) ? baseText : (streamText || baseText);
  const imgs = getTurnImages(turn);
  const unsupported = getUnsupported(turn);
  const fileChanges = getFileChanges(turn);

  // Turn approval → không render bubble (modal xác nhận lo việc hiển thị).
  if (getApprovalRequest(turn)) return null;

  // Thay đổi file → render code có syntax highlight theo extension.
  if (fileChanges.length > 0) return <FileChangeBlock changes={fileChanges} />;

  // Marker kiểu chưa hỗ trợ — hiện rõ để dev biết cần bổ sung render.
  if (unsupported) {
    return (
      <div className="turn turn-assistant">
        <div className="turn-unsupported" onClick={() => setShowRaw((v) => !v)} title="Click xem raw">
          <span className="us-badge">⚙ {unsupported.itemType}</span>
          <span className="us-note">kiểu turn chưa render — {showRaw ? "ẩn" : "xem"} raw</span>
          {showRaw && <pre className="us-raw">{unsupported.raw}</pre>}
        </div>
      </div>
    );
  }

  if (imgs.length > 0) {
    return (
      <div className={`turn ${isUser ? "turn-user" : "turn-assistant"}`}>
        <div className="turn-bubble">
          {text && (isUser ? <span className="turn-text">{text}</span> : <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>)}
          <div className="turn-images">
            {imgs.map((im, i) => im.src
              ? <img key={i} className="turn-image" src={im.src} alt="" onClick={() => onImageClick(im.src!)} />
              : <span key={i} className="turn-image-missing">🖼 ảnh trên remote: {im.path ?? "?"}</span>)}
          </div>
        </div>
      </div>
    );
  }

  if (!text && !isStreaming) return null;
  return (
    <div className={`turn ${isUser ? "turn-user" : "turn-assistant"}`}>
      <div className="turn-bubble">
        {text
          ? (isUser
              ? <span className="turn-text">{text}</span>
              : <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>)
          : <span className="streaming-dot" />}
        {isStreaming && text && <span className="streaming-dot" />}
      </div>
    </div>
  );
}

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
  const [confirm, setConfirm] = useState<(ApprovalReq & { turnId: string }) | null>(null);
  const [resolvedConfirms, setResolvedConfirms] = useState<Set<string>>(new Set());
  const [pursueGoal, setPursueGoal] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [images, setImages] = useState<{ dataUrl: string; mimeType: string }[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trigger = useTrigger();

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }
  useEffect(() => { autoGrow(); }, [input]);

  function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) {
      if (f.type.startsWith("image/")) addImageFile(f);
      else setAttachments((prev) => [...prev, f.name]);
    }
    e.target.value = "";
  }

  function addImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setImages((prev) => [...prev, { dataUrl: String(reader.result), mimeType: file.type }]);
    reader.readAsDataURL(file);
  }

  // Paste ảnh trực tiếp vào khung chat
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) { addImageFile(file); e.preventDefault(); }
      }
    }
  }

  const turnsKey = chatId ? `accounts/${accountId}/chats/${chatId}/turns` : null;
  // ref null → useCollection bỏ qua (không query), tránh GET rác `__none__` → 404
  const turnsCollection = useCollection<TurnDoc>(
    turnsKey,
    { mode: "server-first", filters: { "created_at:sort": "asc" } as any }
  );
  const turnDocs = useObservable(turnsCollection.items, []) as LivequeryDocument<TurnDoc>[];
  const turnsLoading = useObservable(turnsCollection.loading, null);

  useEffect(() => {
    if (!chatId) return;
    for (const doc of turnDocs) {
      const v = doc.getValue();
      const req = getApprovalRequest(v);
      // Bỏ qua turn đã được trả lời (resolvedConfirms) → tránh modal hiện lại mãi mãi
      // nếu remote chưa kịp update turn sau khi approve/reject.
      if (req && !resolvedConfirms.has(v.id) && confirm?.turnId !== v.id) {
        setConfirm({ ...req, turnId: v.id });
        return;
      }
    }
  }, [turnDocs, chatId, resolvedConfirms]);

  async function respondConfirm(turnId: string, decision: string, input?: string) {
    setResolvedConfirms((prev) => new Set(prev).add(turnId)); // chốt ngay để không hiện lại
    setConfirm(null);
    if (!chatId) return;
    try {
      await trigger(`accounts/${accountId}/chats/${chatId}`, "approve-action", { turn_id: turnId, decision, input });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không gửi được quyết định");
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turnDocs, pendingMsg]);

  useEffect(() => {
    if (pendingMsg && turnDocs.length > 0) setPendingMsg(null);
  }, [turnDocs.length]);

  async function sendMessage(text: string) {
    const msgText = text.trim();
    if ((!msgText && images.length === 0) || sending) return;
    const imgs = images.map((i) => ({ data: i.dataUrl.split(",")[1] ?? "", mimeType: i.mimeType }));
    // KHÔNG flush textarea ngay — chỉ flush sau khi message thực sự gửi tới remote.
    setSending(true);
    setError(null);
    try {
      if (!chatId) {
        const selfhostId = environmentId?.startsWith("selfhost:") ? environmentId.slice(9) : null;
        const ref = selfhostId
          ? `accounts/${accountId}/hosts/${selfhostId}`
          : `accounts/${accountId}`;
        const body = selfhostId
          ? { input: msgText, images: imgs }
          : { input: msgText, images: imgs, environment_id: environmentId };
        const data = await trigger<{ chat_id?: string }>(ref, "create-chat", body);
        const newChatId = data?.chat_id;
        if (!newChatId) throw new Error("No chat_id returned");
        setInput(""); setImages([]);
        setPendingMsg({ id: randomUUID(), text: msgText });
        onChatCreated?.(newChatId);
      } else {
        // Chỉ gọi action send-message — backend gửi tới remote, POLLER realtime tự publish turn
        // (user + phản hồi agent). KHÔNG query/fetch lại để tránh reset collection (mất lịch sử).
        await trigger(`accounts/${accountId}/chats/${chatId}`, "send-message", { input: msgText, images: imgs, environment_id: environmentId });
        setPendingMsg({ id: randomUUID(), text: msgText }); // optimistic, tự xoá khi turn thật về
        setInput(""); setImages([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send");
      // giữ nguyên nội dung textarea để gửi lại
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      // Đang mở slash menu → Enter chọn lệnh đầu tiên thay vì gửi
      if (input.startsWith("/") && !input.includes(" ")) {
        const m = SLASH_COMMANDS.filter((s) => s.cmd.startsWith(input.toLowerCase()));
        if (m.length > 0) { e.preventDefault(); pickSlash(m[0].cmd); return; }
      }
      e.preventDefault();
      void sendMessage(input);
    }
  }

  async function handleCancel() {
    if (!chatId) return;
    await trigger(`accounts/${accountId}/chats/${chatId}`, "cancel-chat").catch(() => {});
  }

  const isStreaming = turnDocs.some((d) => d.getValue().status === "in_progress") || sending;

  // Slash menu: hiện khi đang gõ "/lệnh" (chưa có dấu cách)
  const slashMatches = input.startsWith("/") && !input.includes(" ")
    ? SLASH_COMMANDS.filter((s) => s.cmd.startsWith(input.toLowerCase()))
    : [];
  function pickSlash(cmd: string) {
    setInput(cmd + " ");
    textareaRef.current?.focus();
  }

  return (
    <div className="chat-panel">
      <div className="chat-island">
      <div className="turn-list">
        {!chatId && (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <div>Chọn một cuộc chat hoặc bắt đầu cuộc hội thoại mới</div>
          </div>
        )}
        {chatId && turnsLoading && (
          <div className="loading-row"><span className="inline-spinner compact" /></div>
        )}
        {chatId && !turnsLoading && turnDocs.length === 0 && !pendingMsg && !isStreaming && (
          <div className="chat-empty">
            <div className="chat-empty-icon">✨</div>
            <div>Bắt đầu cuộc hội thoại...</div>
          </div>
        )}
        {turnDocs.map((doc) => <TurnRow key={doc.getValue().id} turnDoc={doc} onImageClick={setLightbox} />)}
        {pendingMsg && (
          <div className="turn turn-user">
            <div className="turn-bubble">{pendingMsg.text}</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          content={confirm.content}
          options={confirm.options}
          requiresInput={confirm.requiresInput}
          onChoose={(decision, inputText) => respondConfirm(confirm.turnId, decision, inputText)}
          onCancel={() => respondConfirm(confirm.turnId, "reject")}
        />
      )}

      {error && <div className="chat-error">{error}</div>}

      {(attachments.length > 0 || images.length > 0) && (
        <div className="composer-attachments">
          {images.map((img, i) => (
            <span className="composer-img-chip" key={`img-${i}`}>
              <img src={img.dataUrl} alt="" />
              <button onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))} title="Bỏ">×</button>
            </span>
          ))}
          {attachments.map((name, i) => (
            <span className="composer-chip" key={`${name}-${i}`}>
              📎 {name}
              <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} title="Bỏ">×</button>
            </span>
          ))}
        </div>
      )}

      {slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((s) => (
            <button key={s.cmd} className="slash-item" onClick={() => pickSlash(s.cmd)}>
              <span className="slash-cmd">{s.cmd}</span>
              <span className="slash-desc">{s.desc}</span>
            </button>
          ))}
        </div>
      )}

      {isStreaming && (
        <div className="thinking-indicator">
          <span className="thinking-spinner" /> Đang suy nghĩ…
        </div>
      )}

      <div className="composer">
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={chatId ? "Nhập tin nhắn..." : "Nhập tin nhắn để bắt đầu..."}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={sending}
        />
        <div className="composer-toolbar">
          <button className="composer-add" title="Đính kèm file" onClick={() => fileInputRef.current?.click()}>+</button>
          <button className={`composer-tool${pursueGoal ? " on" : ""}`} title="Pursue goal" onClick={() => setPursueGoal((v) => !v)}>🎯 Goal</button>
          <button className={`composer-tool${planMode ? " on" : ""}`} title="Plan mode" onClick={() => setPlanMode((v) => !v)}>📋 Plan</button>
          <button className="composer-tool" title="Plugin (sắp có)" disabled>🧩 Plugin</button>
          <button className={`composer-tool icon${terminalOpen ? " on" : ""}`} title="Terminal" onClick={() => setTerminalOpen((v) => !v)}><TerminalIcon /></button>
          <div className="composer-spacer" />
          {isStreaming && chatId && (
            <button className="composer-stop" onClick={() => void handleCancel()} title="Dừng">■</button>
          )}
          <button
            className="composer-send"
            disabled={(!input.trim() && images.length === 0) || sending}
            onClick={() => void sendMessage(input)}
            title="Gửi"
          >
            {sending ? <span className="inline-spinner compact" /> : <SendArrow />}
          </button>
        </div>
        <input ref={fileInputRef} type="file" multiple hidden onChange={onFilesSelected} />
      </div>
      </div>

      <TerminalPanel
        open={terminalOpen}
        accountId={accountId}
        chatId={chatId}
        environmentId={environmentId}
        onClose={() => setTerminalOpen(false)}
      />

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(6, z + 0.25));
      else if (e.key === "-") setZoom((z) => Math.max(0.25, z - 0.25));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} title="Thu nhỏ (-)">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(6, z + 0.25))} title="Phóng to (+)">+</button>
        <button onClick={() => setZoom(1)} title="Reset">⟳</button>
        <button onClick={onClose} title="Đóng (Esc)">✕</button>
      </div>
      <img
        className="lightbox-img"
        src={src}
        alt=""
        style={{ transform: `scale(${zoom})` }}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => setZoom((z) => Math.min(6, Math.max(0.25, z - e.deltaY * 0.002)))}
      />
    </div>
  );
}

function commonPrefix(arr: string[]): string {
  if (arr.length === 0) return "";
  let p = arr[0];
  for (const s of arr) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}

function TerminalPanel({
  open, accountId, chatId, environmentId, onClose,
}: { open: boolean; accountId: string; chatId: string | null; environmentId?: string; onClose: () => void }) {
  const [lines, setLines] = useState<{ type: "cmd" | "out" | "err"; text: string }[]>([]);
  const [cmd, setCmd] = useState("");
  const [cwd, setCwd] = useState("");        // cwd tự track (shellCommand không giữ cwd giữa các lệnh)
  const [running, setRunning] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trigger = useTrigger();
  const ref = chatId ? `accounts/${accountId}/chats/${chatId}` : `accounts/${accountId}`;

  // Chạy 1 lệnh shell, tự nối `cd <cwd>` để giữ cwd + đọc pwd cuối qua marker.
  // track=false: chỉ đọc (không cập nhật cwd) — dùng cho completion.
  async function sh(userCmd: string, track = true): Promise<string> {
    // cwd rỗng → bắt đầu ở home (~); ngược lại cd về cwd đang track. shellCommand không tự giữ cwd.
    const prefix = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' 2>/dev/null; ` : `cd ~ 2>/dev/null; `;
    const wrapped = `${prefix}${userCmd}; printf '\\n__CWD__%s' "$(pwd)"`;
    const res = await trigger<{ output?: string }>(ref, "shell-command", { command: wrapped, environment_id: environmentId });
    let out = String(res?.output ?? "");
    const m = out.match(/\n?__CWD__(.*)$/s);
    if (m) { const np = m[1].trim(); if (track && np) setCwd(np); out = out.slice(0, m.index); }
    return out;
  }

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [lines, running, suggestions]);
  // Mở terminal: focus input sau khi animation xong
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 520);
    return () => clearTimeout(t);
  }, [open]);

  async function run() {
    const c = cmd.trim();
    if (!c || running) return;
    // clear/cls: xoá màn hình local, KHÔNG gửi remote
    if (c === "clear" || c === "cls") { setCmd(""); setSuggestions([]); setLines([]); return; }
    setCmd("");
    setSuggestions([]);
    setRunning(true);
    setLines((l) => [...l, { type: "cmd", text: c }]);
    try {
      const out = await sh(c);
      setLines((l) => [...l, { type: "out", text: out }]);
    } catch (e) {
      setLines((l) => [...l, { type: "err", text: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setRunning(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  // Tab-completion: liệt kê thư mục mục tiêu rồi lọc client-side (tránh glob shell — zsh
  // báo "no matches found" khi không khớp). Hỗ trợ cả zsh/bash.
  async function complete() {
    if (running || completing) return;
    const tokens = cmd.split(" ");
    const last = tokens[tokens.length - 1] ?? "";
    const slash = last.lastIndexOf("/");
    const dir = slash >= 0 ? last.slice(0, slash + 1) : "";    // "dev/crm/"
    const partial = slash >= 0 ? last.slice(slash + 1) : last;  // "sy"
    setCompleting(true);
    try {
      const target = dir ? `'${dir.replace(/'/g, "'\\''")}'` : ".";
      const out = await sh(`ls -1Ap ${target} 2>/dev/null | head -400`, false);
      const entries = out.split("\n").map((s) => s.trim()).filter((e) => e && e !== "./" && e !== "../");
      const matched = entries.filter((e) => e.startsWith(partial)).map((e) => dir + e);
      if (matched.length === 1) {
        tokens[tokens.length - 1] = matched[0];
        setCmd(tokens.join(" "));
        setSuggestions([]);
      } else if (matched.length > 1) {
        const cp = commonPrefix(matched);
        if (cp.length > last.length) { tokens[tokens.length - 1] = cp; setCmd(tokens.join(" ")); }
        setSuggestions(matched);
      } else {
        setSuggestions([]);
      }
    } catch { /* ignore */ }
    finally { setCompleting(false); inputRef.current?.focus(); }
  }

  function applySuggestion(s: string) {
    const tokens = cmd.split(" ");
    tokens[tokens.length - 1] = s;
    setCmd(tokens.join(" "));
    setSuggestions([]);
    inputRef.current?.focus();
  }

  return (
    <div className={`terminal-panel${open ? " open" : ""}`} aria-hidden={!open}>
      <div className="terminal-header">
        <span className="terminal-title"><TerminalIcon /> Terminal — remote{cwd ? <span className="terminal-cwd">{cwd}</span> : null}</span>
        <button className="terminal-close" onClick={onClose} title="Đóng">✕</button>
      </div>
      {/* Body kiểu terminal: output + dòng nhập INLINE ở cuối (không phải ô riêng) */}
      <div className="terminal-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {lines.length === 0 && <div className="term-line term-hint">Gửi lệnh trực tiếp tới máy remote. Phiên giữ cwd giữa các lệnh.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`term-line term-${l.type}`}>
            {l.type === "cmd" ? <span className="term-prompt">$ </span> : null}{l.text}
          </div>
        ))}
        {running && <div className="term-line term-out"><span className="inline-spinner compact" /> đang chạy…</div>}
        {suggestions.length > 1 && (
          <div className="term-suggestions">
            {suggestions.map((s, i) => (
              <span key={i} className="term-suggest" onClick={() => applySuggestion(s)}>
                {s.replace(/\/$/, "").split("/").pop()}{s.endsWith("/") ? "/" : ""}
              </span>
            ))}
          </div>
        )}
        {!running && (
          <div className="term-line term-input-line">
            <span className="term-prompt">$&nbsp;</span>
            <input
              ref={inputRef}
              className="terminal-inline-input"
              value={cmd}
              placeholder="nhập lệnh… (Tab để gợi ý)"
              onChange={(e) => { setCmd(e.target.value); if (suggestions.length) setSuggestions([]); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void run(); }
                else if (e.key === "Tab") { e.preventDefault(); void complete(); }
                else if (e.key === "Escape" && suggestions.length) { e.preventDefault(); e.stopPropagation(); setSuggestions([]); }
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <polyline points="4 6 6.5 8 4 10" />
      <line x1="8" y1="10.5" x2="11.5" y2="10.5" />
    </svg>
  );
}

function SendArrow() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="13" x2="8" y2="3" />
      <polyline points="3.5 7.5 8 3 12.5 7.5" />
    </svg>
  );
}
