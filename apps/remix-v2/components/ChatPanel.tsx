import { memo, useCallback, useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { useCollection, useObservable } from "@livequery/react";
import type { LivequeryDocument } from "@livequery/client";
import type { ChatDoc, TurnDoc } from "@codex/types";
import { useTrigger } from "@helpers/use-trigger";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useThemeValue } from "@helpers/use-theme";
import { ConfirmModal } from "./ConfirmModal";

// Prism style theo theme: light mode dùng oneLight (chữ tối/nền sáng), dark mode dùng oneDark.
function useCodeStyle() {
  return useThemeValue() === "light" ? oneLight : oneDark;
}

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
  const [open, setOpen] = useState(false);
  const codeStyle = useCodeStyle();
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
          style={codeStyle}
          customStyle={{ margin: 0, padding: "10px 12px", background: "transparent", fontSize: 12.5, lineHeight: 1.55, maxHeight: 420, maxWidth: "100%", overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }}
          wrapLongLines
        >
          {change.diff}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

function ExternalLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} target="_blank" rel="noreferrer noopener" />;
}

function CollapsibleCodeBlock({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const codeStyle = useCodeStyle();
  const raw = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "text";
  const lines = raw ? raw.split("\n").length : 0;
  return (
    <div className="md-code-block">
      <button className="md-code-head" onClick={() => setOpen((v) => !v)} type="button">
        <span className="md-code-lang">{lang}</span>
        <span className="md-code-lines">{lines} dòng</span>
        <span className="md-code-toggle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <SyntaxHighlighter
          language={lang}
          style={codeStyle}
          customStyle={{ margin: 0, padding: "10px 12px", background: "transparent", fontSize: 12.5, lineHeight: 1.55, maxHeight: 420, maxWidth: "100%", overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }}
          wrapLongLines
        >
          {raw}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

function MarkdownBody({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ExternalLink,
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, ...props }: any) => {
          const text = String(children ?? "");
          const isBlock = Boolean(className) || text.includes("\n");
          if (!isBlock) return <code className={className} {...props}>{children}</code>;
          return <CollapsibleCodeBlock className={className}>{children}</CollapsibleCodeBlock>;
        },
      }}
    >
      {children}
    </Markdown>
  );
}

function CollapsibleUserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const shouldCollapse = text.length > 700 || text.split("\n").length > 10;
  if (!shouldCollapse) return <span className="turn-text">{text}</span>;
  return (
    <span className="turn-text user-collapsible">
      <span className={open ? "" : "user-collapsed"}>{text}</span>
      <button className="show-more-btn" type="button" onClick={() => setOpen((v) => !v)}>
        {open ? "Show less" : "Show more"}
      </button>
    </span>
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

type ApprovalReq = {
  title: string;
  content: string;
  command?: string;
  requestKind?: "approval" | "option_picker";
  options?: string[];
  optionDescriptions?: string[];
  allowMultiple?: boolean;
  submitLabel?: string;
  skipLabel?: string;
  requiresInput?: boolean;
  approval_event?: unknown;
};

function getApprovalRequest(turn: TurnDoc): ApprovalReq | null {
  const outputItems = turn.output_items as Record<string, unknown>[];
  for (const item of outputItems) {
    if (
      item.type === "approval_request" ||
      item.type === "confirmation_request" ||
      item.type === "tool_approval" ||
      item.type === "approval" ||
      item.type === "option_picker" ||
      item.type === "elicitation"
    ) {
      const rawOpts = (item.options ?? item.choices) as unknown;
      const options = Array.isArray(rawOpts) ? rawOpts.map((o) => (typeof o === "string" ? o : String((o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.value ?? ""))).filter(Boolean) : undefined;
      const requiresInput = item.requiresInput === true || item.inputType === "text" || item.type === "elicitation";
      return {
        title: String(item.title ?? "Yêu cầu xác nhận"),
        content: String(item.content ?? item.command ?? item.description ?? item.message ?? "Cho phép hành động này?"),
        command: typeof item.command === "string" ? item.command : undefined,
        requestKind: item.type === "option_picker" ? "option_picker" : "approval",
        options,
        optionDescriptions: Array.isArray(item.optionDescriptions) ? item.optionDescriptions.map((d) => String(d)) : undefined,
        allowMultiple: item.allowMultiple === true,
        submitLabel: typeof item.submitLabel === "string" ? item.submitLabel : undefined,
        skipLabel: typeof item.skipLabel === "string" ? item.skipLabel : undefined,
        requiresInput,
        approval_event: item.approval_event,
      };
    }
  }
  return null;
}

function getPlanContent(turn: TurnDoc): string | null {
  for (const item of (turn.output_items as Record<string, unknown>[]) ?? []) {
    if (item?.type === "plan") {
      const content = String(item.content ?? item.text ?? item.planContent ?? "").trim();
      if (content) return content;
    }
    if (item?.type === "unsupported" && item.item_type === "plan") {
      const parsed = parseJsonObject(item.raw);
      const content = String(parsed?.content ?? parsed?.text ?? parsed?.planContent ?? "").trim();
      if (content) return content;
    }
  }
  return null;
}

function getContextCompactionLabel(turn: TurnDoc): string | null {
  if (turn.type === "context_compaction" || turn.type === "contextCompaction") return "Tối ưu context";
  for (const item of (turn.output_items as Record<string, unknown>[]) ?? []) {
    if (item?.type === "context_compaction" || item?.type === "contextCompaction") {
      return String(item.text ?? "Tối ưu context");
    }
    if (item?.type === "unsupported" && item.item_type === "contextCompaction") return "Tối ưu context";
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

function getFallbackUnsupported(turn: TurnDoc): { itemType: string; raw: string } | null {
  const outputItems = (turn.output_items as Record<string, unknown>[]) ?? [];
  const inputItems = (turn.input_items as Record<string, unknown>[]) ?? [];
  const item = outputItems[0] ?? inputItems[0];
  if (!item) return null;
  return {
    itemType: String(item.type ?? turn.type ?? "unknown"),
    raw: JSON.stringify({ type: turn.type, role: turn.role, input_items: inputItems, output_items: outputItems }, null, 2),
  };
}

type McpToolCall = {
  id?: string;
  server?: string;
  tool?: string;
  status?: string;
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  durationMs?: number;
};

type CommandExecutionTurn = {
  id?: string;
  command?: string;
  cwd?: string;
  processId?: string;
  source?: string;
  status?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  commandActions?: unknown[];
};

type CommandAction = {
  type?: string;
  command?: string;
  name?: string;
  path?: string;
};

type DocParagraph = {
  text?: string;
  namedStyleType?: string;
  isListItem?: boolean;
};

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getMcpToolCall(turn: TurnDoc): McpToolCall | null {
  for (const item of (turn.output_items as Record<string, unknown>[]) ?? []) {
    if (item?.type === "mcpToolCall") return item as McpToolCall;
    if (item?.type === "unsupported" && item.item_type === "mcpToolCall") {
      const parsed = parseJsonObject(item.raw);
      if (parsed?.type === "mcpToolCall") return parsed as McpToolCall;
    }
  }
  return null;
}

function getCommandExecution(turn: TurnDoc): CommandExecutionTurn | null {
  for (const item of (turn.output_items as Record<string, unknown>[]) ?? []) {
    if (item?.type === "commandExecution") return item as CommandExecutionTurn;
    if (item?.type === "unsupported" && item.item_type === "commandExecution") {
      const parsed = parseJsonObject(item.raw);
      if (parsed?.type === "commandExecution") return parsed as CommandExecutionTurn;
    }
  }
  return null;
}

function firstResultObject(result: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const structured = parseJsonObject(result?.structuredContent);
  if (structured) return structured;
  const content = result?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const obj = parseJsonObject((c as Record<string, unknown>)?.text);
      if (obj) return obj;
    }
  }
  return parseJsonObject(result);
}

function McpToolCallBlock({ call }: { call: McpToolCall }) {
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const result = firstResultObject(call.result);
  const title = typeof result?.title === "string" ? result.title : call.tool;
  const url = typeof result?.url === "string"
    ? result.url
    : (typeof result?.document_url === "string" ? result.document_url : undefined);
  const paragraphs = Array.isArray(result?.paragraphs) ? result.paragraphs as DocParagraph[] : [];
  const success = result?.success === true || call.status === "completed";
  return (
    <div className="turn turn-assistant">
      <div className={`mcp-card ${success ? "ok" : "warn"}`}>
        <div className="mcp-head">
          <span className="mcp-kind">MCP</span>
          <div className="mcp-title">
            <span>{call.server ?? "mcp"}</span>
            <strong>{call.tool ?? "tool call"}</strong>
          </div>
          <span className="mcp-status">{call.status ?? "unknown"}</span>
        </div>
        {title && <div className="mcp-doc-title">{title}</div>}
        {url && <a className="mcp-link" href={url} target="_blank" rel="noreferrer noopener">{url}</a>}
        <div className="mcp-meta">
          {typeof call.durationMs === "number" && <span>{Math.round(call.durationMs / 100) / 10}s</span>}
          {typeof result?.mimeType === "string" && <span>{result.mimeType}</span>}
          {typeof result?.fileId === "string" && <span>{result.fileId}</span>}
          {typeof result?.documentId === "string" && <span>{result.documentId}</span>}
          {paragraphs.length > 0 && <span>{paragraphs.length} paragraphs</span>}
        </div>
        {paragraphs.length > 0 && (
          <div className="mcp-doc-preview">
            {paragraphs.slice(0, 6).map((p, i) => (
              <div
                key={i}
                className={`mcp-doc-paragraph ${p.namedStyleType === "HEADING_1" ? "heading" : ""}${p.isListItem ? " list" : ""}`}
              >
                {p.text}
              </div>
            ))}
            {paragraphs.length > 6 && <div className="mcp-doc-more">+{paragraphs.length - 6} paragraphs</div>}
          </div>
        )}
        {call.error ? <div className="mcp-error">{String(call.error)}</div> : null}
        <div className="mcp-actions">
          {call.arguments && <button type="button" onClick={() => setArgsOpen((v) => !v)}>Arguments {argsOpen ? "▾" : "▸"}</button>}
          {call.result && <button type="button" onClick={() => setResultOpen((v) => !v)}>Result {resultOpen ? "▾" : "▸"}</button>}
        </div>
        {argsOpen && <pre className="mcp-raw">{JSON.stringify(call.arguments, null, 2)}</pre>}
        {resultOpen && <pre className="mcp-raw">{JSON.stringify(call.result, null, 2)}</pre>}
      </div>
    </div>
  );
}

function CommandExecutionBlock({ command }: { command: CommandExecutionTurn }) {
  const [open, setOpen] = useState(false);
  const codeStyle = useCodeStyle();
  const status = command.status ?? "unknown";
  const output = command.aggregatedOutput ?? "";
  const lines = output ? output.split("\n").length : 0;
  const actions = Array.isArray(command.commandActions) ? command.commandActions as CommandAction[] : [];
  return (
    <div className="turn turn-assistant">
      <div className={`cmd-card cmd-${status}`}>
        <button className="cmd-head" type="button" onClick={() => setOpen((v) => !v)}>
          <span className="cmd-kind">$</span>
          <span className="cmd-main" title={command.command}>{command.command ?? "command"}</span>
          <span className="cmd-status">{status}</span>
          <span className="cmd-toggle">{open ? "▾" : "▸"}</span>
        </button>
        <div className="cmd-meta">
          {command.cwd && <span title={command.cwd}>{command.cwd}</span>}
          {command.processId && <span>pid {command.processId}</span>}
          {typeof command.exitCode === "number" && <span>exit {command.exitCode}</span>}
          {output && <span>{lines} dòng</span>}
        </div>
        {actions.length > 0 && (
          <div className="cmd-actions">
            {actions.map((action, i) => (
              <div className="cmd-action" key={i}>
                <span className={`cmd-action-type cmd-action-${action.type ?? "unknown"}`}>{action.type ?? "unknown"}</span>
                <span className="cmd-action-name" title={action.path ?? action.command}>{action.name ?? action.path ?? action.command ?? "action"}</span>
                {action.path && <span className="cmd-action-path" title={action.path}>{action.path}</span>}
              </div>
            ))}
          </div>
        )}
        {open && output && (
          <SyntaxHighlighter
            language="diff"
            style={codeStyle}
            customStyle={{ margin: "8px 0 0", padding: "10px 12px", background: "transparent", fontSize: 12, lineHeight: 1.5, maxHeight: 360, overflow: "auto" }}
            wrapLongLines
          >
            {output}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}

function UnsupportedTurnBlock({ itemType, raw }: { itemType: string; raw: string }) {
  return (
    <div className="turn turn-assistant">
      <div className="turn-unsupported" title="Raw JSON để debug">
        <div>
          <span className="us-badge">⚙ {itemType}</span>
          <span className="us-note">kiểu turn chưa render</span>
        </div>
        <pre className="us-raw">{raw}</pre>
      </div>
    </div>
  );
}

function ApprovalTurnBlock({
  request, resolved, onChoose,
}: {
  request: ApprovalReq;
  resolved: boolean;
  onChoose: (decision: string, input?: string) => void;
}) {
  const [input, setInput] = useState("");
  const options = request.options?.length ? request.options : ["allow", "deny"];
  const isOptionPicker = request.requestKind === "option_picker";
  return (
    <div className="turn turn-assistant">
      <div className={`approval-card${resolved ? " resolved" : ""}`}>
        <div className="approval-head">
          <span className="approval-kind">{request.requiresInput ? "INPUT" : "CHOICE"}</span>
          <strong>{request.title}</strong>
          {resolved && <span className="approval-resolved">resolved</span>}
        </div>
        <div className="approval-content">{request.content}</div>
        {request.requiresInput ? (
          <div className="approval-input-row">
            <textarea
              className="approval-input"
              value={input}
              rows={3}
              disabled={resolved}
              placeholder="Nhập câu trả lời..."
              onChange={(e) => setInput(e.target.value)}
            />
            <button disabled={resolved || !input.trim()} onClick={() => onChoose("input", input.trim())}>Send</button>
          </div>
        ) : (
          <div className="approval-actions">
            {options.map((option, index) => {
              const normalized = option.toLowerCase();
              const decision = isOptionPicker ? "option" : (normalized === "deny" || normalized === "reject" ? "reject" : option);
              const description = request.optionDescriptions?.[index];
              return (
                <button
                  key={option}
                  disabled={resolved}
                  className={decision === "reject" ? "danger" : ""}
                  onClick={() => onChoose(decision, isOptionPicker ? option : undefined)}
                >
                  <span>{normalized === "allow" || normalized === "approve" ? "Allow" : normalized === "deny" || normalized === "reject" ? "Deny" : option}</span>
                  {description && <small>{description}</small>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanBlock({ content }: { content: string }) {
  return (
    <div className="turn turn-assistant">
      <div className="turn-bubble plan-bubble">
        <div className="plan-label">PLAN</div>
        <div className="markdown"><MarkdownBody>{content}</MarkdownBody></div>
      </div>
    </div>
  );
}

function ContextCompactionBlock({ label }: { label: string }) {
  return (
    <div className="turn turn-assistant">
      <div className="turn-bubble context-compaction-bubble">{label}</div>
    </div>
  );
}

function TurnRow({
  turnDoc, onImageClick, onApprovalDecision, onApprovalVisible, approvalResolved, chatNeedsConfirmation,
}: {
  turnDoc: LivequeryDocument<TurnDoc>;
  onImageClick: (src: string) => void;
  onApprovalDecision: (turnId: string, decision: string, input?: string) => void;
  onApprovalVisible: (turnId: string, request: ApprovalReq) => void;
  approvalResolved: boolean;
  chatNeedsConfirmation: boolean;
}) {
  const turn = useObservable(turnDoc);
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
  const mcpToolCall = getMcpToolCall(turn);
  const commandExecution = getCommandExecution(turn);
  const planContent = getPlanContent(turn);
  const contextCompaction = getContextCompactionLabel(turn);

  const approval = getApprovalRequest(turn);
  useEffect(() => {
    if (approval && chatNeedsConfirmation && !approvalResolved) {
      onApprovalVisible(turn.id, approval);
    }
  }, [approval, approvalResolved, chatNeedsConfirmation, onApprovalVisible, turn.id]);
  if (planContent) return <PlanBlock content={planContent} />;
  if (contextCompaction) return <ContextCompactionBlock label={contextCompaction} />;

  if (approval) {
    return (
      <ApprovalTurnBlock
        request={approval}
        resolved={approvalResolved}
        onChoose={(decision, input) => onApprovalDecision(turn.id, decision, input)}
      />
    );
  }

  // Thay đổi file → render code có syntax highlight theo extension.
  if (fileChanges.length > 0) return <FileChangeBlock changes={fileChanges} />;

  if (mcpToolCall) return <McpToolCallBlock call={mcpToolCall} />;
  if (commandExecution) return <CommandExecutionBlock command={commandExecution} />;

  // Marker kiểu chưa hỗ trợ do backend đã đóng gói rõ ràng.
  if (unsupported) {
    return <UnsupportedTurnBlock itemType={unsupported.itemType} raw={unsupported.raw} />;
  }

  if (imgs.length > 0) {
    return (
      <div className={`turn ${isUser ? "turn-user" : "turn-assistant"}`}>
        <div className="turn-bubble">
          {text && (isUser ? <CollapsibleUserText text={text} /> : <div className="markdown"><MarkdownBody>{text}</MarkdownBody></div>)}
          <div className="turn-images">
            {imgs.map((im, i) => im.src
              ? <img key={i} className="turn-image" src={im.src} alt="" onClick={() => onImageClick(im.src!)} />
              : <span key={i} className="turn-image-missing">🖼 ảnh trên remote: {im.path ?? "?"}</span>)}
          </div>
        </div>
      </div>
    );
  }

  if (!text && !isStreaming) {
    const fallbackUnsupported = getFallbackUnsupported(turn);
    if (fallbackUnsupported) {
      return <UnsupportedTurnBlock itemType={fallbackUnsupported.itemType} raw={fallbackUnsupported.raw} />;
    }
    return null;
  }
  return (
    <div className={`turn ${isUser ? "turn-user" : "turn-assistant"}`}>
      <div className="turn-bubble">
        {text
          ? (isUser
              ? <CollapsibleUserText text={text} />
              : <div className="markdown"><MarkdownBody>{text}</MarkdownBody></div>)
          : <span className="streaming-dot" />}
        {isStreaming && text && <span className="streaming-dot" />}
      </div>
    </div>
  );
}

// seenIds = tập id turn có sẵn LÚC bấm gửi → chỉ coi là "turn thật đã về" khi xuất hiện turn user
// MỚI (id không nằm trong seenIds) khớp nội dung. Tránh khớp nhầm tin cũ trùng nội dung.
type PendingUserMsg = { id: string; text: string; seenIds: Set<string> };

/**
 * Sticky auto-scroll: CHỈ tự cuộn khi người dùng đang ở đáy. Cuộn lên xem lại lịch sử sẽ "thả neo"
 * (không bị kéo xuống); cuộn về đáy thì auto-scroll bật lại. MutationObserver bắt cả turn mới LẪN
 * token streaming (text node đổi) → pin mượt khi đang stream. resetKey (chatId) đổi → về đáy.
 */
function useStickyScroll(ref: React.RefObject<HTMLElement | null>, resetKey: unknown) {
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    const THRESHOLD = 80; // px cách đáy vẫn coi là "ở đáy"
    const pin = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD; };
    // Lăn chuột LÊN → tắt auto-scroll NGAY (chặn pin() của delta kế tiếp đè lại). Lăn xuống tới đáy → onScroll bật lại.
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) stick.current = false; };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    const mo = new MutationObserver(pin);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    requestAnimationFrame(pin);
    return () => { el.removeEventListener("scroll", onScroll); el.removeEventListener("wheel", onWheel); mo.disconnect(); };
  }, [ref, resetKey]);
}

export type ChatPanelProps = {
  accountId: string;
  chatId: string | null;
  environmentId?: string;
  cwd?: string;
  onChatCreated?: (chatId: string) => void;
  onScrolledUpChange?: (scrolled: boolean) => void;
};

export function ChatPanel({ accountId, chatId, environmentId, cwd, onChatCreated, onScrolledUpChange }: ChatPanelProps) {
  const [sending, setSending] = useState(false);
  const [pendingMsg, setPendingMsg] = useState<PendingUserMsg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvedConfirms, setResolvedConfirms] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<(ApprovalReq & { turnId: string }) | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [composerHeight, setComposerHeight] = useState(92);
  const listRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const trigger = useTrigger();

  useStickyScroll(listRef, chatId);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => setShowScrollBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 140);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [chatId]);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowScrollBottom(false);
  }, []);

  useEffect(() => {
    onScrolledUpChange?.(showScrollBottom);
    return () => onScrolledUpChange?.(false);
  }, [onScrolledUpChange, showScrollBottom]);

  useEffect(() => {
    const el = composerShellRef.current;
    if (!el) return;
    const update = () => setComposerHeight(Math.ceil(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selfhostId = environmentId?.startsWith("selfhost:") ? environmentId.slice(9) : null;
  const chatRef = chatId
    ? (selfhostId ? `accounts/${accountId}/hosts/${selfhostId}/chats/${chatId}` : `accounts/${accountId}/chats/${chatId}`)
    : null;
  const chatsRef = chatId
    ? (selfhostId ? `accounts/${accountId}/hosts/${selfhostId}/chats` : `accounts/${accountId}/chats`)
    : null;
  const chatsCollection = useCollection<ChatDoc>(
    chatsRef,
    { mode: "server-first", filters: { "created_at:sort": "asc" } as any }
  );
  const chatDocs = useObservable(chatsCollection.items, []) as LivequeryDocument<ChatDoc>[];
  const selectedChat = chatId ? chatDocs.find((doc) => doc.getValue().id === chatId)?.getValue() : undefined;
  const chatNeedsConfirmation = selectedChat?.status === "needs_response";
  const turnsKey = chatRef ? `${chatRef}/turns` : null;
  // ref null → useCollection bỏ qua (không query), tránh GET rác `__none__` → 404
  const turnsCollection = useCollection<TurnDoc>(
    turnsKey,
    { mode: "server-first", filters: { "created_at:sort": "asc" } as any }
  );
  const turnDocs = useObservable(turnsCollection.items, []) as LivequeryDocument<TurnDoc>[];
  const turnsLoading = useObservable(turnsCollection.loading, null);

  const openApprovalModal = useCallback((turnId: string, approval: ApprovalReq) => {
    if (resolvedConfirms.has(turnId)) return;
    setConfirm((current) => current?.turnId === turnId ? current : { ...approval, turnId });
  }, [resolvedConfirms]);

  useEffect(() => {
    if (!chatId || turnsLoading) {
      if (confirm) setConfirm(null);
      return;
    }
    if (confirm && resolvedConfirms.has(confirm.turnId)) {
      setConfirm(null);
      return;
    }
    for (let i = turnDocs.length - 1; i >= 0; i--) {
      const doc = turnDocs[i];
      const turn = doc.getValue();
      if (turn.status === "completed" || turn.status === "resolved") continue;
      const approval = getApprovalRequest(turn);
      if (approval && !resolvedConfirms.has(turn.id)) {
        openApprovalModal(turn.id, approval);
        return;
      }
    }
    if (confirm) setConfirm(null);
  }, [chatId, confirm, openApprovalModal, resolvedConfirms, turnDocs, turnsLoading]);

  async function respondConfirm(turnId: string, decision: string, input?: string) {
    const currentConfirm = confirm;
    setResolvedConfirms((prev) => new Set(prev).add(turnId)); // chốt ngay để không hiện lại
    setConfirm(null);
    if (!chatId) return;
    try {
      await trigger(chatRef ?? `accounts/${accountId}/chats/${chatId}`, "approve-action", { turn_id: turnId, decision, input, approval_event: currentConfirm?.approval_event });
    } catch (e) {
      setResolvedConfirms((prev) => {
        const next = new Set(prev);
        next.delete(turnId);
        return next;
      });
      if (currentConfirm?.turnId === turnId) setConfirm(currentConfirm);
      setError(e instanceof Error ? e.message : "Không gửi được quyết định");
    }
  }

  // turnDocs qua ref để sendMessage giữ identity ổn định (không re-render Composer mỗi update realtime).
  const turnDocsRef = useRef(turnDocs);
  turnDocsRef.current = turnDocs;

  // Turn user/steer khớp nội dung pending đã về → xoá state pending.
  // Server đôi khi replay/merge id không đúng snapshot, nên ưu tiên chống duplicate theo text.
  const realUserTurnArrived = (pm: PendingUserMsg) =>
    turnDocs.some((d) => {
      const v = d.getValue();
      return v.role === "user" && extractTurnText(v).trim() === pm.text.trim();
    });
  useEffect(() => {
    if (pendingMsg && realUserTurnArrived(pendingMsg)) setPendingMsg(null);
  }, [turnDocs, pendingMsg]);
  // Bubble optimistic chỉ hiện khi turn thật CHƯA xuất hiện → không bị nhấp đúp 1 nhịp.
  const pendingShown = pendingMsg && !realUserTurnArrived(pendingMsg);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) setShowScrollBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 140);
    });
    return () => cancelAnimationFrame(id);
  }, [turnDocs.length, pendingShown, confirm]);

  // Gửi message. KHÔNG tự xoá input — Composer tự clear khi resolve; throw lại để Composer giữ text retry.
  const sendMessage = useCallback(
    async (msgText: string, imgs: { data: string; mimeType: string }[], mode: "remote" | "steer" = "remote") => {
      if (!msgText && imgs.length === 0) return;
      // Snapshot id turn hiện có → phân biệt turn user MỚI với tin cũ trùng nội dung.
      const seenIds = new Set(turnDocsRef.current.map((d) => d.getValue().id));
      setSending(true);
      setError(null);
      try {
        if (!chatId) {
          const ref = selfhostId ? `accounts/${accountId}/hosts/${selfhostId}` : `accounts/${accountId}`;
          const body = selfhostId
            ? { input: msgText, images: imgs, cwd }
            : { input: msgText, images: imgs, environment_id: environmentId };
          const data = await trigger<{ chat_id?: string }>(ref, "create-chat", body);
          const newChatId = data?.chat_id;
          if (!newChatId) throw new Error("No chat_id returned");
          setPendingMsg({ id: randomUUID(), text: msgText, seenIds });
          onChatCreated?.(newChatId);
        } else {
          // Chỉ gọi action send-message — backend gửi tới remote, POLLER realtime tự publish turn
          // (user + phản hồi agent). KHÔNG query/fetch lại để tránh reset collection (mất lịch sử).
          await trigger(chatRef ?? `accounts/${accountId}/chats/${chatId}`, "send-message", { input: msgText, images: imgs, environment_id: environmentId, mode });
          setPendingMsg({ id: randomUUID(), text: msgText, seenIds }); // optimistic, tự xoá khi turn thật về
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to send");
        throw e; // Composer giữ nội dung để gửi lại
      } finally {
        setSending(false);
      }
    },
    [accountId, chatId, chatRef, cwd, environmentId, selfhostId, trigger, onChatCreated]
  );

  const handleCancel = useCallback(async () => {
    if (!chatId) return;
    await trigger(chatRef ?? `accounts/${accountId}/chats/${chatId}`, "cancel-chat").catch(() => {});
  }, [accountId, chatId, chatRef, trigger]);

  const toggleTerminal = useCallback(() => setTerminalOpen((v) => !v), []);

  const working = turnDocs.some((d) => d.getValue().status === "in_progress");
  const isStreaming = working || sending;

  return (
    <div className="chat-panel">
      <div className="chat-island">
      <div className="turn-list" ref={listRef}>
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
        {turnDocs.map((doc) => {
          const turn = doc.getValue();
          if (getApprovalRequest(turn) && !getPlanContent(turn)) return null;
          const id = turn.id;
          return (
            <TurnRow
              key={id}
              turnDoc={doc}
              onImageClick={setLightbox}
              approvalResolved={resolvedConfirms.has(id)}
              chatNeedsConfirmation={chatNeedsConfirmation}
              onApprovalVisible={openApprovalModal}
              onApprovalDecision={(turnId, decision, inputText) => { void respondConfirm(turnId, decision, inputText); }}
            />
          );
        })}
        {pendingShown && (
          <div className="turn turn-user">
            <div className="turn-bubble"><CollapsibleUserText text={pendingMsg!.text} /></div>
          </div>
        )}
        {confirm && (
          <ApprovalTurnBlock
            request={confirm}
            resolved={resolvedConfirms.has(confirm.turnId)}
            onChoose={(decision, inputText) => { void respondConfirm(confirm.turnId, decision, inputText); }}
          />
        )}
      </div>

      {error && <div className="chat-error">{error}</div>}

      {showScrollBottom && (
        <button className="scroll-bottom-btn" style={{ bottom: composerHeight + 10 }} type="button" onClick={scrollToBottom} title="Cuộn xuống cuối">
          <ChevronDownIcon />
        </button>
      )}

      <div className="composer-shell" ref={composerShellRef}>
        <Composer
          chatId={chatId}
          sending={sending}
          working={working}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onSend={sendMessage}
          onCancel={handleCancel}
        />
      </div>
      </div>

      <TerminalPanel
        open={terminalOpen}
        accountId={accountId}
        chatId={chatId}
        environmentId={environmentId}
        onClose={() => setTerminalOpen(false)}
      />

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          content={confirm.content}
          command={confirm.command}
          requestKind={confirm.requestKind}
          options={confirm.options}
          optionDescriptions={confirm.optionDescriptions}
          allowMultiple={confirm.allowMultiple}
          submitLabel={confirm.submitLabel}
          skipLabel={confirm.skipLabel}
          requiresInput={confirm.requiresInput}
          onChoose={(decision, inputText) => { void respondConfirm(confirm.turnId, decision, inputText); }}
          onCancel={() => { void respondConfirm(confirm.turnId, "reject"); }}
        />
      )}

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/**
 * Composer tách riêng + memo: GIỮ `input` cục bộ ⇒ gõ phím KHÔNG re-render turn list (hết lag).
 * Parent chỉ re-render Composer khi sending/isStreaming/terminalOpen/chatId đổi (hiếm).
 * onSend/onCancel/onToggleTerminal phải stable (useCallback ở parent) để memo có hiệu lực.
 */
const Composer = memo(function Composer({
  chatId, sending, working, terminalOpen, onToggleTerminal, onSend, onCancel,
}: {
  chatId: string | null;
  sending: boolean;
  working: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onSend: (text: string, images: { data: string; mimeType: string }[], mode?: "remote" | "steer") => Promise<void>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<{ dataUrl: string; mimeType: string }[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pursueGoal, setPursueGoal] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }
  useEffect(() => { autoGrow(); }, [input]);

  function addImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setImages((prev) => [...prev, { dataUrl: String(reader.result), mimeType: file.type }]);
    reader.readAsDataURL(file);
  }

  function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) {
      if (f.type.startsWith("image/")) addImageFile(f);
      else setAttachments((prev) => [...prev, f.name]);
    }
    e.target.value = "";
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

  async function submit(mode: "remote" | "steer" = "remote") {
    const text = input.trim();
    if ((!text && images.length === 0) || sending) return;
    const imgs = images.map((i) => ({ data: i.dataUrl.split(",")[1] ?? "", mimeType: i.mimeType }));
    try {
      await onSend(text, imgs, mode);
      setInput(""); setImages([]); setAttachments([]); // chỉ clear khi gửi thành công
    } catch { /* lỗi → giữ nội dung để gửi lại */ }
  }

  function removePendingMessage() {
    setInput("");
    setImages([]);
    setAttachments([]);
    textareaRef.current?.focus();
  }

  const slashMatches = input.startsWith("/") && !input.includes(" ")
    ? SLASH_COMMANDS.filter((s) => s.cmd.startsWith(input.toLowerCase()))
    : [];
  function pickSlash(cmd: string) {
    setInput(cmd + " ");
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      const isMobileKeyboard = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
      if (isMobileKeyboard) return;
      // Đang mở slash menu → Enter chọn lệnh đầu tiên thay vì gửi
      if (input.startsWith("/") && !input.includes(" ")) {
        const m = SLASH_COMMANDS.filter((s) => s.cmd.startsWith(input.toLowerCase()));
        if (m.length > 0) { e.preventDefault(); pickSlash(m[0].cmd); return; }
      }
      e.preventDefault();
      void submit();
    }
  }

  return (
    <>
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

      {(working || sending) && (
        <div className="thinking-bar">
          <span className="thinking-spinner" title="Đang xử lý" />
        </div>
      )}

      {working && input.trim() && (
        <div className="pending-message-bar">
          <div className="pending-message-copy">
            <span className="pending-message-label">Pending message</span>
            <span className="pending-message-text">{input.trim()}</span>
          </div>
          <div className="pending-message-actions">
            <button type="button" onClick={() => void submit("steer")} disabled={sending || !chatId}>Steer</button>
            <button type="button" onClick={removePendingMessage} disabled={sending}>Delete</button>
          </div>
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
          <div className="composer-add-wrap">
            <button
              className={`composer-add${toolsOpen ? " active" : ""}`}
              title="Công cụ"
              onClick={() => setToolsOpen((v) => !v)}
              type="button"
            >
              +
            </button>
            {toolsOpen && (
              <div className="composer-menu">
                <button
                  className="composer-menu-item"
                  type="button"
                  onClick={() => { setToolsOpen(false); fileInputRef.current?.click(); }}
                >
                  <span className="cmi-icon">↥</span>
                  <span>Upload</span>
                </button>
                <button
                  className={`composer-menu-item toggle${pursueGoal ? " on" : ""}`}
                  type="button"
                  onClick={() => setPursueGoal((v) => !v)}
                >
                  <span className="cmi-icon">🎯</span>
                  <span>Goal</span>
                </button>
                <button
                  className={`composer-menu-item toggle${planMode ? " on" : ""}`}
                  type="button"
                  onClick={() => setPlanMode((v) => !v)}
                >
                  <span className="cmi-icon">▤</span>
                  <span>Plan</span>
                </button>
                <button className="composer-menu-item" type="button" disabled>
                  <span className="cmi-icon">◫</span>
                  <span>Plugin</span>
                  <span className="soon">soon</span>
                </button>
                <button
                  className={`composer-menu-item toggle${terminalOpen ? " on" : ""}`}
                  type="button"
                  onClick={() => { setToolsOpen(false); onToggleTerminal(); }}
                >
                  <span className="cmi-icon"><TerminalIcon /></span>
                  <span>Terminal</span>
                </button>
              </div>
            )}
          </div>
          <div className="composer-spacer" />
          {working && chatId && (
            <button className="composer-stop" onClick={() => void onCancel()} title="Dừng">■</button>
          )}
          <button
            className="composer-send"
            disabled={(!input.trim() && images.length === 0) || sending}
            onClick={() => void submit("remote")}
            title="Gửi"
          >
            {sending ? <span className="inline-spinner compact" /> : <SendArrow />}
          </button>
        </div>
        <input ref={fileInputRef} type="file" multiple hidden onChange={onFilesSelected} />
      </div>
    </>
  );
});

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
    <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="13" x2="8" y2="3" />
      <polyline points="3.5 7.5 8 3 12.5 7.5" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}
