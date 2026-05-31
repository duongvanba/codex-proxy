/**
 * WebsocketRelay — manages a single WebSocket connection to OpenAI's remote relay.
 *
 * Protocol:
 *   connect → device_key_challenge → device_key_proof → initialize → ready
 *   send:  { type:"client_message", client_id, seq_id, env_id, stream_id, skip_history, message:{id,method,params} }
 *   recv:  { type:"server_message", message:{id,result|error} }    — RPC response
 *          { type:"server_message", message:{method,params} }      — server notification (no id)
 *          { type:"ack", ... }
 *
 * NOTE: NO "jsonrpc":"2.0" field in message payloads.
 *       stream_id is a single UUID per connection (not per-request).
 *       "initialize" MUST be the first request after challenge-response — connect() handles this.
 *       connect() = 1 pipeline RxJS trả về subscription; trạng thái phát qua `status$`
 *       (action chờ "ready" trước khi gửi); close() chỉ unsubscribe.
 */

import { BehaviorSubject, Subject, Subscription, of, merge, fromEvent, timer, throwError, firstValueFrom, switchMap, tap, map, filter, finalize, retry } from "rxjs";
import { ChatGPTClient } from "../chatgpt";
import type { Account } from "../../schemas";
import type {
  RCEnrollment,
  DeviceKeyChallenge,
  PendingRequest,
  RelayEvent,
  RelayStatus,
} from "./types";
import { signChallenge } from "./crypto";

