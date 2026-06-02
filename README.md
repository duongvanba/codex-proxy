# Codex Proxy Manager

Proxy server quản lý nhiều tài khoản OpenAI/ChatGPT (Codex), tự động chuyển account khi bị rate limit, và cung cấp Web UI realtime để monitor và điều khiển Codex từ xa.

## Tính năng

- **Multi-account proxy**: Quản lý nhiều account, tự động chọn account active khi gửi request
- **Auto switch**: Tự động chuyển account khi bị rate limit hoặc quota hết
- **JWT gate**: Chỉ cho phép request từ client có JWT hợp lệ (plan plus/pro/max)
- **Remote control**: Kết nối tới Codex đang chạy trên máy khác qua WebSocket relay của OpenAI
- **Chat UI**: Xem và gửi tin nhắn tới các Codex session đang chạy
- **Daily routine**: Tự động warm-up quota mỗi sáng 7h
- **Realtime UI**: Web UI reactive qua LiveQuery WebSocket

## Cấu trúc dự án

Đây là một **monorepo** (Bun workspaces) gồm 2 app và 1 package dùng chung:

```
apps/
  honojs/          — Backend: Hono + Bun.serve (proxy, JWT gate, LiveQuery, remote control)
  remix-v2/        — Frontend: Remix + React 19 + Vite (Web UI)
packages/
  types/           — Shared types (@codex/types)
```

### `apps/honojs` — Backend

```
index.ts                       — composition root: new tất cả service, wire deps, Bun.serve + LiveQuery WebsocketGateway
src/
  controllers/                 — mỗi domain 1 controller class extends Hono (route trong constructor)
    _livequery.ts              — helper buildCtx + LivequeryDeps dùng chung
    accounts.livequery.ts      — collection accounts + doc rc-hosts + actions account/login/enroll/config + rc-shell (SSE)
    chats.livequery.ts         — collection chats (+ host-scoped) + actions send-message/cancel/archive/shell-command/approve
    turns.livequery.ts         — collection turns (history + realtime) + cloud SSE bridge
    hosts.livequery.ts         — collection hosts
    projects.livequery.ts      — collection projects (+ host-scoped)
    reports.livequery.ts       — collection reports (request log, events)
    runtime.livequery.ts       — doc config/session/runtime + /health
    proxy.livequery.ts         — reverse proxy /v1/* và /backend-api/* (JWT gate)
    web.livequery.ts           — static Web UI + enroll callback
    websocket.livequery.ts     — Codex WebSocket proxy handlers (cho Bun.serve)
  services/                    — class thường, dependency inject qua constructor
    livequery/                 — KERNEL chia sẻ giữa các controller LiveQuery
      store.ts                 — LivequeryStore: state + cache + gateway/publish + central event$ hook + refresh
      types.ts                 — Document types (Account/Host/Chat/Turn…) + helpers serialize
    accounts.ts                — AccountsService(auth) — account, trạng thái, usage
    proxy.ts                   — ProxyService(accounts, watcher, upstream) — reverse proxy + rate-limit switching
    watcher.ts                 — WatcherService(accounts) — theo dõi ~/.codex/auth.json
    sse-stream.ts              — SseStreamService — SSE multicast cho chat cloud (WHAM)
    broadcast.ts               — BroadcastService — bắc cầu report → LiveQuery realtime
    config-patcher.ts          — ConfigPatcherService — đọc/ghi ~/.codex/config.toml
    logger.ts                  — LoggerService — request log
    unsupported-routes.ts      — UnsupportedRoutesService(accounts, upstream) — fallback passthrough
  libs/                        — class bọc giao tiếp bên ngoài (external comm)
    openai/                    — AuthService, AuthGateService (JWT), EnrollmentService, LoginFlowService
    chatgpt/                   — ChatGPTClient (static helpers + fetch), CodexApiService, DailyRoutineService
    codex-remote-control/      — WebsocketRelay (WS, 1 connection/account), RemoteControlRegistry, crypto, types
    upstream/                  — UpstreamProxy — egress HTTP/WS thô tới upstream
  schemas/                     — account / api / chatgpt / sse types
```

