# Relay WebSocket Protocol — Codex Remote Control

Đặc tả giao thức WebSocket mà proxy dùng để điều khiển Codex desktop từ xa, qua **relay của OpenAI**. Đây là tài liệu nguồn-sự-thật cho [`WebsocketRelay.ts`](apps/honojs/src/libs/codex-remote-control/WebsocketRelay.ts), [`registry.ts`](apps/honojs/src/libs/codex-remote-control/registry.ts), [`crypto.ts`](apps/honojs/src/libs/codex-remote-control/crypto.ts).

> Lưu ý quan trọng: payload **KHÔNG** có field `"jsonrpc":"2.0"`. `stream_id` là **một UUID/kết nối** (không phải per-request). `initialize` PHẢI là request đầu tiên sau challenge-response.

---

## 1. Kiến trúc

```
Proxy (WebsocketRelay)  ──WSS──►  relay chatgpt.com  ──►  Codex desktop (host, env_id)
```

- Proxy không nối trực tiếp tới máy host; nó nối tới **relay** và relay định tuyến theo `env_id` tới đúng máy đã enroll.
- **1 WebSocket = 1 ACCOUNT.** `env_id` được đính **trong từng frame** (`client_message.env_id`), nên cùng một kết nối phục vụ **mọi host** của account; mọi chat (thread) của mọi host đều **ghép kênh** trên một socket. Handshake/headers ở cấp account (không mang `env_id`). Pool quản lý bởi `RemoteControlRegistry` theo key **`account.id`**.
- Số kết nối relay = số **account** đang dùng, độc lập với số host và số chat. Một host mặc định (`envId` truyền lúc tạo) chỉ dùng cho handshake/`initialize`; các action sau truyền `env_id` riêng mỗi lần.

---

## 2. Thiết lập kết nối

### 2.1. Endpoint
```
wss://chatgpt.com/backend-api/codex/remote/control/client
```

### 2.2. Headers khi mở WS
| Header | Giá trị | Nguồn |
|---|---|---|
| `Authorization` | `Bearer <account.accessToken>` | OAuth access token của account |
| `ChatGPT-Account-Id` / `chatgpt-account-id` | `<account.accountId>` | |
| `x-codex-client-session-token` | `Bearer <token tươi>` | remote-control token (TTL ~10 phút), lấy từ token provider mỗi lần connect |
| `x-codex-client-id` | `<enrollment.clientId>` | id của client đã enroll |
| `x-codex-protocol-version` | `3` | hằng `PROTOCOL_VERSION` |
| `OpenAI-Beta` | `responses=experimental` | |
| `Origin` / `Referer` | `https://chatgpt.com` | |
| `Originator` | `codex_cli_rs` | giả lập Codex CLI |
| `User-Agent`, `Version` | theo client Codex | |

Token được làm tươi ở **mỗi lần (re)connect**, không chỉ lần đầu: `WebsocketRelay` nhận `getToken: () => Promise<string>` (constructor) và pipeline `connect()` (rxjs `defer`) gọi lại nó mỗi lần subscribe. Registry truyền `() => freshToken(account)` → `EnrollmentService.refreshEnrollment` nếu `tokenExpiresAt` sắp/đã hết hạn. Nhờ đó connection pooled tự reconnect bằng token mới sau khi token cũ hết hạn (không còn dùng token "nướng cứng" lúc tạo relay).

---

## 3. Handshake (bắt buộc, đúng thứ tự)

```
client                         relay
  │  ── (open WS) ──────────────►│
  │  ◄── device_key_challenge ───│   (server gửi trước)
  │  ── device_key_proof ───────►│   (ký bằng private key của enrollment)
  │  ── client_message:initialize►│
  │  ◄── server_message:result ──│
  │            READY              │
```

Nếu sau khi `open` mà **10 giây** không nhận được `device_key_challenge`, client coi như đã sẵn sàng (một số phiên không challenge).

### 3.1. `device_key_challenge` (server → client)
```jsonc
{
  "type": "device_key_challenge",
  "nonce": "...",
  "sessionId": "...",
  "targetOrigin": "https://chatgpt.com",
  "targetPath": "/backend-api/codex/remote/control/client",
  "accountUserId": "...",
  "clientId": "cli_...",            // PHẢI khớp enrollment.clientId, lệch → đóng
  "tokenSha256Base64url": "...",
  "tokenExpiresAt": 1779790191,
  "scopes": ["codex.remote_control..."],
  "audience": "..."
}
```

### 3.2. `device_key_proof` (client → server)
Ký bằng **ECDSA P-256 / SHA-256**, chữ ký mã hoá **DER**, key từ enrollment (`privateKeyPkcs8Base64`).

