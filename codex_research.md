# Codex Desktop — Research Notes

Nguồn: reverse-engineer từ `bin/Codex.dmg` (Electron app `openai-codex-electron` v26.519.81530),
bundle `.vite/build/main-BS7yenMI.js` (1.2 MB), `app-session-gBTKZRaX.js` (4.3 MB),
`worker.js` (1.4 MB), `comment-preload.js` (38 MB) và proxy server Bun tại `index.ts`.

---

## 1. Base URLs & Headers

```
Base:  https://chatgpt.com
Paths: /backend-api/...   (ChatGPT backend, dùng OAuth token)
       /wham/...          (Codex cloud tasks, embedded trong /backend-api/wham/)
```

### Headers bắt buộc cho mọi Codex request

| Header | Giá trị |
|---|---|
| `Authorization` | `Bearer <accessToken>` |
| `ChatGPT-Account-Id` | ID account/workspace ChatGPT |
| `OpenAI-Beta` | `responses=experimental` |
| `Origin` | `https://chatgpt.com` |
| `Referer` | `https://chatgpt.com/` |
| `Originator` | `codex_cli_rs` |
| `Version` | `0.133.0` |
| `User-Agent` | `codex_cli_rs/0.133.0 (Mac OS; arm64)` |
| `Accept` | `text/event-stream` (SSE) hoặc `application/json` |
| `Content-Type` | `application/json` |
| `X-Oai-Web-Search-Eligible` | `true` |

> **Quan trọng:** `Origin` và `Referer` phải là `https://chatgpt.com`. Browser không thể set những header này tùy ý → bắt buộc phải có server-side proxy.

---

## 2. Endpoints đã xác nhận hoạt động

### 2.1 Auth / Profile

| Method | Path | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/me` | Lấy profile user (email, user_id) |
| `GET` | `/backend-api/wham/accounts/check` | Kiểm tra account có dùng được Codex cloud không |
| `GET` | `/backend-api/wham/usage` | Rate limit / usage status |

### 2.2 Codex Core (chạy một turn)

| Method | Path | Ghi chú |
|---|---|---|
| `POST` | `/backend-api/codex/responses` | SSE stream. Body theo Responses API |
| `WS` | `wss://chatgpt.com/backend-api/codex/responses` | WebSocket thay cho SSE (dùng với proxy) |

> Proxy local rewrite `/v1/responses` → `/backend-api/codex/responses`.

### 2.3 Remote Control Environments (Hosts)

| Method | Path | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/codex/remote/control/environments?limit=100&cursor=...` | Liệt kê hosts online. Pagination qua cursor |
| `PATCH` | `/backend-api/codex/remote/control/environments/{env_id}` | Cập nhật metadata host |
| `DELETE` | `/backend-api/codex/remote/control/environments/{env_id}` | Xóa/revoke host |

Response shape:
```json
{
  "items": [{
    "env_id": "env_e_...",
    "kind": "single",
    "display_name": "MacBook.local",
    "host_name": "MacBook.local",
    "online": true,
    "busy": false,
    "os": "Mac OS",
    "os_version": "26.1.0",
    "arch": "arm64",
    "app_server_version": "0.133.0-alpha.1",
    "client_type": "CODEX_DESKTOP_APP",
    "client_name": "Codex Desktop",
    "client_version": "26.519.41501",
    "last_seen_at": "2026-05-27T16:17:04.078912Z"
  }],
  "cursor": null
}
```

Desktop map `env_id` → internal host id: `const hostId = \`remote-control:${env_id}\``

### 2.4 Remote Control Client Enrollment

Cần enrollment để lấy `remote_control_token` cho WebSocket. Desktop thực hiện:

| Step | Method | Path | Body |
|---|---|---|---|
| 1 | `POST` | `/backend-api/codex/remote/control/client/enroll/start` | `{ client_type, ... }` |
| 2 | Sign challenge | — | ECDSA sign `device_key_challenge.challenge_id` |
| 3 | `POST` | `/backend-api/codex/remote/control/client/enroll/finish` | `{ challenge_id, signature, ... }` |
| Refresh | `POST` | `/backend-api/codex/remote/control/client/refresh/start` | — |
| Refresh | `POST` | `/backend-api/codex/remote/control/client/refresh/finish` | signature |

