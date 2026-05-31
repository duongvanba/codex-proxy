# Backend API Reference

Server mặc định chạy trên `http://localhost:9878`.  
Tất cả route `/v1/*` (trừ `/v1/models`) và `/backend-api/*` yêu cầu JWT header hợp lệ từ tài khoản ChatGPT plan `plus / pro / max`.

---

## Mục lục

- [Static / Web](#static--web)
- [Proxy (OpenAI-compatible)](#proxy-openai-compatible)
- [WebSocket Proxy](#websocket-proxy)
- [LiveQuery – Collections](#livequery--collections)
- [LiveQuery – Actions](#livequery--actions)
- [LiveQuery – WebSocket Realtime](#livequery--websocket-realtime)

---

## Static / Web

| Method | Path | Mô tả |
|--------|------|--------|
| GET | `/` | Web UI (HTML) |
| GET | `/index.html` | Web UI (HTML) |
| GET | `/app.js` | Frontend bundle JS |
| GET | `/app.js.map` | Source map |
| GET | `/app.css` | Stylesheet |
| GET | `/favicon.ico` | 204 No Content |
| GET | `/health` | Server health: số accounts, openaiBaseUrl |
| GET | `/v1/models` | Danh sách models (không cần JWT) |
| ANY | `/api/*` | 410 Gone – legacy routes đã bị xóa sau LiveQuery migration |

---

## Proxy (OpenAI-compatible)

Tất cả request được forward tới `https://chatgpt.com` với access token của account đang active.  
Tự động switch account khi bị rate-limit.

| Method | Path | Mô tả |
|--------|------|--------|
| ANY | `/v1/*` | Proxy tới OpenAI-compatible API (yêu cầu JWT) |
| ANY | `/backend-api/*` | Proxy tới ChatGPT backend API (yêu cầu JWT) |
| ANY | `*` (fallback) | Thử proxy theo unsupported-routes config; trả 404 nếu không khớp |

---

## WebSocket Proxy

Upgrade WebSocket, JWT được validate trước khi upgrade.

| Path | Mô tả |
|------|--------|
| `/v1/*` (WS) | Proxy WebSocket tới `wss://chatgpt.com/v1/…` – dùng cho Codex realtime API |
| `/backend-api/*` (WS) | Proxy WebSocket tới `wss://chatgpt.com/backend-api/…` |
| `/livequery/realtime-updates` (WS) | LiveQuery realtime channel – **không cần JWT** (xem phần bên dưới) |

---

## LiveQuery – Collections

Tất cả collections đều là `GET`.  
Base path: `/livequery/`

Response format chuẩn:
```json
{
  "data": {
    "items": [...],
    "count": { "prev": 0, "next": 0, "total": N, "current": N },
    "has": { "prev": false, "next": false },
    "cursor": { "first": "...", "last": "..." },
    "summary": {}
  }
}
```

### Top-level collections

| Path | Mô tả |
|------|--------|
| `GET /livequery/accounts` | Danh sách tất cả accounts (không có token) |
| `GET /livequery/reports` | Danh sách events/reports gần nhất (tối đa 250). Query: `?:limit=N` |
| `GET /livequery/config` | Trạng thái config proxy (`{ id: "status", enabled: bool }`) |
| `GET /livequery/session` | Trạng thái login flow (`{ id: "login", inProgress: bool }`) |
| `GET /livequery/runtime` | Runtime info (`{ id: "runtime", realtimeUrl: "ws://..." }`) |

### Account sub-collections

| Path | Mô tả |
|------|--------|
| `GET /livequery/accounts/:accountId/hosts` | Danh sách remote environments (Desktop App hosts) của account |
| `GET /livequery/accounts/:accountId/projects` | Danh sách projects (từ `~/.codex/` config) của account |
| `GET /livequery/accounts/:accountId/chats` | Danh sách WHAM tasks/chats. Query: `?task_filter=current\|all` |
| `GET /livequery/accounts/:accountId/chats/:chatId/turns` | Turns của một chat. Nếu có pending input → bắt đầu SSE stream; realtime updates qua WS |
| `GET /livequery/accounts/:accountId/hosts/:hostId/projects` | Projects thuộc một host cụ thể |
| `GET /livequery/accounts/:accountId/hosts/:hostId/chats` | Chats thuộc một host cụ thể. Query: `?task_filter=current\|all` |

---

## LiveQuery – Actions

Actions gọi qua `POST /livequery/...~<action-name>`.  
Path trước `~` xác định context (account, chat, v.v.).  
Body là JSON.

### Account & Auth actions

| Action path | Body | Mô tả |
|-------------|------|--------|
| `POST /livequery/~refresh-usage` | – | Force refresh Codex usage của tất cả accounts |
| `POST /livequery/accounts/:id/~select-account` | `{ id? }` | Chọn account active. `id` lấy từ path hoặc body |
| `POST /livequery/accounts/:id/~remove-account` | `{ id? }` | Xóa account khỏi danh sách |
| `POST /livequery/~login-status` | – | Trả `{ inProgress: bool }` |
| `POST /livequery/~start-login` | – | Bắt đầu OAuth login flow. Trả `{ ok, authorizeUrl }` |
| `POST /livequery/~cancel-login` | – | Hủy login flow đang chờ |
| `POST /livequery/~import-callback` | `{ importInput }` hoặc `{ callbackUrl }` | Import account từ OAuth callback URL hoặc JSON token |

### Config actions

| Action path | Body | Mô tả |
|-------------|------|--------|
| `POST /livequery/~config-status` | `{ publicBaseUrl? }` | Kiểm tra proxy config có đang patch không |
| `POST /livequery/~set-config` | `{ enabled, restartCodex?, publicBaseUrl? }` | Bật/tắt proxy config trong `~/.codex/`. Tùy chọn restart app Codex |

### Chat / Task actions

> **Environment ID prefix:**
> - `selfhost:<env_id>` → chạy trên Desktop App qua thread-follower protocol
> - `cloud:<env_id>` → tạo WHAM cloud task
> - Bare `<env_id>` (không prefix) → mặc định cloud

| Action path | Body | Mô tả |
|-------------|------|--------|
| `POST /livequery/accounts/:id/~create-chat` | `{ input, environment_id?, model_slug? }` | Tạo chat mới. Với `selfhost:` → trả `chat_id` ngay (UUID local); với `cloud:` → gọi WHAM API |
| `POST /livequery/accounts/:id/chats/:chatId/~send-message` | `{ input, environment_id? }` | Gửi message tiếp theo vào chat đang có |
| `POST /livequery/accounts/:id/chats/:chatId/~cancel-chat` | – | Hủy task đang chạy |
| `POST /livequery/accounts/:id/chats/:chatId/~archive-chat` | – | Archive WHAM task |
| `POST /livequery/accounts/:id/chats/:chatId/~recover-chat` | – | Recover WHAM task đã archive |
| `POST /livequery/accounts/:id/chats/:chatId/~mark-read` | – | Đánh dấu đã đọc |

### Cache refresh actions

| Action path | Body | Mô tả |
|-------------|------|--------|
| `POST /livequery/accounts/:id/~refresh-hosts` | – | Force refresh danh sách hosts |
| `POST /livequery/~refresh-projects` | – | Force refresh danh sách projects |
| `POST /livequery/accounts/:id/~refresh-chats` | – | Force refresh danh sách chats |

---

## LiveQuery – WebSocket Realtime

**URL:** `ws://localhost:9878/livequery/realtime-updates`  
**Không cần JWT.**

Dùng để nhận realtime changes khi data thay đổi (accounts, hosts, chats, turns, reports).

### Subscribe vào collection

Gửi HTTP request tới bất kỳ LiveQuery collection nào kèm header:
```
x-lcid: <client-id>
```
Server tự động đăng ký subscription cho client đó.

### Message format từ server

```json
{
  "event": "sync",
  "data": {
    "changes": [
      {
        "ref": "accounts/<id>/chats/<chatId>/turns",
        "type": "added" | "modified" | "removed",
        "data": { ...document }
      }
    ]
  }
}
```

### Refs quan trọng

| Ref | Khi nào push |
|-----|-------------|
| `accounts` | Account thêm/xóa/update token/quota |
| `accounts/<id>/hosts` | Host list refresh |
| `accounts/<id>/chats` | Chat list refresh |
| `accounts/<id>/chats/<chatId>/turns` | SSE stream delta/completed (realtime streaming output) |
| `reports` | Event mới (login, error, account switch, v.v.) |
