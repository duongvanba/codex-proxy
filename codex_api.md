# Danh Sách API Của Codex.dmg

Nguồn: reverse-engineer từ `bin/Codex.dmg` — Electron app `openai-codex-electron` v26.519.81530.  
Bundle chính phân tích: `.vite/build/main-DVEWN1ng.js` (1.2 MB), `webview/assets/app-main-DG-Mf4Wj.js` (654 KB), `webview/assets/codex-api-5vE1HRY8.js`, `webview/assets/src-DAzAmbVS.js`, `webview/assets/use-recording-waveform-DgC3eTOX.js`.

App không kèm OpenAPI schema; ý nghĩa tham số suy luận từ bundle và proxy server.

---

## Base URL & Routing

```
Production:  https://chatgpt.com
Dev mode:    http://localhost:8000/api
```

Base URL được chọn trong main process (`qd()` function):

```javascript
function qd(e) {
  let t = process.env.CODEX_API_BASE_URL;
  return t && t.trim().length > 0
    ? t.replace(/\/+$/, '')      // env var override — dùng khi có proxy
    : process.env.CODEX_API_ENDPOINT?.toLowerCase() === 'localhost'
      ? 'http://localhost:8000/api'      // dev mode
      : 'https://chatgpt.com/backend-api'  // production
}
```

Proxy của chúng ta patch `openai_base_url` trong `~/.codex/config.toml` để CLI dùng proxy. Desktop app dùng `CODEX_API_BASE_URL` env var hoặc hardcode `chatgpt.com`.

---

## Headers Chung

| Header | Giá trị |
|---|---|
| `Authorization` | `Bearer <accessToken>` |
| `ChatGPT-Account-Id` | Account/workspace ChatGPT ID (`accountId` trong JWT) |
| `OpenAI-Beta` | `responses=experimental` — chỉ cho endpoint `/codex/responses` |
| `Origin` | `https://chatgpt.com` |
| `Referer` | `https://chatgpt.com/` |
| `Originator` | `codex_cli_rs` |
| `Version` | `0.133.0` (phiên bản CLI) |
| `User-Agent` | `codex_cli_rs/0.133.0 (Mac OS; arm64)` |
| `Accept` | `text/event-stream` (SSE) hoặc `application/json` |
| `Content-Type` | `application/json` |
| `X-Oai-Web-Search-Eligible` | `true` |

> **Quan trọng:** `Origin` và `Referer` phải là `https://chatgpt.com` — browser không thể tự set → mọi request phải đi qua server-side proxy.

---

## 1. Codex Core (AI Stream)

| Method | Endpoint | Ý nghĩa |
|---|---|---|
| `POST` | `/backend-api/codex/responses` | **Main AI stream** — SSE. Body theo Responses API. Proxy rewrite `/v1/responses` → endpoint này |
| `WS` | `wss://chatgpt.com/backend-api/codex/responses` | WebSocket thay cho SSE (proxy dùng khi client connect WS) |

Body request:
```json
{
  "model": "gpt-5.5",
  "instructions": "You are Codex...",
  "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "..." }] }],
  "tools": [],
  "tool_choice": "none",
  "parallel_tool_calls": false,
  "reasoning": { "effort": "medium" },
  "store": false,
  "stream": true,
  "include": []
}
```

Response là SSE stream với các event types (xem Section 7 — App-Server Event Types).

---

## 2. Remote Control Environments (Hosts)

| Method | Endpoint | Tham số | Ý nghĩa |
|---|---|---|---|
| `GET` | `/backend-api/codex/remote/control/environments` | query `limit=100`, `cursor` | Liệt kê Desktop hosts đang online. Pagination qua cursor |
| `PATCH` | `/backend-api/codex/remote/control/environments/{env_id}` | path `env_id`, body chưa rõ | Cập nhật metadata host |
| `DELETE` | `/backend-api/codex/remote/control/environments/{env_id}` | path `env_id` | Xóa/revoke host |