> Mỗi controller LiveQuery nhận **chung một** `LivequeryStore` (kernel) + tự lo HTTP handler/action trong chính nó. Không còn monolith `LivequeryService`.

#### Kiến trúc: Dependency Injection + Composition Root

Backend theo chuẩn LiveQuery (`hono-bun-backend`):

- **Mọi service & controller là `class`.** Controller là `class extends Hono` (route đăng ký trong `constructor`, `super()` gọi đầu tiên). Service là class thường.
- **Chỉ `index.ts` được `new`.** Đây là composition root duy nhất: tạo mọi instance, truyền dependency xuống qua constructor. Không file nào khác tự `new Service()` hay dùng singleton module-level.
- **Giao tiếp bên ngoài gói trong `src/libs`.** Service chỉ điều phối; mọi `fetch`/WebSocket tới OpenAI/ChatGPT nằm trong `libs` (`ChatGPTClient`, `AuthService`, `UpstreamProxy`, …).
- **Kernel chia sẻ** `LivequeryStore` được `new` ở `index.ts` rồi inject xuống mọi controller LiveQuery. `broadcast.onReport(entry => lqStore.addReport(entry))` bắc cầu report → realtime; `lqStore.initWebsocketGateway(ws)` gắn gateway.

→ Test được không cần server/Mongo: `new ProxyController(mockProxy, …).request(...)`, `new AccountsService(mockAuth)` — mock là object thuần.

### `apps/remix-v2` — Frontend

```
app/
  page.tsx                                                — trang chủ: stats, account list
  accounts/[accountId]/page.tsx                           — danh sách hosts
  accounts/[accountId]/hosts/[hostId]/page.tsx            — tạo chat mới
  accounts/[accountId]/hosts/[hostId]/chats/[chatId]/page.tsx — route chat cụ thể
components/    — ChatPanel, ProjectSidebar, RemoteEnrollPanel, AccountCard, StatsGrid, ...
context/      — hosts-context, workspace-context
helpers/      — livequery-client, NextRoutingStyle (file-based routing kiểu Next)
```

#### ChatPanel — UX

- **Composer tách riêng (`memo`)** — khung nhập giữ state `input` cục bộ, nên gõ phím KHÔNG re-render danh sách turn (tránh lag khi hội thoại dài). Parent truyền `onSend/onCancel/onToggleTerminal` qua `useCallback` (stable) để `memo` có hiệu lực.
- **Sticky auto-scroll** — `useStickyScroll` (MutationObserver bắt cả turn mới lẫn token streaming) chỉ tự cuộn khi đang ở đáy. **Lăn chuột lên là dừng auto-scroll ngay** (listener `wheel`, `deltaY < 0`); cuộn lại tới đáy thì bật lại.
- **Optimistic không nhấp đúp** — tin vừa gửi hiện bubble tạm; khi turn user thật về (so id mới + nội dung) bubble tạm ẩn ngay trong cùng render (không chờ effect) nên không bị "hiện 2 lần".
- **Gửi tin** — không hiện chữ "Đang gửi"; nút send chuyển spinner + textbox bị disable. Khi agent chạy, status row "Đang xử lý…" (icon động) hiện ở cuối turn cuối.

## Cài đặt & Chạy

```bash
bun install
```

### Dev (backend + web cùng lúc)

```bash
bun run dev
```

- Backend (honojs): `http://localhost:9878` — proxy API + LiveQuery HTTP
- LiveQuery WS: `ws://localhost:9879/livequery/realtime-updates`
- Web UI (Remix dev): `http://localhost:3000`

Vite dev server proxy sẵn `/livequery`, `/v1`, `/backend-api` về backend `9878` nên mở Web UI ở `http://localhost:3000`.