Payload được ký = JSON của object sau (đã wrap domain), **KHÓA THEO THỨ TỰ ALPHABET**:
```jsonc
{
  "domain": "codex-device-key-sign-payload/v1",
  "payload": {
    "accountUserId":        challenge.accountUserId,
    "audience":             challenge.audience,
    "clientId":             challenge.clientId,
    "nonce":                challenge.nonce,
    "scopes":               challenge.scopes,
    "sessionId":            challenge.sessionId,
    "targetOrigin":         challenge.targetOrigin,
    "targetPath":           challenge.targetPath,
    "tokenExpiresAt":       challenge.tokenExpiresAt,
    "tokenSha256Base64url": challenge.tokenSha256Base64url,
    "type":                 "remoteControlClientConnection"
  }
}
```
Frame gửi:
```jsonc
{
  "type": "device_key_proof",
  "keyId": "<enrollment.keyId>",
  "signatureDerBase64": "<DER(sig) base64>",
  "signedPayloadBase64": "<payloadBytes base64>",   // đúng các byte đã ký
  "algorithm": "ecdsa_p256_sha256"
}
```

### 3.3. `initialize` (client → server, request đầu tiên)
```jsonc
{ "method": "initialize", "params": {
    "clientInfo": { "name": "codex-proxy", "version": "1.0.0" },
    "capabilities": { "experimentalApi": true }
} }
```
(gửi trong khung `client_message`, xem §4.1)

---

## 4. Khung bản tin (framing)

### 4.1. Client → Server: `client_message`
```jsonc
{
  "type": "client_message",
  "client_id": "<enrollment.clientId>",
  "seq_id": 12,                 // tăng dần mỗi frame trên connection
  "env_id": "env_e_...",        // host đích
  "stream_id": "<uuid>",        // 1 UUID/kết nối
  "skip_history": false,
  "message": { "id": "<uuid>", "method": "...", "params": { ... } }
}
```
- `message.id` = UUID cho mỗi request, dùng để **khớp response**.
- Timeout mỗi request: **20 000 ms** (`REQUEST_TIMEOUT_MS`).

### 4.2. Server → Client: `server_message`
Hai dạng, phân biệt bằng có `message.id` hay không:

**(a) RPC response** (có `id`):
```jsonc
{ "type": "server_message", "message": { "id": "<uuid>", "result": { ... } } }
{ "type": "server_message", "message": { "id": "<uuid>", "error": { "message": "..." } } }
```
→ resolve/reject promise đang chờ `id` đó. `result` là payload trả về (nếu thiếu thì dùng cả `message`).

**(b) Notification** (KHÔNG có `id`):
```jsonc
{ "type": "server_message", "stream_id": "...", "env_id": "env_e_...", "message": { "method": "...", "params": { ... } } }
```
→ sau dedup, `next()` vào: **`event$`** (mọi event của mọi host — kênh chính) + `chats$[threadId]` (kênh đã lọc theo thread, dùng cho `shellCommand`). Mỗi event mang `envId` để consumer demux. Xem §5.

### 4.3. `server_message_chunk` (bản tin lớn, chia mảnh)
```jsonc
{
  "type": "server_message_chunk",
  "env_id": "...", "stream_id": "...", "seq_id": 19,
  "segment_id": 0, "segment_count": 3,
  "message_chunk_base64": "<base64 phần i>"
}
```
- Buffer theo key `env_id:stream_id:seq_id`.
- Khi đủ `segment_count` mảnh → ghép theo thứ tự `segment_id`, base64-decode, concat, `JSON.parse` → xử lý lại như một `server_message` bình thường.

### 4.4. `ack`
Bỏ qua (no-op).

### 4.5. `ipc-broadcast`
```jsonc
{ "type": "ipc-broadcast", "params": { "conversationId": "...", ... } }
```
→ kênh Electron-IPC riêng; proxy **không tiêu thụ** (realtime đi qua `server_message` notification). Hiện bỏ qua.

---

## 5. Notification: demux & chống nhân đôi

- **Hai kênh Subject** (sau dedup):
  - **`event$`** — public, gom **mọi** event của mọi host. Đây là kênh chính: service khởi tạo kết nối (`LivequeryStore`) subscribe `event$` rồi tự demux theo `envId`/`threadId` để publish vào ref LiveQuery (xem §10).
  - **`chats$[threadId]`** — kênh đã lọc sẵn theo `threadId`, lazy tạo qua `chatEvents(threadId)`. Chỉ `shellCommand` dùng (nghe output của đúng thread terminal).
  - (Đã bỏ `hosts$`/`turns$`/`turnEvents` — gộp về `event$` + demux ở consumer.)
