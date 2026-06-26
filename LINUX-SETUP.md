# Codex trên Linux — Setup & Troubleshooting

Toàn bộ quá trình đưa Codex desktop (bản patch) chạy được trên Ubuntu, gồm cả việc
fix tính năng **Remote Control / "Control this Linux Desktop"** (device list).

> Tested: **Ubuntu 24.04.x**, **GNOME 46 (Wayland)**, GPU **AMD (amdgpu)**.
> codex CLI `@openai/codex`, daemon managed auto-update.
>
> **Vì sao macOS chạy ngon mà Linux phải vọc:** macOS có app Codex desktop **chính thức**
> (build sẵn, ký, tích hợp remote-control đúng chuẩn). Linux **KHÔNG có bản chính thức** →
> phải dùng bản tự build/patch (`codex-desktop-linux` → `/opt/Codex`, hoặc `codex-unlock`),
> và remote-control là tính năng **experimental**. Mọi lỗi dưới đây sinh ra từ chỗ đó.

---

## 0. Các thành phần (nắm cái này trước khi debug)

| Thành phần | Đường dẫn | Vai trò |
|---|---|---|
| App build "desktop-linux" | `/opt/Codex` | Electron app; launcher hệ thống `/usr/share/applications/codex-desktop.desktop` → `/usr/bin/codex-desktop` → `/opt/Codex/codex-desktop` |
| App "unlock" (bản hay dùng) | `~/.local/share/codex-unlock` | Electron riêng; **user** launcher `~/.local/share/applications/codex-desktop.desktop` → `codex-unlock/start.sh` |
| codex CLI | `/usr/local/bin/codex` | `@openai/codex` (npm global ở `/usr/local/lib/node_modules`). codex-unlock **spawn cái này** làm app-server |
| Managed daemon | `~/.codex/packages/standalone/current/codex` | Daemon remote-control, **tự auto-update**; socket `~/.codex/app-server-control/app-server-control.sock` |
| Web server (codex-unlock) | port **5176** (cố định) | KHÔNG single-instance |
| Log | `~/.codex/rc-daemon.log`, `~/.codex/app-server-daemon/app-server.stderr.log`, `~/.codex/log/codex-tui.log` | |

> ⚠️ **XDG override:** file `.desktop` ở `~/.local/share/applications` **đè** file cùng tên ở
> `/usr/share/applications`. Nên icon "Codex" trên launcher thực ra chạy **codex-unlock**, không
> phải `/opt/Codex`. Luôn kiểm tra `cat ~/.local/share/applications/codex-desktop.desktop`.

---

## 1. "Codex failed to start — Unable to locate the Codex CLI binary … bin/codex"

App (bản patch) tìm CLI ở `<resourcesPath>/bin/codex`, nhưng build chỉ đặt wrapper ở
`resources/codex` (thiếu thư mục `bin/`).

**Fix — tạo script (KHÔNG dùng symlink):**

```sh
sudo mkdir -p /opt/Codex/resources/bin
sudo tee /opt/Codex/resources/bin/codex >/dev/null <<'EOF'
#!/usr/bin/env sh
exec /opt/Codex/resources/node /opt/Codex/resources/codex-cli/node_modules/@openai/codex/bin/codex.js "$@"
EOF
sudo chmod +x /opt/Codex/resources/bin/codex
/opt/Codex/resources/bin/codex --version   # verify
```

> ⚠️ **Đừng symlink** `bin/codex -> ../codex`: wrapper gốc tự dò `DIR="$(dirname $0)"` rồi gọi
> `$DIR/node` → qua symlink thành `resources/bin/node` (không tồn tại) → lỗi. Phải là script
> đường dẫn **tuyệt đối**.

### 1b. codex-unlock — lỗi này khi bấm Enroll/Connections (⚠️ KHÁC `/opt/Codex`)

Với bản **codex-unlock**, lỗi `Unable to locate the Codex CLI binary` xuất hiện **chỉ ở code path
remote-control** (`refresh_local_remote_control_client_id`), trong khi connection chính vẫn chạy bình
thường. Lý do: app có **2 resolver binary khác nhau**:

- **Connection chính** (`StdioConnection`): đọc thẳng env `CODEX_CLI_PATH` (start.sh đã set
  `=/usr/local/bin/codex`) → chạy `node codex.js` → OK. Log: `Using CODEX_CLI_PATH=…`.