### Chạy riêng từng phần

```bash
bun run dev:server     # backend, bun --watch apps/honojs/index.ts
bun run dev:web        # web, remix dev (port 3000)
bun run start:server   # backend không watch
```

### Build & typecheck

```bash
bun run build:web      # remix vite:build → apps/remix-v2/build
bun run build:types    # tsc --build packages/types
bun run typecheck      # tsc --build toàn workspace
```

> Lưu ý: `@livequery/core` và `@livequery/honojs` được trỏ tới đường dẫn local (`file:../../../../opensource/livequery/...`). Cần có repo `livequery` đặt cạnh dự án thì backend mới chạy được.

## Cấu hình Codex

Proxy endpoint để cấu hình vào Codex: `http://localhost:9878/v1`

Bấm **Install** trên Web UI để ghi `openai_base_url` vào `~/.codex/config.toml`, **Uninstall** để gỡ. UI hỏi có restart Codex không sau mỗi thao tác.

### LAN / máy khác truy cập

```bash
PROXY_HOST=0.0.0.0 PUBLIC_BASE_URL=http://<lan-ip>:9878 bun run dev:server
```

### TLS

```bash
PROXY_TLS=1 bun run dev:server   # cần certs/localhost.crt và certs/localhost.key
```

## LiveQuery Collections (GET)

| Path | Mô tả |
|------|-------|
| `accounts` | Danh sách accounts, status, usage |
| `reports` | Request log, login, config, token events |
| `config` | Trạng thái proxy config (singleton) |
| `session` | Thông tin session (singleton) |
| `runtime` | Thông tin runtime server (singleton) |
| `accounts/:id/hosts` | Danh sách hosts của account |
| `accounts/:id/projects` | Danh sách projects của account |
| `accounts/:id/chats` | Danh sách chats (tất cả) |
| `accounts/:id/rc-hosts` | Hosts hỗ trợ remote control |
| `accounts/:id/chats/:chatId/turns` | Turns của một chat |
| `accounts/:id/hosts/:hostId/projects` | Projects theo host |
| `accounts/:id/hosts/:hostId/chats` | Chats theo host |
| `accounts/:id/hosts/:hostId/chats/:chatId/turns` | Turns theo host |

## LiveQuery Actions (POST `~:action`)

### Account-level (`accounts/~:action` hoặc `accounts/:id/~:action`)

| Action | Mô tả |
|--------|-------|
| `start-login` | Bắt đầu OAuth flow, trả về `authorizeUrl` |
| `cancel-login` | Hủy login đang chờ |
| `login-status` | Kiểm tra login có đang chạy không |
| `import-callback` | Import account từ callback URL hoặc JSON |
| `select-account` | Chọn account active |
| `remove-account` | Xóa account |
| `refresh-usage` | Refresh usage từ ChatGPT API |
| `config-status` | Kiểm tra proxy config đã install chưa |
| `set-config` | Install/uninstall proxy config |

### Host (`accounts/:id/hosts/:hostId/~:action`)

| Action | Mô tả |
|--------|-------|
| `refresh-hosts` | Sync danh sách hosts từ API |
| `workspace-options` | Lấy branch và model options |
| `rc-enroll-start` | Bắt đầu đăng ký remote control |
| `rc-enroll-delete` | Xóa đăng ký remote control |

### Chat (`accounts/:id/chats/:chatId/~:action` hoặc theo host)

| Action | Mô tả |
|--------|-------|
| `create-chat` | Tạo chat mới, gửi message đầu tiên |
| `send-message` | Gửi follow-up message |
| `cancel-chat` | Hủy task đang chạy |
| `archive-chat` | Archive chat |
| `recover-chat` | Khôi phục chat đã archive |
| `mark-read` | Đánh dấu đã đọc |
| `refresh-chats` | Sync danh sách chats |
| `refresh-projects` | Sync danh sách projects |
| `rc-shell` | Gửi shell command qua remote control (streaming, route riêng `~rc-shell`) |