- **Chống echo đa-stream**: relay có thể phát cùng một event của một turn trên **nhiều `stream_id`** (host/mobile/proxy cùng nối env). Client khoá mỗi `turnId` vào `stream_id` **đầu tiên** thấy nó (`turnStreamLock`); event của cùng `turnId` đến từ `stream_id` khác → **drop**. Dedup chạy **trước** khi next() vào Subject ⇒ mỗi token delta chỉ phát đúng 1 lần.

---

## 6. Danh mục RPC method (client → server)

| Method | Params chính | Result | Dùng cho |
|---|---|---|---|
| `initialize` | `clientInfo`, `capabilities` | — | handshake |
| `thread/start` | `input[]`, `cwd`, `model`, `approvalPolicy`, … (threadId=null) | `{ thread:{id}, turn:{id} }` | tạo thread **mới** + submit turn đầu |
| `turn/start` | `threadId`, `input[]`, `cwd`, `model`, `approvalPolicy`, … | `{ thread, turn }` | submit turn vào thread **có sẵn** |
| `thread/resume` | `threadId` (± `input[]`) | thread state | **LOAD** thread (không submit) / steer |
| `thread/read` | `threadId`, `includeTurns:true` | `{ thread:{ turns[] } }` | đọc lịch sử đầy đủ (kèm fileChange/exec) |
| `thread/turns/list` | `threadId` | `{ turns[] }` | fallback liệt kê turn |
| `thread/list` | — | `{ threads[] }` | liệt kê chat trên host |
| `thread/shellCommand` | `threadId`, `command`, `cwd` | (qua notification) | chạy lệnh shell (terminal). Nếu không truyền `threadId`, relay `thread/start` tạo thread tạm → id thêm vào `shellThreadIds` để consumer lọc khỏi danh sách chat |
| `thread/approveGuardianDeniedAction` | `threadId`, `decision:"approve"|"reject"` | — | duyệt/từ chối hành động bị chặn |
| `thread/archive` | `threadId` | — | stop/archive thread |

### 6.1. Cấu trúc `input[]`
```jsonc
[
  { "type": "text",  "text": "...", "text_elements": [] },
  { "type": "image", "data": "<base64>", "mimeType": "image/png" }
]
```

### 6.2. `approvalPolicy`
`"untrusted" | "on-failure" | "on-request" | "granular" | "never"` — mặc định `sendMessage` dùng **`on-request`**; terminal (`shellCommand`) dùng **`never`**.

### 6.3. Quy tắc gửi message (`sendMessage`)
- Thread **mới** (không có `threadId`) → `thread/start`.
- Thread **có sẵn** → gửi `thread/resume` (LOAD) **trước**, rồi `turn/start` (SUBMIT). `thread/resume` chỉ load chứ không submit turn.

---

## 7. Danh mục Notification event (server → client, không có `id`)

| Method | Params | Ý nghĩa |
|---|---|---|
| `thread/status/changed` | `threadId`, `status.type` | trạng thái thread đổi (→ map `in_progress`/`idle`) |
| `turn/started` | `threadId`, `turnId` | turn bắt đầu (agent đang chạy) |
| `turn/completed` | `threadId`, `turnId` | turn xong (idle) |
| `item/started` | `threadId`, `turnId`, `item` | một item bắt đầu |
| `item/completed` | `threadId`, `turnId`, `item`, `completedAtMs` | item hoàn tất (nội dung đầy đủ) |
| `item/agentMessage/delta` | `threadId`, `turnId`, `itemId`, `delta` | **token streaming** của agent message |
| `item/commandExecution/outputDelta` | `threadId`, `delta` | output stream của lệnh shell |
| `thread/tokenUsage/updated` | `threadId`, usage | cập nhật token usage |

### 7.1. Các `item.type` thường gặp
- `userMessage` / `steeringUserMessage` — tin nhắn người dùng (`content[]` hoặc `text`).
- `agentMessage` — phản hồi agent (`text`); stream qua `item/agentMessage/delta`.
- `fileChange` — thay đổi file: `{ id, changes:[{ path, kind:{type:add|modify|delete|rename}, diff }], status }`.
- `image` / `localImage` / `imageGeneration` — ảnh (`data` base64 / `url` / `path`).
- item approval (type chứa `approval|elicit|confirmation|guardian|permission`, hoặc exec/command/file ở trạng thái pending) — yêu cầu xác nhận.
- `commandExecution` — chạy lệnh: `exitCode`, `aggregatedOutput`.

### 7.2. Mã hoá `turnId` ổn định (phía proxy)
Lịch sử (`thread/read`) trả item id dạng `item-N`, còn stream trả `msg_X` → khác hệ. Proxy hợp nhất bằng doc-id `"<turnId>:user"` / `"<turnId>:agent"` (key chung là `turnId`) để cùng một turn không bị nhân đôi giữa history và stream.

---

## 8. Vòng đời & độ tin cậy