- **Connection remote-control** (`fF → gF → hF` trong `src-*.js`): resolver riêng, **không thấy
  env `CODEX_CLI_PATH`** trong context đó. `hF` thử lần lượt:
  1. `JP(process.env.CODEX_CLI_PATH)` → null (env không có trong process này)
  2. `JP(<resourcesPath>/codex)`            ← **chỗ cần đặt file**
  3. `JP(<resourcesPath>/app.asar.unpacked/codex)`

  codex-unlock không có file nào ở trên → `hF` trả null → ném lỗi. Lưu ý `hF` join
  `resourcesPath + "codex"` (**KHÔNG** phải `bin/codex`); thông báo "include bin/codex" chỉ là text
  generic. `JP/XP` chỉ check `statSync(path).isFile()` (theo cả symlink) — không cần ELF, nhưng phải
  là **binary chạy được không cần node** (vì spawn context có thể thiếu node trên PATH).

**Fix — symlink ELF native (KHÔNG dùng `codex.js`) vào đúng candidate #2:**

```sh
R="$HOME/.local/share/codex-unlock/resources"
N="/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
ln -sf "$N" "$R/codex"           # native ELF, self-contained; KHÔNG phải resources/bin/codex
"$R/codex" --version             # verify: codex-cli 0.139.0
# restart codex-unlock để code path remote-control nhận binary
```

> - Ở đây **symlink OK** (khác cảnh báo mục 1 cho `/opt/Codex`): ta trỏ thẳng tới ELF native
>   self-contained, không qua wrapper `$DIR/node` nào.
> - Trỏ tới **vendor ELF** (`@openai/codex-linux-x64/vendor/.../bin/codex`), KHÔNG trỏ
>   `/usr/local/bin/codex` (đó là `codex.js` cần node — spawn remote-control có thể không có node).
> - Path vendor **không chứa số version** → symlink vẫn đúng khi `npm i -g @openai/codex@latest`
>   cập nhật tại chỗ; chỉ mất khi cài lại/đổi bản codex-unlock.
> - Đã áp dụng: `flygo-sv2@192.168.2.3`, `dangnv@192.168.4.2`.

---

## 2. Icon launcher sai / app mở ra một entry không có icon

Cửa sổ codex-unlock có `app_id=codex-unlock`, nhưng `.desktop` tên `codex-desktop` và
`StartupWMClass=Codex` → GNOME không khớp được cửa sổ với launcher → hiện thành entry riêng
không icon.

**Fix:**

```sh
sed -i 's/^StartupWMClass=.*/StartupWMClass=codex-unlock/' \
  ~/.local/share/applications/codex-desktop.desktop
update-desktop-database ~/.local/share/applications
```

Ghim vào dock (favorites):

```sh
# thêm 'codex-desktop.desktop' vào org.gnome.shell favorite-apps
gsettings get org.gnome.shell favorite-apps   # xem hiện tại rồi set lại có thêm entry
```

---

## 3. GNOME Remote Desktop: "Allow this device to be discovered and controlled" không bật được

**Nguyên nhân:** phiên đăng nhập là **X11** (máy autologin vào `Session=ubuntu-xorg`).
GNOME Remote Desktop → Desktop Sharing **yêu cầu Wayland**; trên X11 toggle bị mờ.

**Fix — đổi phiên mặc định sang Wayland:**

```sh
sudo cp -a /var/lib/AccountsService/users/<user> /var/lib/AccountsService/users/<user>.bak
sudo sed -i 's/^Session=ubuntu-xorg/Session=ubuntu-wayland/' /var/lib/AccountsService/users/<user>
sudo reboot
# verify sau reboot:
loginctl show-session <id> -p Type   # phải = wayland
```

> GPU AMD chạy Wayland tốt; GDM **không** cần sửa (`#WaylandEnable=false` để comment là OK).
> Sau khi vào Wayland, bật toggle trong Settings → tự sinh TLS cert.

---

## 4. codex-unlock — bấm icon ra báo lỗi (xung đột port 5176)

codex-unlock chạy 1 web server ở **port 5176 cố định** và **KHÔNG single-instance**. Mở
instance thứ 2 khi cái đầu còn giữ 5176 → bind fail → báo lỗi.

→ **Chỉ chạy 1 instance.** Reset sạch khi kẹt:

```sh
pkill -9 -f codex-unlock; pkill -9 -f webview-server.py; pkill -9 -f "codex app-server"
ss -ltn | grep 5176 || echo "5176 FREE"
```

---

## 5. "Control this Linux Desktop" — device list KHÔNG load  ⭐ (phần khó nhất)

Nhiều nguyên nhân chồng nhau. Auth (ChatGPT) và mạng tới OpenAI **không** phải vấn đề
(`chatgpt.com` trả 403 / `api.openai.com` trả 421 cho request trần là **bình thường**).

### 5a. bwrap sandbox bị Ubuntu 24.04 chặn