const RC_WS_URL = "wss://chatgpt.com/backend-api/codex/remote/control/client";
const PROTOCOL_VERSION = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export class WebsocketRelay {
  private ws: WebSocket | null = null;
  private seqId = 0;
  private streamId = crypto.randomUUID();

  // Kết nối hiện hành: subscription của pipeline rxjs. close() unsubscribe để huỷ.
  private subscription?: Subscription;
  /** Trạng thái kết nối (công khai). Action chờ `status$.value === "ready"` trước khi gửi. */
  readonly status$ = new BehaviorSubject<RelayStatus>("idle");
  #lastError?: Error;   // lỗi mở kết nối lần đầu (để whenReady() ném đúng lỗi gốc)

  private pending = new Map<string, PendingRequest>();
  /** MỌI notification của relay (mọi host) đổ về đây. Service khởi tạo kết nối subscribe `event$`
   *  rồi demux theo envId/threadId để publish vào ref livequery tương ứng. */
  readonly event$ = new Subject<RelayEvent>();
  private readonly chats$ = new Map<string, Subject<RelayEvent>>(); // threadId → event của chat (lọc sẵn cho shellCommand)
  private chunkBuffers = new Map<string, { count: number; parts: Map<number, string> }>();
  private turnStreamLock = new Map<string, string>(); // turnId → stream_id (chống echo đa-stream của relay)
  /** Thread do relay tự tạo để chạy shell command (không phải chat hội thoại) — consumer lọc khỏi danh sách chat. */
  readonly shellThreadIds = new Set<string>();

  constructor(
    private account: Account,
    private enrollment: RCEnrollment,
    readonly envId: string,
  ) {}

  // ─── Connection ───────────────────────────────────────────────────────────────

  /**
   * Mở kết nối bằng MỘT pipeline RxJS và TRẢ VỀ subscription:
   *   of(new WebSocket) → switchMap(socket → merge(message$, error$, close$)) → retry(backoff) → finalize(close socket)
   * Toàn bộ logic kết nối / lắng nghe event / reconnect nằm ở đây. close() chỉ cần `subscription.unsubscribe()`.
   */
  connect(): Subscription {
    if (this.subscription && !this.subscription.closed) return this.subscription;
    let everConnected = false;   // cục bộ trong connect() — chỉ dùng cho vòng đời kết nối này
    this.#lastError = undefined;
    this.status$.next("connecting");

    this.subscription = of(1)                                                    // 1. of(1) kích hoạt
      .pipe(
        switchMap(() => {                                                        // 2. switchMap(() => new WebSocket) + merge lắng nghe
          // new WebSocket — lazy mỗi (re)subscribe ⇒ retry tạo socket tươi (header auth + stream_id mới).
          this.streamId = crypto.randomUUID();
          const headers = ChatGPTClient.buildWebSocketHeaders(undefined, this.account);
          headers["x-codex-client-session-token"] = `Bearer ${this.enrollment.token}`;
          headers["x-codex-client-id"] = this.enrollment.clientId;
          headers["x-codex-protocol-version"] = String(PROTOCOL_VERSION);
          // @ts-ignore Bun extension: headers
          const socket: WebSocket = new WebSocket(RC_WS_URL, { headers });
          this.ws = socket;
          let ready = false;
          let challengeTimeout: ReturnType<typeof setTimeout>;
          const handshakeError$ = new Subject<never>();   // kênh đẩy lỗi handshake (mismatch / init) vào stream
          const markReady = () => {
            if (ready) return;
            ready = true; clearTimeout(challengeTimeout);
            this.ws = socket; everConnected = true; this.status$.next("ready");
          };
          challengeTimeout = setTimeout(() => { console.warn(`[rc:${this.account.email}] No challenge, assuming ready`); markReady(); }, 10_000);

          const onMessage = (ev: MessageEvent) => {
            const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(raw); } catch { return; }
            if (!ready && msg.type === "device_key_challenge") {
              clearTimeout(challengeTimeout);
              const challenge = msg as unknown as DeviceKeyChallenge;
              if (challenge.clientId !== this.enrollment.clientId) {
                handshakeError$.error(new Error(`[rc] clientId mismatch: expected=${this.enrollment.clientId} got=${challenge.clientId}`));
                return;
              }
              signChallenge(challenge, this.enrollment)
                .then(async (proof) => {
                  socket.send(JSON.stringify(proof));
                  console.log(`[rc:${this.account.email}] device_key_proof sent`);
                  this.ws = socket;
                  await this.#sendOn(socket, "initialize", { clientInfo: { name: "codex-proxy", version: "1.0.0" }, capabilities: { experimentalApi: true } }, this.envId);
                  console.log(`[rc:${this.account.email}] initialized`);
                  markReady();
                })
                .catch((e) => handshakeError$.error(e instanceof Error ? e : new Error(String(e))));   // handshake lỗi → error stream → retry/closed
              return;
            }
            this.#handleMessage(msg);   // response init (chưa ready) hoặc notification (đã ready)
          };

          console.log(`[rc:${this.account.email}] WS connecting...`);
          return merge(
            fromEvent<MessageEvent>(socket as unknown as EventTarget, "message").pipe(tap(onMessage)),
            fromEvent<Event>(socket as unknown as EventTarget, "error").pipe(map(() => { throw new Error("[rc] WS error"); })),
            fromEvent<CloseEvent>(socket as unknown as EventTarget, "close").pipe(map((e) => {
              this.#rejectAll(new Error("Remote control disconnected"));
              throw new Error(ready ? `WS closed: ${e.code}` : `WS closed before ready: ${e.code} ${e.reason ?? ""}`);
            })),
            handshakeError$,
          ).pipe(
            finalize(() => { try { socket.close(); } catch {} if (this.ws === socket) this.ws = null; }),  // 3. finalize đóng socket khi ngắt
          );
        }),
        retry({ delay: (err, n) => {                                             // tự reconnect; mở lần đầu lỗi → dừng (status=closed)
          if (!everConnected) { this.#lastError = err instanceof Error ? err : new Error(String(err)); this.status$.next("closed"); return throwError(() => err); }
          this.status$.next("connecting");
          const ms = Math.min(30_000, 1000 * 2 ** (n - 1));
          console.log(`[rc:${this.account.email}] reconnect sau ${ms}ms (lần ${n})`);
          return timer(ms);
        } }),
      )
      .subscribe({ error: () => { this.subscription = undefined; } });

    return this.subscription;                                                    // 4. trả về subscription để .unsubscribe()
  }

  /** Chờ `status$` = "ready" (resolve) / "closed" (reject). Mọi action gọi trước khi gửi.
   *  BehaviorSubject phát lại value hiện tại khi subscribe → "ready" sẵn cũng resolve ngay. */
  whenReady(): Promise<void> {
    return firstValueFrom(this.status$.pipe(
      filter((s) => s === "ready" || s === "closed"),
      map((s) => { if (s !== "ready") throw this.#lastError ?? new Error("[rc] connection closed"); }),
    ));
  }

  #sendOn(ws: WebSocket, method: string, params: Record<string, unknown>, envId: string): Promise<unknown> {
    const id = crypto.randomUUID();
    const seqId = ++this.seqId;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[rc] request timeout (${REQUEST_TIMEOUT_MS}ms): ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeoutId });

      ws.send(JSON.stringify({
        type: "client_message",
        client_id: this.enrollment.clientId,
        seq_id: seqId,
        env_id: envId,            // host đích cho frame này (1 connection phục vụ nhiều host)
        stream_id: this.streamId,
        skip_history: false,
        message: { id, method, params },
      }));
    });
  }

  #handleMessage(msg: Record<string, unknown>) {
    if (msg.type === "ack") return;
    // Message lớn được chia thành server_message_chunk (base64) — ghép lại theo segment_id.
    if (msg.type === "server_message_chunk") {
      const key = `${String(msg.env_id)}:${String(msg.stream_id)}:${String(msg.seq_id)}`;
      const count = Number(msg.segment_count);
      let buf = this.chunkBuffers.get(key);
      if (!buf) { buf = { count, parts: new Map() }; this.chunkBuffers.set(key, buf); }
      buf.parts.set(Number(msg.segment_id), String(msg.message_chunk_base64 ?? ""));
      if (buf.parts.size >= buf.count) {
        this.chunkBuffers.delete(key);
        try {
          const ordered: Buffer[] = [];
          for (let i = 0; i < buf.count; i++) ordered.push(Buffer.from(buf.parts.get(i) ?? "", "base64"));
          const full = Buffer.concat(ordered).toString("utf8");
          const message = JSON.parse(full);
          this.#handleMessage({ type: "server_message", client_id: msg.client_id, stream_id: msg.stream_id, seq_id: msg.seq_id, env_id: msg.env_id, message });
        } catch { /* chunk hỏng — bỏ qua */ }
      }
      return;
    }

    if (msg.type === "server_message") {
      const rpcMsg = msg.message as Record<string, unknown> | undefined;
      const id = rpcMsg?.id as string | undefined;

      if (!id) {
        const method = rpcMsg?.method as string | undefined ?? "";
        const params = (rpcMsg?.params ?? {}) as Record<string, unknown>;
        // Relay echo event của 1 turn trên NHIỀU stream (host/mobile/proxy...). Khoá mỗi
        // turnId vào stream đầu tiên thấy nó → bỏ qua các stream khác (chống nhân đôi delta).
        const turnId = (params.turnId
          ?? (params.turn as Record<string, unknown> | undefined)?.id
          ?? (params.item as Record<string, unknown> | undefined)?.turnId) as string | undefined;
        const streamId = String(msg.stream_id ?? "");
        if (turnId && streamId) {
          const locked = this.turnStreamLock.get(turnId);
          if (!locked) this.turnStreamLock.set(turnId, streamId);
          else if (locked !== streamId) return; // stream khác cho cùng turn → drop
        }
        // event$ = kênh chung (subscriber demux); chats$ = kênh đã lọc theo threadId (shellCommand).
        const ev: RelayEvent = { method, params, envId: String(msg.env_id ?? "") };
        this.event$.next(ev);
        const threadId = String(params.threadId ?? "");
        if (threadId) this.chats$.get(threadId)?.next(ev);
        return;
      }

      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timeoutId);
      if (rpcMsg?.error) {
        const errMsg = (rpcMsg.error as Record<string, unknown>)?.message ?? JSON.stringify(rpcMsg.error);
        p.reject(new Error(String(errMsg)));
      } else {
        p.resolve(rpcMsg?.result ?? rpcMsg);
      }
    }
  }

  #rejectAll(err: Error) {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timeoutId);
      p.reject(err);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /** Gửi 1 RPC tới host `envId` (mặc định = host handshake). Mọi action truyền host id của mình vào. */
  async request(method: string, params: Record<string, unknown> = {}, envId: string = this.envId): Promise<unknown> {
    this.connect();
    await this.whenReady();   // đợi status$ = "ready" trước khi gửi
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("[rc] WebSocket not open");
    return this.#sendOn(ws, method, params, envId);
  }

  // ─── Event subjects (lắng nghe = subscribe) ─────────────────────────────────────

  /** Subject sự kiện của 1 chat (theo threadId) — tạo lazy, dùng lại nếu đã có. Dùng cho shellCommand. */
  chatEvents(threadId: string): Subject<RelayEvent> {
    let s = this.chats$.get(threadId);
    if (!s) { s = new Subject<RelayEvent>(); this.chats$.set(threadId, s); }
    return s;
  }

  // ─── Thread management ────────────────────────────────────────────────────────

  async sendMessage(
    text: string,
    opts?: {
      threadId?: string;
      workspaceRoot?: string;
      model?: string;
      approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "granular" | "never";
      images?: { data: string; mimeType: string }[];
      envId?: string;
    }
  ): Promise<{ threadId: string; turnId: string }> {
    const input: unknown[] = [];
    if (text) input.push({ type: "text", text, text_elements: [] });
    // Ảnh đính kèm: gửi inline base64 (định dạng input item Codex hỗ trợ).
    for (const img of opts?.images ?? []) input.push({ type: "image", data: img.data, mimeType: img.mimeType });
    const params: Record<string, unknown> = {
      threadId: opts?.threadId ?? null,
      input,
      cwd: opts?.workspaceRoot ?? null,
      model: opts?.model ?? null,
      approvalPolicy: opts?.approvalPolicy ?? "on-request",
      approvalsReviewer: null,
      sandboxPolicy: null,
      collaborationMode: null,
      personality: null,
      outputSchema: null,
      summary: null,
      effort: null,
      serviceTier: null,
    };
    // Thread có sẵn → turn/start (gửi message vào thread; thread/resume chỉ LOAD chứ không submit).
    // Thread mới → thread/start (tạo thread kèm turn đầu).
    if (opts?.threadId) {
      // đảm bảo thread đã được load trước khi mở turn mới
      await this.request("thread/resume", { threadId: opts.threadId }, opts?.envId).catch(() => {});
    }
    const method = opts?.threadId ? "turn/start" : "thread/start";
    const result = (await this.request(method, params, opts?.envId)) as Record<string, unknown>;
    const thread = result?.thread as Record<string, unknown> | undefined;
    const turn = result?.turn as Record<string, unknown> | undefined;
    const threadId = String(thread?.id ?? result?.threadId ?? result?.conversationId ?? opts?.threadId ?? "");
    const turnId = String(turn?.id ?? result?.turnId ?? "");
    return { threadId, turnId };
  }

  async shellCommand(
    command: string,
    opts?: {
      threadId?: string;
      cwd?: string;
      onDelta?: (delta: string) => void;
      timeout?: number;
      envId?: string;
    }
  ): Promise<{ output: string; exitCode: number; threadId: string }> {
    this.connect();
    await this.whenReady();

    let threadId = opts?.threadId;
    if (!threadId) {
      const result = (await this.request("thread/start", {
        threadId: null, input: [], cwd: opts?.cwd ?? null, model: null,
        approvalPolicy: "never", approvalsReviewer: null, sandboxPolicy: null,
        collaborationMode: null, personality: null, outputSchema: null,
        summary: null, effort: null, serviceTier: null,
      }, opts?.envId)) as Record<string, unknown>;
      const thread = result?.thread as Record<string, unknown> | undefined;
      threadId = String(thread?.id ?? result?.threadId ?? "");
      if (!threadId) throw new Error("[rc] thread/start returned no threadId");
      this.shellThreadIds.add(threadId);   // thread tạm cho shell → đánh dấu để loại khỏi danh sách chat
    }

    const tid = threadId;
    return new Promise((resolve, reject) => {
      let output = "";
      let exitCode = 0;
      let done = false;

      const timeoutId = setTimeout(() => {
        if (done) return;
        done = true;
        sub.unsubscribe();
        reject(new Error(`[rc] shellCommand timeout after ${opts?.timeout ?? 60_000}ms`));
      }, opts?.timeout ?? 60_000);

      // Chỉ lắng nghe event của đúng thread terminal (chatEvents lọc sẵn theo threadId).
      const sub = this.chatEvents(tid).subscribe(({ method, params }) => {
        if (done) return;
        if (method === "item/commandExecution/outputDelta") {
          const delta = String(params.delta ?? "");
          if (delta) { output += delta; opts?.onDelta?.(delta); }
        } else if (method === "item/completed") {
          const item = params.item as Record<string, unknown> | undefined;
          if (item?.exitCode !== undefined) exitCode = Number(item.exitCode);
          if (!output && item?.aggregatedOutput) output = String(item.aggregatedOutput);
        } else if (method === "turn/completed") {
          done = true;
          clearTimeout(timeoutId);
          sub.unsubscribe();
          resolve({ output, exitCode, threadId: tid });
        }
      });

      this.request("thread/shellCommand", { threadId: tid, command, cwd: opts?.cwd ?? "/" }, opts?.envId)
        .catch(err => {
          if (done) return;
          done = true;
          clearTimeout(timeoutId);
          sub.unsubscribe();
          reject(err);
        });
    });
  }

  async listThreads(envId?: string): Promise<{ id: string; status?: string; title?: string; [key: string]: unknown }[]> {
    const result = await this.request("thread/list", {}, envId);
    if (Array.isArray(result)) return result as any[];
    const r = result as Record<string, unknown>;
    const items = r?.threads ?? r?.items ?? r?.data ?? [];
    return Array.isArray(items) ? items as any[] : [];
  }

  async listTurns(threadId: string, envId?: string): Promise<{ id: string; role?: string; content?: unknown; [key: string]: unknown }[]> {
    // thread/read includeTurns trả turn state đầy đủ (kể cả item fileChange/exec...) — phong phú
    // và sẵn dùng kể cả khi thread/turns/list báo "not materialized".
    const rd = await this.request("thread/read", { threadId, includeTurns: true }, envId).catch(() => ({})) as Record<string, unknown>;
    const thread = rd?.thread as Record<string, unknown> | undefined;
    const rdTurns = (thread?.turns ?? rd?.turns) as unknown[] | undefined;
    if (Array.isArray(rdTurns) && rdTurns.length) return rdTurns as any[];
    const result = (await this.request("thread/turns/list", { threadId }, envId).catch(() => ({}))) as Record<string, unknown>;
    const items = result?.turns ?? result?.data ?? result?.items ?? result ?? [];
    return Array.isArray(items) ? items as any[] : [];
  }

  async approveAction(threadId: string, opts?: { reject?: boolean }, envId?: string): Promise<void> {
    await this.request("thread/approveGuardianDeniedAction", {
      threadId,
      decision: opts?.reject ? "reject" : "approve",
    }, envId);
  }

  async stopThread(threadId: string, envId?: string): Promise<void> {
    await this.request("thread/archive", { threadId }, envId);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /** Huỷ kết nối: unsubscribe subscription (dừng retry + finalize đóng ws), giải phóng subject + pending. */
  close() {
    this.subscription?.unsubscribe();   // finalize trong pipeline sẽ đóng ws
    this.subscription = undefined;
    this.status$.next("closed");
    this.event$.complete();
    for (const s of this.chats$.values()) s.complete();
    this.chats$.clear();
    this.shellThreadIds.clear();
    this.#rejectAll(new Error("WebsocketRelay disconnected"));
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.status$.value === "ready";
  }
}
