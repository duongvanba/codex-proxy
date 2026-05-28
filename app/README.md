# Codex Remote Mobile

Prototype React Native/Expo để điều khiển Codex Desktop từ mobile hoặc web preview.

## Cấu Trúc

- `mobile/`: app Expo React Native.
- `mobile/src/openaiCodexApi.ts`: lớp API client dùng cho login, host, project, chat và approval.
- `mobile/scripts/dev-auth-server.mjs`: helper dev-only đọc `~/.codex/auth.json` qua localhost để test mà không cần copy token vào UI.
- `extracted/source/`: source Electron đã giải nén từ `bin/Codex.dmg` để đối chiếu behavior của Codex Desktop.

## Tính Năng Hiện Có

- Login screen với API base, access token, account id và bước authorize remote control.
- Nếu không nhập token, web preview sẽ thử gọi helper dev auth tại `http://127.0.0.1:8787/auth`.
- Màn chọn host lấy danh sách Codex Desktop remote-control environments từ ChatGPT backend.
- Màn project hiển thị project và chat theo dạng preview.
- Tạo project mới bằng modal chọn thư mục từ cây thư mục mock.
- Tạo chat mới bằng nút `+` cạnh từng project.
- Màn chat có danh sách tin nhắn, gửi tin nhắn, approval modal lớn căn giữa và nền mờ.
- Dark mode, gradient background và markdown/code-style rendering cơ bản cho response.

## Chạy App

```bash
cd app/mobile
bun install
bun run web -- --port 8082 --clear
```

URL đang dùng cho web preview:

```text
http://192.168.2.2:8082/
```

Chạy helper auth dev ở terminal khác:

```bash
cd app/mobile
bun run dev-auth
```

Helper này chỉ bind `127.0.0.1:8787`, đọc `~/.codex/auth.json`, trả về access token/account id cho app qua localhost. Không in token ra console.

## Kết Quả Đọc Từ Codex.dmg

Codex macOS là Electron app. Bundle cho thấy host remote-control không lấy từ endpoint cũ `/backend-api/codex/remote-control/connections`.

Endpoint host thật:

```http
GET https://chatgpt.com/backend-api/codex/remote/control/environments?limit=100
```

Response có `env_id`, `display_name`, `host_name`, `online`, `busy`, `os`, `arch`, `app_server_version`, `client_type`, `last_seen_at`.

Codex Desktop map host id nội bộ như sau:

```ts
const hostId = `remote-control:${env_id}`;
```

Endpoint `/backend-api/wham/remote/control/clients` vẫn tồn tại nhưng chỉ trả device/client enrollment info. Nó không phải nguồn chính cho project sidebar.

## Project Remote

Không thấy endpoint HTTP dạng `/backend-api/codex/hosts/{hostId}/projects` trong bundle. Các endpoint đoán theo pattern này trả `404`.

Desktop dựng danh sách project remote từ state/config local:

- `~/.codex/codex-app/config.json`: cấu hình managed SSH connections và project seed.
- `~/.codex/.codex-global-state.json`: global state, key `remote-projects`.
- App-server inbox/recent conversations: gắn chat/thread vào project trong sidebar.

Shape project trong global state:

```json
{
  "id": "uuid",
  "hostId": "remote-control:env_e_...",
  "remotePath": "/Users/name/dev/project",
  "label": "project"
}
```

Vì vậy app mobile muốn load project thật cần thêm bridge tới Codex Desktop/app-server trên host remote để đọc `remote-projects` và inbox/recent conversations. ChatGPT backend hiện chỉ xác nhận host/environment đang online.

## Trạng Thái API Trong Prototype

- `listHosts`: đã dùng endpoint thật `/backend-api/codex/remote/control/environments`.
- `listProjects`: đang dùng preview data vì chưa có transport tới desktop state.
- `listFolders`, `createProject`, `createChat`, `readChat`, `sendMessage`, `approveRequest`: vẫn là wrapper dự kiến, fallback mock để UI test được.

## Tài Liệu Liên Quan

- `../codex_api.md`: ghi chú endpoint đã trích từ DMG và test bằng token local.