## Remote Control

Luồng kết nối tới Codex trên máy khác:

1. Vào trang Account → chọn Host
2. Bấm **Enroll** để lấy `clientId` + keypair (ECDSA P-256)
3. Chạy lệnh enroll trên máy target
4. Backend kết nối qua WebSocket relay `wss://chatgpt.com/backend-api/codex/remote/control/client`
5. Giao tiếp theo protocol: `device_key_challenge` → `device_key_proof` → `initialize` → `ready`

Token remote control hết hạn mỗi ~10 phút và được **auto-refresh ở MỖI lần (re)connect**: `WebsocketRelay` nhận một **token provider** (`getToken: () => Promise<string>`) qua constructor thay vì token tĩnh; pipeline `connect()` (rxjs `defer`) gọi lại provider mỗi lần subscribe, nên khi relay rớt và `retry` reconnect, nó luôn lấy token tươi (`RemoteControlRegistry.freshToken` → `EnrollmentService.refreshEnrollment` nếu token sắp/đã hết hạn). Trước đây token bị "nướng cứng" lúc tạo relay, khiến connection pooled không refresh được sau khi hết hạn → host-chats trả rỗng âm thầm.

> Lỗi fetch host-chats (relay rớt / token hỏng) **không còn bị nuốt**: `LivequeryStore.streamChats` để lỗi nổi lên controller → trả `502 UPSTREAM_ERROR` cho UI thấy, thay vì "0 chat im lặng".

Đặc tả giao thức đầy đủ: [`RELAY_WS_PROTOCOL.md`](RELAY_WS_PROTOCOL.md).

### Kiến trúc realtime (relay → LiveQuery)

`WebsocketRelay` ([libs/codex-remote-control/WebsocketRelay.ts](apps/honojs/src/libs/codex-remote-control/WebsocketRelay.ts)) + `LivequeryStore` ([services/livequery/store.ts](apps/honojs/src/services/livequery/store.ts)) phối hợp như sau:

- **1 WebSocket / ACCOUNT** (không phải /host). Relay định tuyến theo `env_id` đính **trong từng frame**, nên một kết nối phục vụ mọi host của account. Pool theo `account.id` trong `RemoteControlRegistry`.
- **`event$`** — `WebsocketRelay` gom **mọi** notification (mọi host) vào một Subject `event$`. `LivequeryStore.#hookRelayEvents` subscribe **1 lần/account**, demux mỗi event rồi publish vào đúng ref LiveQuery:
  - đổi trạng thái thread → ref `accounts/{id}/hosts/{env}/chats`
  - cập nhật item/turn → `turnRefs` của chat (ánh xạ relay `threadId` → URL `chatId`)
- **Stream token-by-token (`_delta`)** — `item/agentMessage/delta` được publish dạng **mảnh** `_delta` + `_seq` tăng dần (payload nhỏ); frontend cộng dồn. Kết thúc bằng doc `status:completed` chứa full text.
- **Tự emit `added` khi có chat mới** — `knownThreads` (seed từ `thread/list`) đánh dấu host "warm". Một `threadId` lạ trong event ⇒ chat mới ⇒ `LivequeryStore` fetch tên thật (`thread/list`) rồi publish `type:"added"`. Host chưa warm thì bỏ qua (tránh nhầm cả list cũ).
- **Lọc shell-thread** — lệnh ở panel **Terminal** (`rc-shell`) tạo một thread tạm (relay `thread/start`). `WebsocketRelay.shellThreadIds` đánh dấu các thread này; `LivequeryStore` bỏ qua chúng (không cho lọt vào danh sách chat).

### Terminal (shell)