Response `GET environments`:
```json
{
  "items": [{
    "env_id": "env_e_6a1322c1a0b08333a30ab38195990764",
    "kind": "single",
    "display_name": "MacBook-Air",
    "host_name": "MacBook-Air.local",
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

Desktop map: `hostId = \`remote-control:${env_id}\``

---

## 3. Remote Control Client Enrollment

Enrollment để lấy `remote_control_token` cho kết nối WebSocket relay. Key pair có thể tự generate bằng software (ECDSA), không cần hardware/Secure Enclave.

| Step | Method | Endpoint | Body |
|---|---|---|---|
| Start enrollment | `POST` | `/backend-api/codex/remote/control/client/enroll/start` | `{ client_type, ... }` |
| Finish enrollment | `POST` | `/backend-api/codex/remote/control/client/enroll/finish` | `{ challenge_id, signature, ... }` |
| Refresh start | `POST` | `/backend-api/codex/remote/control/client/refresh/start` | `{}` |
| Refresh finish | `POST` | `/backend-api/codex/remote/control/client/refresh/finish` | `{ challenge_id, signature }` |

Response `enroll/start`:
```json
{ "client_id": "...", "device_key_challenge": { "challenge_id": "..." } }
```

Response `enroll/finish`:
```json
{ "client_id": "...", "remote_control_token": "...", "account_user_id": "..." }
```

Header khi dùng token: `x-codex-client-session-token: Bearer <remote_control_token>`

---

## 4. Remote Control WebSocket Channel

```
WSS wss://chatgpt.com/backend-api/codex/remote/control/client
Headers:
  x-codex-client-session-token: Bearer <remote_control_token>
  Authorization: Bearer <accessToken>
  ChatGPT-Account-Id: <accountId>
```

ChatGPT backend là **relay** giữa client và Desktop. Cả hai connect vào cùng endpoint; backend forward message.

### 4.1 Message Types — Client → Desktop

| Type | Key fields | Ý nghĩa |
|---|---|---|
| `fetch` | `requestId, url, method, headers?, body?` | Proxy một HTTP request qua Desktop |
| `cancel-fetch` | `requestId` | Hủy fetch |
| `fetch-stream` | `requestId, url, method, headers?, body?` | Proxy SSE stream qua Desktop |
| `cancel-fetch-stream` | `requestId` | Hủy stream |
| `shared-object-subscribe` | `key` | Subscribe shared state từ Desktop |
| `shared-object-unsubscribe` | `key` | Unsubscribe |
| `ipc-request` | `method, params, targetClientId?` | Gọi Electron IPC handler trên Desktop |
| `thread-follower-start-turn-request` | `requestId, hostId, ...params` | Bắt đầu turn Codex |
| `thread-follower-submit-user-input-request` | `requestId, hostId, ...params` | Gửi user input |
| `thread-follower-command-approval-decision-request` | `requestId, hostId, decision` | Approve/deny command |
| `thread-follower-file-approval-decision-request` | `requestId, hostId, decision` | Approve/deny file write |
| `thread-follower-interrupt-turn-request` | `requestId, hostId` | Dừng Codex đang chạy |
| `thread-follower-steer-turn-request` | `requestId, hostId, ...` | Steer hướng turn |
| `thread-follower-compact-thread-request` | `requestId, hostId` | Compact thread |
| `thread-follower-edit-last-user-turn-request` | `requestId, hostId, content` | Sửa turn cuối |
| `thread-follower-set-collaboration-mode-request` | `requestId, hostId, mode` | Set collaboration mode |
| `thread-follower-set-model-and-reasoning-request` | `requestId, hostId, ...` | Đổi model/reasoning |
| `thread-follower-set-queued-follow-ups-state-request` | `requestId, hostId, ...` | Queued follow-ups state |
| `thread-follower-permissions-request-approval-response` | `requestId, hostId, ...` | Permission approval |