Codex app-server dùng **bubblewrap (bwrap)**; Ubuntu 24.04 chặn unprivileged user namespaces.
Log báo: *"Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."*

**Fix (persistent):**

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo "kernel.apparmor_restrict_unprivileged_userns=0" | sudo tee /etc/sysctl.d/99-codex-userns.conf
sudo sysctl --system
bwrap --ro-bind / / --dev /dev true && echo "bwrap OK"   # test
```

### 5b. Daemon remote-control không chạy

Device list cần daemon `app-server-control` chạy nền (tạo socket + đăng ký lên cloud).
Sau reboot daemon **không tự sống lại**, mở app cũng không tự dựng → phải start:

```sh
codex remote-control start --json      # start daemon + đăng ký
ls -la ~/.codex/app-server-control/app-server-control.sock   # socket phải xuất hiện
codex remote-control stop              # dừng khi cần
# (xem thêm: codex app-server daemon --help)
```

### 5c. Lệch version codex CLI ↔ managed daemon  ⭐ (nguyên nhân chính)

codex-unlock spawn `/usr/local/bin/codex` (vd **0.133**), nhưng managed daemon **tự auto-update**
lên bản mới (**0.136 / 0.139**) → **lệch protocol** → load inventory fail.

**Fix — nâng codex CLI hệ thống lên latest cho khớp daemon:**

```sh
sudo npm install -g --prefix /usr/local @openai/codex@latest
/usr/local/bin/codex --version   # phải bằng version daemon
```

> ⚠️ **Bắt buộc `--prefix /usr/local`** — codex được cài ở `/usr/local/lib/node_modules`,
> KHÁC `npm root -g` mặc định (`/usr/lib`). Không có prefix sẽ cài nhầm chỗ, `codex` vẫn 0.133.
> Rollback nếu codex-unlock kỵ bản mới: `sudo npm install -g --prefix /usr/local @openai/codex@0.133.0`.

### Quy trình fix gọn cho mục 5

```
1. Mở khoá userns           (5a)
2. Nâng codex CLI = latest   (5c)   ← khớp version daemon
3. Kill sạch codex + xoá socket/lock cũ:
     pkill -9 -f codex-unlock; pkill -9 -f webview-server.py; pkill -9 -f "codex app-server"
     rm -f ~/.codex/app-server-control/* ~/.codex/app-server-daemon/*.lock
4. Mở Codex ĐÚNG 1 LẦN → daemon tự lên (auto-update khớp version) → device list load ✅
```

---

## Notes / Pitfalls (đọc lại trước khi vọc lần sau)

- **Chỉ 1 instance** codex-unlock cùng lúc (kỵ port 5176).
- **Không symlink** `bin/codex` — wrapper dò `$DIR`, symlink làm sai → dùng script tuyệt đối.
- **Daemon remote-control không auto-start sau reboot.** Mở app dựng lại, hoặc `codex remote-control start`.
- **Luôn giữ codex CLI cùng version với managed daemon** (cả hai = latest). Daemon ở
  `~/.codex/packages/standalone` tự update; CLI `/usr/local/bin/codex` phải theo kịp.
- **GNOME Wayland chặn screenshot headless** (`AccessDenied` qua D-Bus/SSH) — không chụp màn hình
  từ xa được; debug bằng đọc log.
- **Launch GUI app từ SSH:** dùng `gtk-launch codex-desktop` hoặc `systemd-run --user`. `nohup &`
  qua SSH bị SIGHUP dọn khi đóng session → app chết.
- userns fix **persistent** qua `/etc/sysctl.d/99-codex-userns.conf` (sống qua reboot).
- Set env cho lệnh user qua SSH: `export XDG_RUNTIME_DIR=/run/user/1000` +
  `export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`.

---

## Máy đã áp dụng

- **`flygo-sv2@192.168.2.3`** (hostname `dangnv`) — Ubuntu 24.04, AMD RX 6600. Device list chạy được
  sau khi: mở userns + nâng codex `0.133 → 0.139` + start daemon. Đã fix bin/codex, icon, Wayland.
  Enroll software-key chạy OK (`enrollment_finish_response`, `protectionClass=os_protected_nonextractable`).
  Đã thêm fix **`resources/codex` → ELF native** (mục 1b) cho code path remote-control.
- **`dangnv@192.168.4.2`** — AMD RX 6400. Đã chuyển Wayland + `apt full-upgrade` (kernel 6.17.0-35),
  nâng codex CLI = `0.139`, mở userns persistent, thêm fix **`resources/codex` → ELF native** (mục 1b).
  Còn lại: cần đăng nhập ChatGPT trong app để Enroll device.