**Đã xác nhận:** key pair tự sinh bằng code được (không cần Apple Secure Enclave/hardware). Server check `requiresDeviceKeyProof: true` nhưng chấp nhận software-generated ECDSA key.

Response `enroll/start` trả về `{ client_id, device_key_challenge: { challenge_id } }`.  
Token cuối cùng ở field `remote_control_token` trong response `enroll/finish`:
```json
{ "client_id": "...", "remote_control_token": "...", "account_user_id": "..." }
```

Authentication header khi dùng token này: `x-codex-client-session-token: Bearer <remote_control_token>`.

### 2.5 WHAM Cloud Tasks

| Method | Path | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/wham/tasks/list?task_filter=current&limit=...` | Liệt kê cloud tasks |
| `GET` | `/backend-api/wham/tasks/{task_id}` | Chi tiết task |
| `GET` | `/backend-api/wham/tasks/{task_id}/turns` | Conversation turns |
| `GET` | `/backend-api/wham/tasks/{task_id}/turns/{turn_id}` | Chi tiết turn |
| `GET` | `/backend-api/wham/tasks/{task_id}/turns/{turn_id}/logs` | Logs của turn |
| `POST` | `/backend-api/wham/tasks` | Tạo task mới hoặc follow-up |
| `POST` | `/backend-api/wham/tasks/{task_id}/cancel` | Hủy task |
| `POST` | `/backend-api/wham/tasks/{task_id}/mark_read` | Đánh dấu đã đọc |
| `POST` | `/backend-api/wham/tasks/{task_id}/archive` | Archive task |
| `POST` | `/backend-api/wham/tasks/{task_id}/turns/{turn_id}/pr` | Tạo PR từ turn |

Body tạo task:
```json
{
  "new_task": true,
  "input_items": [{ "role": "user", "content": "..." }],
  "environment_id": "...",
  "branch": "main",
  "metadata": { "model_slug": "gpt-5.5", "best_of_n": 1 }
}
```

Follow-up:
```json
{
  "follow_up": { "task_id": "...", "turn_id": "...", "environment_mode": "ask" },
  "input_items": [{ "role": "user", "content": "..." }]
}
```

### 2.6 WHAM Environments & Git

| Method | Path | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/wham/environments` | Liệt kê cloud environments |
| `GET` | `/backend-api/wham/environments/by-repo/{provider}/{owner}/{repo}` | Theo repo (provider=github) |
| `GET` | `/backend-api/wham/github/branches/{repo_id}/search?query=&cursor=` | Search branches |
| `GET` | `/backend-api/wham/remote/control/clients` | Remote control clients (enrollment info) |
| `DELETE` | `/backend-api/wham/remote/control/clients/{client_id}` | Xóa client |

### 2.7 Account / Files / Misc

| Method | Path | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/accounts/{account_id}/settings` | Settings account |
| `GET` | `/backend-api/accounts/{account_id}/users` | Users trong workspace |
| `GET` | `/backend-api/payments/customer_portal` | Link billing portal |
| `POST` | `/backend-api/files` | Upload file |
| `GET` | `/backend-api/files/download/{file_id}` | Download file |
| `POST` | `/backend-api/transcribe` | Speech-to-text |

### 2.8 Endpoints KHÔNG tồn tại (trả 404)

```
/backend-api/codex/hosts/{hostId}/projects
/backend-api/codex/hosts/{hostId}/folders
/backend-api/codex/hosts/{hostId}/projects/{id}/chats
/backend-api/codex/remote-control/authorize   ← path hyphen sai
```

Projects/chat không có HTTP endpoint. Desktop build danh sách từ local state:
- `~/.codex/.codex-global-state.json` key `remote-projects`
- `~/.codex/codex-app/config.json` — SSH connections config

---

## 3. Remote Control WebSocket Protocol

### 3.1 Kết nối

```
WSS wss://chatgpt.com/backend-api/codex/remote/control/client
Headers: x-codex-client-session-token: Bearer <remote_control_token>
         Authorization: Bearer <accessToken>
         ChatGPT-Account-Id: <accountId>
         ...headers chung