### 4.2 Message Types — Desktop → Client

| Type | Key fields | Ý nghĩa |
|---|---|---|
| `fetch-response` | `requestId, responseType, status, headers?, bodyJsonString?` | HTTP response |
| `fetch-stream-event` | `requestId, event, data` | SSE event |
| `fetch-stream-complete` | `requestId` | Stream kết thúc |
| `fetch-stream-error` | `requestId, error` | Stream lỗi |
| `shared-object-updated` | `key, value` | State push từ Desktop |
| `thread-follower-*-response` | `requestId, ...` | Response tương ứng với mọi `*-request` |

### 4.3 Shared Object Keys

Subscribe bằng `{ type: "shared-object-subscribe", key: "<key>" }`. Desktop push snapshot ngay + update khi thay đổi.

| Key | Nội dung |
|---|---|
| `remote_control_connections` | Danh sách connections đang active |
| `remote_connections` | SSH connections đã config |
| `remote_control_connections_state` | State kết nối (`{ clientAuthorized, ... }`) |
| `host_config` | Config host hiện tại |
| `local_remote_control_enabled` | bool |
| `local_remote_control_environment_id` | env_id của host local |
| `local_remote_control_client_id` | client_id enrollment |
| `local_remote_control_installation_id` | installation id |
| `pending_worktrees` | Worktrees đang pending |
| `codex_chronicle_config` | Chronicle logging config |
| `codex_runtimes_config` | Runtime config |

### 4.4 IPC Methods (gọi qua `ipc-request`)

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

**Workspace/Files:**
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

**Thread/Session:**
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

**Git/Commit:**
- `generate-commit-message`
- `generate-commit-pull-request-message`
- `generate-pull-request-message`
- `apply-patch`
- `electron-clone-workspace-repo`

**Automation:**
- `automation-create` / `automation-update` / `automation-delete`
- `automation-run-now` / `automation-run-archive` / `automation-run-delete`
- `primary-runtime-update-run-now`

**System/Misc:**
- `account-info`
- `local-environment` / `local-environments` / `local-environment-config`
- `child-processes`
- `x-codex-client-session-token`
- `main-message`
- `call-app-plugin-request`

---

## 5. WHAM Cloud Tasks

Tất cả endpoint dưới đây dùng prefix `/backend-api/wham/`.

| Method | Endpoint | Tham số | Ý nghĩa |
|---|---|---|---|
| `GET` | `/wham/tasks/list` | query `task_filter=current`, `limit` (max 20) | Liệt kê cloud tasks |
| `GET` | `/wham/tasks/{task_id}` | path `task_id` | Chi tiết task |
| `GET` | `/wham/tasks/{task_id}/turns` | path `task_id` | Conversation turns |
| `GET` | `/wham/tasks/{task_id}/turns/{turn_id}` | path `task_id, turn_id` | Chi tiết turn |
| `GET` | `/wham/tasks/{task_id}/turns/{turn_id}/logs` | path `task_id, turn_id` | Logs của turn |
| `GET` | `/wham/tasks/{task_id}/turns/{turn_id}/pr` | path `task_id, turn_id` | Lấy PR của turn |
| `POST` | `/wham/tasks` | body task | Tạo task mới hoặc follow-up |
| `POST` | `/wham/tasks/{task_id}/cancel` | path `task_id` | Hủy task đang chạy |
| `POST` | `/wham/tasks/{task_id}/mark_read` | path `task_id` | Đánh dấu đã đọc |
| `POST` | `/wham/tasks/{task_id}/archive` | path `task_id` | Archive task |
| `POST` | `/wham/tasks/{task_id}/recover` | path `task_id` | Khôi phục task đã archive |
| `POST` | `/wham/tasks/{task_id}/turns/{turn_id}/pr` | body PR config | Tạo PR từ turn |