Relay chỉ hỗ trợ **one-shot** (`thread/shellCommand`: chạy 1 lệnh → stream output qua `item/commandExecution/outputDelta` → `exitCode`). **Không có stdin/PTY/signal** ⇒ không có terminal tương tác thật. Vì vậy Terminal dùng **SSE** (route `~rc-shell`, half-duplex: server → client) + POST mỗi lệnh; huỷ lệnh đang chạy qua stop turn. Output terminal là ephemeral nên không đi qua LiveQuery.

## OAuth / Account

Tokens được lưu trong:
- `accounts.json` — OAuth tokens, identity
- `account-state.json` — selected account, status, request counts, usage cache

File `~/.codex/auth.json` được theo dõi tự động. Khi Codex refresh token, watcher import token mới vào `accounts.json`.

## JWT Gate

Tất cả request `/v1/*` (trừ `/v1/models`) và `/backend-api/*` phải có JWT hợp lệ:

- Signature verify với JWKS từ `https://auth.openai.com/.well-known/jwks.json`
- `iss` = `https://auth.openai.com`
- `alg` = `RS256`
- `chatgpt_plan_type` ∈ `{plus, pro, max}`

JWKS được cache 1 giờ. Management endpoints (`/livequery/*`, health, Web UI) không cần JWT.

## Daily Routine

Mỗi sáng 7h (Asia/Ho_Chi_Minh), server gửi warm-up message nhẹ cho từng account để giữ quota không bị reset.

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `DAILY_ROUTINE_TIME_ZONE` | `Asia/Ho_Chi_Minh` | Múi giờ |
| `DAILY_ROUTINE_HOUR` | `7` | Giờ chạy |
| `DAILY_ROUTINE_MINUTE` | `0` | Phút chạy |
| `DAILY_ROUTINE_CONCURRENCY` | `2` | Số account warm-up song song |
| `DAILY_ROUTINE_TIMEOUT_MS` | `15000` | Timeout mỗi request |
| `DAILY_ROUTINE_DISABLED` | - | Đặt `1` để tắt |

## Biến môi trường

### Server

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `PROXY_PORT` | `9878` | Port backend (HTTP + Codex WS proxy) |
| `LIVEQUERY_WS_PORT` | `9879` | Port LiveQuery WebSocket gateway |
| `PROXY_HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_BASE_URL` | `http://localhost:9878` | URL công khai (ghi vào config.toml) |
| `PROXY_TLS` | - | Đặt `1` để bật TLS (cần `certs/`) |

### Usage / quota

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `CODEX_DAILY_LIMIT` | `100` | Giới hạn daily fallback |
| `CODEX_WEEKLY_LIMIT` | `500` | Giới hạn weekly fallback |
| `CODEX_USAGE_TTL_SECONDS` | `60` | Cache usage TTL |
| `CODEX_USAGE_CONCURRENCY` | `3` | Parallel usage refresh |
| `CODEX_USAGE_TIMEOUT_MS` | `3000` | Timeout per usage request |

## Tests

```bash
bun test                # = bun test apps/honojs
bun test apps/honojs
```

## Troubleshooting

| Vấn đề | Giải pháp |
|--------|-----------|
| Port bận | Đặt `PROXY_PORT` / `LIVEQUERY_WS_PORT` khác hoặc dừng process cũ |
| Web UI không gọi được API | Backend phải chạy ở `9878`; Vite proxy `/livequery`, `/v1`, `/backend-api` về đó |
| `@livequery/core` not found | Thiếu repo `livequery` local cạnh dự án (xem package.json) |
| LAN không truy cập được | Chạy với `PROXY_HOST=0.0.0.0`, kiểm tra firewall macOS |
| Codex vẫn dùng endpoint cũ | Bấm Install, kiểm tra `~/.codex/config.toml`, restart Codex |
| Token expired | Login lại từ Web UI hoặc để watcher tự import từ `~/.codex/auth.json` |
| `401 Plan not allowed` | JWT có plan type không phải plus/pro/max |
| `401 Signature verification failed` | Token bị sửa hoặc không phải do OpenAI ký |