```

ChatGPT backend là **relay** giữa mobile và desktop. Cả hai đều connect vào cùng 1 endpoint; backend forward message.

### 3.2 Message Types

**Client → Desktop (qua relay):**

| Type | Fields | Ý nghĩa |
|---|---|---|
| `fetch` | `requestId, url, method, headers?, body?` | Proxy HTTP request qua desktop |
| `cancel-fetch` | `requestId` | Hủy fetch |
| `fetch-stream` | `requestId, url, method, headers?, body?` | Proxy SSE/stream qua desktop |
| `cancel-fetch-stream` | `requestId` | Hủy stream |
| `shared-object-subscribe` | `key` | Subscribe một shared object từ desktop |
| `shared-object-unsubscribe` | `key` | Unsubscribe |
| `ipc-request` | `method, params, targetClientId?` | Gọi Electron IPC handler trên desktop |
| `thread-follower-start-turn-request` | `requestId, hostId, ...params` | Bắt đầu turn Codex |
| `thread-follower-submit-user-input-request` | `requestId, hostId, ...params` | Gửi user input |
| `thread-follower-command-approval-decision-request` | `requestId, hostId, decision` | Approve/deny command |
| `thread-follower-file-approval-decision-request` | `requestId, hostId, decision` | Approve/deny file |
| `thread-follower-interrupt-turn-request` | `requestId, hostId` | Dừng Codex đang chạy |
| `thread-follower-steer-turn-request` | `requestId, hostId, ...` | Steer hướng turn |
| `thread-follower-compact-thread-request` | `requestId, hostId` | Compact thread |
| `thread-follower-edit-last-user-turn-request` | `requestId, hostId, content` | Sửa turn cuối |
| `thread-follower-set-collaboration-mode-request` | `requestId, hostId, mode` | Set mode |
| `thread-follower-set-model-and-reasoning-request` | `requestId, hostId, ...` | Đổi model |
| `thread-follower-set-queued-follow-ups-state-request` | `requestId, hostId, ...` | Queued follow-ups |
| `thread-follower-permissions-request-approval-response` | `requestId, hostId, ...` | Permission approval |

**Desktop → Client:**

| Type | Fields | Ý nghĩa |
|---|---|---|
| `fetch-response` | `requestId, responseType, status, headers?, bodyJsonString?` | HTTP response |
| `fetch-stream-event` | `requestId, event, data` | SSE event line |
| `fetch-stream-complete` | `requestId` | Stream kết thúc |
| `fetch-stream-error` | `requestId, error` | Stream lỗi |
| `shared-object-updated` | `key, value` | State từ desktop |
| `thread-follower-start-turn-response` | `requestId, ...` | Response từ start turn |
| `thread-follower-submit-user-input-response` | `requestId, ...` | Response từ submit input |
| `thread-follower-command-approval-decision-response` | `requestId, ...` | Kết quả approval |
| ... (mọi `*-request` đều có `*-response` tương ứng) | | |

### 3.3 fetch-stream — proxy qua desktop

Quan trọng nhất cho mobile. Dùng để gọi `/backend-api/codex/responses` (SSE) thông qua kênh WS:

```json
// Client gửi:
{
  "type": "fetch-stream",
  "requestId": "<uuid>",
  "url": "/backend-api/codex/responses",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{ \"model\": \"gpt-5.5\", ... }"
}

// Desktop trả về nhiều events:
{ "type": "fetch-stream-event", "requestId": "...", "event": "response.output_text.delta", "data": "{...}" }
{ "type": "fetch-stream-event", "requestId": "...", "event": "response.completed", "data": "{...}" }
{ "type": "fetch-stream-complete", "requestId": "..." }
```

URL trong `fetch-stream` là đường dẫn tương đối, desktop tự prepend `https://chatgpt.com`.

### 3.4 Shared Objects (state push từ desktop)

Subscribe bằng `{ type: "shared-object-subscribe", key: "<key>" }`.
Desktop push ngay snapshot + sau đó push update mỗi khi thay đổi.

| Key | Nội dung |
|---|---|
| `remote_control_connections` | Danh sách remote connections đang active |
| `remote_connections` | SSH connections đã config |
| `remote_control_connections_state` | State của connection (`{ clientAuthorized, ... }`) |
| `host_config` | Config host hiện tại |
| `local_remote_control_enabled` | bool, remote control có được bật không |
| `local_remote_control_environment_id` | env_id của host local |
| `local_remote_control_client_id` | client_id enrollment |
| `local_remote_control_installation_id` | installation id |
| `pending_worktrees` | Worktrees đang pending |
| `codex_chronicle_config` | Chronicle logging config |
| `codex_runtimes_config` | Runtime config |

### 3.5 IPC Request qua WebSocket

```json
{
  "type": "ipc-request",
  "method": "remote-workspace-directory-entries",
  "params": { "hostId": "remote-control:env_e_...", "directoryPath": "/Users/...", "directoriesOnly": true }
}
```

Danh sách đầy đủ IPC methods có thể gọi từ remote (xác nhận từ bundle):

**Remote/Connection:**
- `authorize-remote-control-connections`
- `refresh-remote-control-connections`
- `refresh-remote-connections`
- `delete-remote-control-environment`
- `rename-remote-control-environment`
- `set-local-remote-control-enabled`
- `set-remote-control-connections-enabled`
- `set-remote-connection-auto-connect`
- `discover-remote-ssh-connections`
- `save-codex-managed-remote-ssh-connections`
- `install-remote-codex`
- `start-remote-chatgpt-login-port-forward`
- `stop-remote-chatgpt-login-port-forward`
- `app-server-connection-state`

**Workspace / Files:**
- `remote-workspace-directory-entries` — `{ hostId, directoryPath, directoriesOnly }`
- `workspace-directory-entries` — `{ hostId?, workspaceRoot, directoryPath, directoriesOnly, includeHidden }`
- `active-workspace-roots`
- `workspace-root-options`
- `add-workspace-root-option`
- `electron-add-new-workspace-root-option` / `electron-create-new-workspace-root-option`
- `electron-pick-workspace-root-option` / `electron-set-active-workspace-root`
- `electron-rename-workspace-root-option`
- `electron-clear-active-workspace-root`
- `projectless-workspace-root`
- `projectless-thread-cwd`

**Thread / Session:**
- `generate-thread-title`
- `delete-archived-thread`
- `delete-all-archived-threads`
- `list-pinned-threads`
- `set-pinned-threads-order`
- `set-thread-pinned`
- `worktree-set-owner-thread`
- `list-pending-automation-run-threads`
- `thread-follower-compact-thread`
- `thread-follower-interrupt-turn`
- `thread-follower-edit-last-user-turn`
- `queued-follow-up-send-lock-acquire`
- `queued-follow-up-send-lock-release`

**Codex Config:**
- `codex-agents-md` / `codex-agents-md-save`
- `codex-home`
- `codex-command-keymap-state`
- `set-codex-command-keybinding`
- `mcp-codex-config`

**Git / Commit:**
- `generate-commit-message`
- `generate-commit-pull-request-message`
- `generate-pull-request-message`
- `apply-patch`
- `electron-clone-workspace-repo`

**Automation:**
- `automation-create` / `automation-update` / `automation-delete`
- `automation-run-now` / `automation-run-archive` / `automation-run-delete`
- `primary-runtime-update-run-now`

**System / Misc:**
- `account-info`
- `local-environment` / `local-environments` / `local-environment-config`
- `child-processes`
- `x-codex-client-session-token`
- `main-message`
- `call-app-plugin-request`

---

## 4. Local App-Server (trên máy Desktop)

Codex Desktop chạy một local server khi active:

- **Dev mode:** `http://localhost:5175`
- **Production:** `http://localhost:8000` (hoặc qua Unix socket)
- **Unix socket:** `${CODEX_HOME:-$HOME/.codex}/app-server-control` (NDJSON protocol)

App-server dùng native pipe (Unix domain socket) để giao tiếp giữa CLI và Desktop GUI. Không phải HTTP thông thường.

CLI Codex kết nối vào socket này khi chạy trong workspace được Desktop quản lý.

---

## 5. OAuth / Login Flow

```
Auth server: https://auth.openai.com
Authorize:   /oauth/authorize
Token:       /oauth/token
Callback:    http://localhost:1455/auth/callback  (desktop intercepts)
```

Tokens được lưu tại `~/.codex/auth.json`:
```json
{
  "tokens": {
    "access_token": "eyJhbGc...",
    "refresh_token": "...",
    "account_id": "org-...",
    "expires_at": 1234567890
  }
}
```

Token thông thường là JWT, có thể decode để xem `exp` (expiry). Proxy server tự refresh khi phát hiện 401.

---

## 6. Local State Files (Desktop)

| File | Nội dung |
|---|---|
| `~/.codex/auth.json` | OAuth tokens, account_id |
| `~/.codex/.codex-global-state.json` | Global state, key `remote-projects` chứa danh sách project |
| `~/.codex/codex-app/config.json` | SSH connections config, project seeds |
| `~/.codex/app-server-control/` | Unix socket dir của app-server |
| `~/.codex/app-server-control/app-server.log` | App-server log |

Shape `remote-projects` trong global state:
```json
[{
  "id": "uuid",
  "hostId": "remote-control:env_e_...",
  "remotePath": "/Users/name/dev/project",
  "label": "project"
}]
```

SSH config shape:
```json
{
  "version": 1,
  "remoteConnectionMaxRetryAttempts": 3,
  "remoteConnections": [{
    "sshAlias": "Mac mini",
    "projects": [{
      "remotePath": "/Users/name/dev/project",
      "label": "project"
    }]
  }]
}
```

---

## 7. Proxy Server Hiện Có (port 9878)

File: `index.ts` + `src/server/proxy.ts`

Proxy server Bun hiện tại xử lý:
- `GET /` — Web UI (React SPA từ `src/web/`)
- `GET /health` — Health check + status
- `POST /v1/responses` → rewrite → `POST /backend-api/codex/responses` (SSE)
- `WS /v1/responses` → `WSS wss://chatgpt.com/backend-api/codex/responses`
- `ANY /backend-api/*` → proxy thẳng `https://chatgpt.com/backend-api/*`
- JWT gate: tất cả `/v1/*` và `/backend-api/*` cần valid JWT từ client
- Auto account switching khi rate limit / 401
- LiveQuery WebSocket cho real-time dashboard

**Proxy đã có thể:**
- Gắn đúng headers Codex (`Origin`, `Referer`, `Originator`, v.v.)
- Proxy WebSocket với account rotation
- Handle token refresh tự động
- `buildWebSocketHeaders()` trong `src/server/libs/chatgpt.ts`

**Proxy chưa có:**
- Endpoint cho remote control enrollment (`/backend-api/codex/remote/control/client/enroll/*`)
- WebSocket proxy cho remote control channel (`/backend-api/codex/remote/control/client`)
- WHAM tasks endpoints
- Shared object subscription relay

---

## 8. Kiến Trúc Cho Web App Mới

### Vấn đề browser không thể gọi trực tiếp

Browser không thể set `Origin: https://chatgpt.com` hoặc `Referer: https://chatgpt.com/` — bị browser block vì security policy. Cũng không thể set headers trong WebSocket constructor (`new WebSocket(url)` không nhận headers).

→ **Mọi request phải đi qua proxy server Bun đang có** (port 9878).

### Flow cho Remote Control từ web app

```
Browser (React)
  │
  │  WebSocket ws://localhost:9878/rc/ws
  │  (new proxy endpoint)
  ▼
Proxy Server (Bun, port 9878)
  │  - Thực hiện enrollment nếu chưa có token
  │  - Connect WebSocket với x-codex-client-session-token
  ▼
ChatGPT Relay (wss://chatgpt.com/backend-api/codex/remote/control/client)
  │
  ▼
Codex Desktop (máy đích)
```

### Enrollment flow trong proxy

1. Proxy check `~/.codex/auth.json` lấy `accessToken`
2. `POST /backend-api/codex/remote/control/client/enroll/start`
3. Tự generate ECDSA key pair (không cần hardware)
4. Sign `challenge_id` → `POST enroll/finish`
5. Lưu `remote_control_token` + private key
6. Connect WSS với token

### Message flow browser ↔ desktop

Browser gửi JSON đơn giản qua WebSocket local:
```json
{ "method": "listFolders", "params": { "hostId": "remote-control:env_e_..." } }
```

Proxy translate sang protocol thật:
```json
{ "type": "ipc-request", "method": "remote-workspace-directory-entries",
  "params": { "hostId": "...", "directoryPath": "/", "directoriesOnly": true } }
```

Proxy nhận `shared-object-updated`, `fetch-stream-event`, ... và forward về browser dưới dạng đơn giản hơn.

### Gửi message / chạy Codex

Thay vì REST endpoint giả:
```json
// Browser gửi:
{ "method": "submitUserInput", "hostId": "...", "sessionId": "...", "text": "hãy viết test" }

// Proxy gửi qua WS relay:
{ "type": "thread-follower-submit-user-input-request",
  "requestId": "<uuid>",
  "hostId": "remote-control:env_e_...",
  "params": { "sessionId": "...", "text": "hãy viết test" } }
```

### Approve / Deny command

```json
// Browser:
{ "method": "approveCommand", "approvalId": "...", "decision": "allow" }

// Proxy → Desktop:
{ "type": "thread-follower-command-approval-decision-request",
  "requestId": "<uuid>",
  "hostId": "...",
  "params": { "approvalId": "...", "decision": "allow" } }
```

---

## 9. Hiện Trạng Mobile App (`app/mobile`)

| Tính năng | Trạng thái | Ghi chú |
|---|---|---|
| `listHosts` | ✅ Thật | Dùng đúng endpoint environments |
| `signInWithGoogle` | ⚠️ Partial | Lưu token thủ công, không có OAuth flow |
| `authorizeRemoteControl` | ❌ Giả | Endpoint `/remote-control/authorize` không tồn tại, luôn return true |
| `listProjects` | ❌ Mock | Không có HTTP endpoint tương ứng |
| `listFolders` | ❌ Mock | Endpoint `/hosts/{id}/folders` 404 |
| `createProject` | ❌ Mock | Endpoint `/hosts/{id}/projects` 404 |
| `createChat` | ❌ Mock | Endpoint `/hosts/{id}/projects/{id}/chats` 404 |
| `readChat` | ❌ Mock | Không có |
| `sendMessage` | ❌ Mock | Phải dùng `thread-follower-submit-user-input` qua WS |
| `approveRequest` | ❌ Mock | Phải dùng `thread-follower-command-approval-decision` qua WS |
| WebSocket real-time | ❌ Chưa có | Chat không update sau khi mở |
| `codexHostClient.ts` | ❌ Dead code | Không được import ở đâu |
| WHAM cloud tasks | ❌ Chưa có | Toàn bộ `/wham/tasks/*` chưa được implement |

---

## 10. Tóm Tắt Nhanh

- **Chỉ có `listHosts` hoạt động thật.** Mọi thứ còn lại là mock.
- **Không có REST endpoint** cho project/chat/message. Phải dùng WebSocket relay.
- **Enrollment cần ECDSA key pair** nhưng software-generated được (đã test).
- **WHAM cloud tasks** (`/wham/tasks/*`) là con đường thực tế nhất cho cloud Codex — không cần desktop online.
- **Remote control** qua WS relay cần enrollment + `x-codex-client-session-token`.
- **Proxy server** hiện có đã handle phần khó nhất (headers, account switching, token refresh). Chỉ cần thêm endpoint enrollment và WS proxy cho `/backend-api/codex/remote/control/client`.
- **Web app** khả thi nếu mọi call đi qua proxy (không call ChatGPT trực tiếp từ browser).