Body tạo task mới:
```json
{
  "new_task": true,
  "input_items": [{ "role": "user", "content": "..." }],
  "environment_id": "env_e_...",
  "branch": "main",
  "metadata": { "model_slug": "gpt-5.5", "best_of_n": 1 }
}
```

Body follow-up:
```json
{
  "follow_up": { "task_id": "task_e_...", "turn_id": "...", "environment_mode": "ask" },
  "input_items": [{ "role": "user", "content": "..." }]
}
```

Body tạo PR:
```json
{
  "mode": "create",
  "add_codex_tag": true,
  "hide_pr_title_and_body": false,
  "additional_labels": []
}
```

---

## 6. WHAM Environments, Git, Usage, Analytics

| Method | Endpoint | Tham số | Ý nghĩa |
|---|---|---|---|
| `GET` | `/wham/environments` | none | Liệt kê cloud environments |
| `GET` | `/wham/environments/by-repo/{provider}/{owner}/{repo}` | path params, `provider=github` | Tìm environment theo repo |
| `GET` | `/wham/github/branches/{repo_id}/search` | query `query`, `page_size`, `cursor` | Search branches GitHub |
| `GET` | `/wham/usage` | none | Rate limit / usage status |
| `GET` | `/wham/accounts/check` | none | Kiểm tra account có dùng được Codex cloud |
| `GET` | `/wham/onboarding/context` | none | Context onboarding |
| `POST` | `/wham/referrals/invite` | body `{ referral_key, emails }` | Gửi invite referral |
| `POST` | `/wham/worktree_snapshots/upload_url` | body `{ repo_name, filename, content_type, anticipated_file_size }` | Xin presigned URL upload snapshot |
| `POST` | `/wham/worktree_snapshots/finish_upload` | body `{ file_id, etag }` | Hoàn tất upload snapshot |
| `POST` | `/wham/analytics-events/events` | body `{ events: [{ event_type, event_params }] }` | Gửi analytics events (turn_rating, action) |
| `POST` | `/wham/apps/google_drive/upload` | body chưa rõ | Upload file từ Google Drive |
| `GET` | `/wham/remote/control/clients` | none | Remote control clients (enrollment info) |
| `DELETE` | `/wham/remote/control/clients/{client_id}` | path `client_id` | Revoke/xóa client |
| `GET` | `/wham/remote/control/mfa_requirement` | none | Kiểm tra yêu cầu MFA |

Analytics event body:
```json
{
  "events": [{
    "event_type": "codex_turn_rating_event",
    "event_params": {
      "thread_id": "task_e_...",
      "turn_id": "...",
      "rating": 1,
      "created_at": 1748700000
    }
  }]
}
```

---

## 7. Account / Auth / Billing / Files

| Method | Endpoint | Tham số | Ý nghĩa |
|---|---|---|---|
| `GET` | `/backend-api/me` | none | Profile user hiện tại |
| `GET` | `/backend-api/accounts/check/{version}` | `version` | Kiểm tra account theo version |
| `GET` | `/backend-api/accounts/mfa_info` | none | Trạng thái MFA |
| `GET` | `/backend-api/accounts/{account_id}/settings` | path `account_id` | Settings account |
| `GET` | `/backend-api/accounts/{account_id}/users` | path `account_id` | Users trong workspace |
| `POST` | `/backend-api/accounts/send_add_credits_nudge_email` | body nhỏ | Email nhắc thêm credit |
| `GET` | `/backend-api/checkout_pricing_config/configs/{country_code}` | path `country_code` | Pricing theo quốc gia |
| `GET` | `/backend-api/payments/customer_portal` | none | Link billing portal |
| `GET` | `/backend-api/subscriptions/auto_top_up/settings` | none | Cấu hình auto top-up |
| `POST` | `/backend-api/subscriptions/auto_top_up/enable` | body settings | Bật auto top-up |
| `POST` | `/backend-api/subscriptions/auto_top_up/disable` | body nhỏ | Tắt auto top-up |
| `POST` | `/backend-api/subscriptions/auto_top_up/update` | body settings | Cập nhật auto top-up |
| `POST` | `/backend-api/files` | body metadata | Upload session cho file |
| `GET` | `/backend-api/files/download/{file_id}` | path `file_id` | Tải file |
| `POST` | `/backend-api/files/{file_id}/uploaded` | path `file_id` | Báo upload xong |
| `POST` | `/backend-api/transcribe` | audio/form body | Speech-to-text / dictation |
| `GET` | `/backend-api/beacons/home` | query không rõ | Home beacon data |
| `POST` | `/backend-api/beacons/event` | body event | Telemetry event |