- **connect() = MỘT pipeline RxJS, trả về `Subscription`** (mọi logic kết nối/lắng nghe/reconnect nằm trong đây):
  ```
  of(1)                                                        // kích hoạt lazy
    → switchMap(() => { const socket = new WebSocket(...); return merge(  // tạo socket tươi mỗi (re)subscribe
         fromEvent(socket,'message').pipe(tap(handshake+handleMessage)),
         fromEvent(socket,'error').pipe(map(()=>{throw …})),
         fromEvent(socket,'close').pipe(map(e=>{throw …})),     // close/error → ném lỗi → retry
         handshakeError$ ))                                      // kênh lỗi handshake (mismatch/init)
       .pipe(finalize(() => socket.close()))                    // đóng socket khi ngắt/đổi
    → retry({ delay: backoff min(30s,1s·2^(n-1)) })             // tự reconnect; mở đầu lỗi → dừng
    → .subscribe()                                               // gán vào prop `subscription`
  ```
  Lần mở **đầu tiên** lỗi → retry dừng → `status$ = "closed"` → `whenReady()` reject (registry tạo lại token tươi); rớt **sau khi đã kết nối** → `status$ = "connecting"` → retry resubscribe.
- **`status$`** (public `BehaviorSubject<"idle"|"connecting"|"ready"|"closed">`): trạng thái kết nối. **Mọi action chờ `status$.value === "ready"`** trước khi gửi — qua `whenReady(): Promise<void>` (resolve khi "ready", reject khi "closed").
- **Reject-all**: WS đóng đột ngột → `Remote control disconnected`; `close()` chủ động → `WebsocketRelay disconnected`.
- **Pooling** (`RemoteControlRegistry.getRC`): trả instance đang `isConnected` (= `status$ ready`); nếu không, `connect(); await whenReady()`, lỗi thì `close()` + tạo mới.
- **`close()`**: `subscription.unsubscribe()` (dừng retry + `finalize` đóng socket), complete các Subject, reject-all.

---

## 9. Sơ đồ luồng "gửi 1 tin nhắn vào thread có sẵn"

```
proxy                              relay / host
  │ thread/resume {threadId} ───────►│
  │ ◄──────────── result ────────────│   (đã LOAD)
  │ turn/start {threadId,input} ────►│
  │ ◄──────────── result {turn} ─────│   (đã SUBMIT)
  │ ◄── turn/started ────────────────│
  │ ◄── item/started (agentMessage) ─│
  │ ◄── item/agentMessage/delta ×N ──│   (token-by-token)
  │ ◄── item/completed (agentMessage)│
  │ ◄── turn/completed ──────────────│
```

---

## 10. Phía consumer: `event$` → LiveQuery (LivequeryStore)

`LivequeryStore` ([services/livequery/store.ts](apps/honojs/src/services/livequery/store.ts)) là nơi **khởi tạo kết nối** và biến `event$` thành realtime cho Web UI. `#hookRelayEvents` subscribe `rc.event$` **một lần / account**, demux mỗi event:

**A. Turn update → `turnRefs(accountId, chatId)`**
- `item/agentMessage/delta` → publish doc `{ _delta, _seq, status:"in_progress" }` — **chỉ mảnh token + `_seq` tăng dần** (payload nhỏ; frontend cộng dồn theo `_seq`).
- `item/started`(agentMessage) → doc rỗng `added`; `item/completed` → doc full text `completed`.
- Tất cả cùng doc-id `"<turnId>:agent"` (xem §7.2) ⇒ 1 turn = 1 doc, không nhân đôi. `added` lần đầu, `modified` các lần sau (`turnSeen`).
- Map `threadToChat` đổi relay `threadId` → URL `chatId` (chat mới có thể lệch id).

**B. Chat status / chat mới → ref `accounts/{id}/hosts/{env}/chats`**
- `knownThreads[env]` = tập thread đã biết (seed từ `thread/list` lúc `streamChats`); **có entry = host đã "warm"**.
- `threadId` **đã biết** → publish `modified` (đổi status) — chỉ khi chat có trong `chatById` (chat thật).
- `threadId` **lạ** (host đã warm) → **chat mới**: `#emitNewChat` fetch tên thật qua `thread/list` rồi publish **`added`**. Host **chưa warm** → bỏ qua (tránh nhầm toàn bộ list cũ thành mới).

**C. Lọc shell-thread**
- Thread do `shellCommand` tạo (`rc.shellThreadIds`) **không** được coi là chat → không `added`/`modified` vào danh sách chat. (Terminal chạy qua SSE riêng, xem README › Terminal.)

> `streamChats()` / `streamChatTurns()` chỉ **load lịch sử** (list) rồi gắn hook; realtime hoàn toàn do `event$` → `#hookRelayEvents` publish. Chi tiết vận hành ở [README › Remote Control › Kiến trúc realtime](README.md).