---

## 8. Connectors (AIP)

| Method | Endpoint | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/aip/connectors/{connector_id}` | Thông tin connector |
| `GET` | `/backend-api/aip/connectors/{connector_id}/link` | Trạng thái/link |
| `GET` | `/backend-api/aip/connectors/{connector_id}/tos` | Terms of service |
| `GET` | `/backend-api/aip/connectors/{connector_id}/logo?theme={theme}` | Logo connector |
| `POST` | `/backend-api/aip/connectors/links/noauth` | Link connector không OAuth |
| `POST` | `/backend-api/aip/connectors/links/oauth` | Bắt đầu OAuth link |
| `POST` | `/backend-api/aip/connectors/links/oauth/callback` | Hoàn tất OAuth |

---

## 9. Browser Sidebar / Aura

| Method | Endpoint | Ý nghĩa |
|---|---|---|
| `GET` | `/backend-api/aura/site_status?site_url=<url>` | Kiểm tra browser sidebar có hỗ trợ trang hiện tại không |

---

## 10. OAuth / Login Flow

```
Auth server:  https://auth.openai.com
Authorize:    /oauth/authorize
Token:        /oauth/token
Callback:     http://localhost:1455/auth/callback  (Desktop intercept)
```

Tokens lưu tại `~/.codex/auth.json`:
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

---

## 11. Analytics / Statsig (https://chatgpt.com)

| Endpoint | Ý nghĩa |
|---|---|
| `https://chatgpt.com/ces/v1/rgstr` | Statsig event registration — log event của client |
| `https://chatgpt.com/ces/v1` | Statsig init options base |

---

## 12. App-Server Event Types (SSE từ `/codex/responses`)

Các event type trong stream SSE từ `/backend-api/codex/responses`:

**Agent messages:**
- `codex/event/agent_message` — message hoàn chỉnh từ agent
- `codex/event/agent_message_delta` — text delta đang stream
- `codex/event/agent_message_content_delta` — content delta
- `codex/event/agent_reasoning` — reasoning block
- `codex/event/agent_reasoning_delta` — reasoning delta
- `codex/event/agent_reasoning_raw_content` — raw reasoning
- `codex/event/agent_reasoning_raw_content_delta`
- `codex/event/agent_reasoning_section_break`

**Execution:**
- `codex/event/exec_approval_request` — yêu cầu approve command
- `codex/event/exec_command_begin` — bắt đầu chạy command
- `codex/event/exec_command_end` — kết thúc command
- `codex/event/exec_command_output_delta` — output delta (stdout/stderr)
- `codex/event/apply_patch_approval_request` — yêu cầu approve patch
- `codex/event/patch_apply_begin` / `codex/event/patch_apply_end` — apply patch

**Turn lifecycle:**
- `codex/event/item_started` / `codex/event/item_completed`
- `codex/event/task_started` / `codex/event/task_complete`
- `codex/event/turn_aborted`
- `codex/event/turn_diff` — diff kết quả
- `codex/event/session_configured`
- `codex/event/shutdown_complete`

**User interaction:**
- `codex/event/request_user_input` — yêu cầu user input
- `codex/event/user_message`
- `codex/event/elicitation_request`

**Plan:**
- `codex/event/plan_delta` / `codex/event/plan_update`

**MCP:**
- `codex/event/mcp_startup_update` / `codex/event/mcp_startup_complete`
- `codex/event/mcp_list_tools_response`
- `codex/event/mcp_tool_call_begin` / `codex/event/mcp_tool_call_end`
- `codex/event/dynamic_tool_call_request`

**Skills:**
- `codex/event/list_skills_response`
- `codex/event/list_remote_skills_response`
- `codex/event/list_custom_prompts_response`
- `codex/event/remote_skill_downloaded`

**Collaboration:**
- `codex/event/collab_agent_interaction_begin` / `codex/event/collab_agent_interaction_end`
- `codex/event/collab_agent_spawn_begin` / `codex/event/collab_agent_spawn_end`
- `codex/event/collab_close_begin` / `codex/event/collab_close_end`
- `codex/event/collab_resume_begin` / `codex/event/collab_resume_end`
- `codex/event/collab_waiting_begin` / `codex/event/collab_waiting_end`
- `codex/event/entered_review_mode` / `codex/event/exited_review_mode`

**Misc:**
- `codex/event/thread_name_updated`
- `codex/event/thread_rolled_back`
- `codex/event/undo_started` / `codex/event/undo_completed`
- `codex/event/token_count`
- `codex/event/web_search_begin` / `codex/event/web_search_end`
- `codex/event/view_image_tool_call`
- `codex/event/terminal_interaction`
- `codex/event/remote_task_created`
- `codex/event/raw_response_item`
- `codex/event/reasoning_content_delta` / `codex/event/reasoning_raw_content_delta`
- `codex/event/background_event`
- `codex/event/deprecation_notice`
- `codex/event/stream_error`
- `codex/event/warning`
- `codex/event/error`
- `codex/event/get_history_entry_response`
- `codex/event/skills_update_available`

---

## 13. Local State Files (Desktop)

| File | Nội dung |
|---|---|
| `~/.codex/auth.json` | OAuth tokens, account_id |
| `~/.codex/.codex-global-state.json` | Global state, key `remote-projects` |
| `~/.codex/codex-app/config.json` | SSH connections và project seeds |
| `~/.codex/app-server-control/` | Unix socket dir của local app-server |
| `~/.codex/config.toml` | `openai_base_url`, `model`, MCP servers, project trust levels |

Shape `remote-projects` trong global state:
```json
[{
  "id": "uuid",
  "hostId": "remote-control:env_e_...",
  "remotePath": "/Users/name/dev/project",
  "label": "project"
}]
```

SSH config shape (`~/.codex/codex-app/config.json`):
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

## 14. Endpoints KHÔNG Tồn Tại (trả 404)

```
/backend-api/codex/hosts/{hostId}/projects
/backend-api/codex/hosts/{hostId}/folders
/backend-api/codex/hosts/{hostId}/projects/{id}/chats
/backend-api/codex/remote-control/authorize   ← path hyphen sai
```

Desktop build danh sách project/chat từ local state, không có HTTP endpoint.

---

## 15. Proxy Server (port 17000)

File: [`index.ts`](index.ts), [`src/server/proxy.ts`](src/server/proxy.ts)

| Route | Xử lý |
|---|---|
| `POST /v1/responses` | Rewrite → `POST /backend-api/codex/responses` (SSE) |
| `WS /v1/responses` | Rewrite → `WSS wss://chatgpt.com/backend-api/codex/responses` |
| `ANY /v1/*` | Proxy → `https://api.openai.com` |
| `ANY /backend-api/*` | Proxy → `https://chatgpt.com/backend-api/*` |
| `GET /livequery/*` | LiveQuery API (accounts, hosts, chats, turns...) |
| `GET /health` | Health check |

Config.toml patching:
- Proxy set `openai_base_url = "http://{ip}:{port}/v1"` khi enable
- `restoreCodexConfig()` xóa khi disable (handles cả `localhost:*` và `opaip.amazingproxy.xyz`)
