# Codex Unlock — Patch Guide

Hướng dẫn patch Codex (OpenAI) Electron app để:

1. **Mở khoá toàn bộ route ẩn** trong Settings (Connections, Plugins, Skills, Keyboard Shortcuts, Codex Mobile)
2. **Bypass Secure Enclave** cho tính năng Remote Control bằng software P-256 key (không cần Apple Developer cert / Keychain của OpenAI)
3. **Bật Remote Connections** (showRemoteProjectItem, remote project từ máy khác)

> Tested trên macOS với Codex `v0.133.0-alpha.1` (Electron). Tên file JS thay đổi theo version — dùng `ls` để xác định đúng tên.

---

## Yêu cầu

```bash
# Bun (dùng thay npx)
curl -fsSL https://bun.sh/install | bash

# Electron tools
~/.bun/bin/bunx @electron/asar --version
~/.bun/bin/bunx @electron/fuses --version

# Python 3 (có sẵn trên macOS)
python3 --version
```

---

## Bước 1 — Extract ASAR

> ⚠️ **Cài vào `/Applications`, không dùng Desktop** — nếu chạy từ Desktop hoặc Downloads, macOS kích hoạt **App Translocation** (chạy app từ path tạm thời ngẫu nhiên), khiến worker process load từ sai bản và patch không có hiệu lực.

```bash
# Mount DMG
hdiutil attach Codex.dmg -nobrowse

# Copy thẳng vào /Applications (QUAN TRỌNG)
cp -R "/Volumes/Codex Installer 1/Codex.app" /Applications/Codex.app

# Eject
hdiutil detach "/Volumes/Codex Installer 1"

# Extract ASAR
mkdir -p ~/Downloads/codex-extracted-v2
~/.bun/bin/bunx @electron/asar extract \
  /Applications/Codex.app/Contents/Resources/app.asar \
  ~/Downloads/codex-extracted-v2
```

Xác nhận các file cần patch:

```bash
ls ~/Downloads/codex-extracted-v2/.vite/build/          # main-*.js
ls ~/Downloads/codex-extracted-v2/webview/assets/ | grep -E 'app-main|remote-connection-visibility|settings-page'
```

---

## Bước 2 — Mở khoá Route ẩn

### 2.1 — `remote-connection-visibility-*.js`

File chứa 2 hàm gate — dùng `replace_function_body` đúng cách (xem lưu ý bên dưới):

```python
filepath = 'webview/assets/remote-connection-visibility-Ozlfh2gg.js'  # điều chỉnh tên
content = open(filepath).read()

def replace_function_body(content, func_sig, new_body):
    """Tìm func_sig, skip qua () params, rồi mới thay body {}"""
    idx = content.find(func_sig)
    if idx < 0:
        raise ValueError(f"Not found: {func_sig}")
    # Skip closing ) của param list
    paren_start = content.find('(', idx)
    depth, i = 0, paren_start
    while i < len(content):
        if content[i] == '(': depth += 1
        elif content[i] == ')':
            depth -= 1
            if depth == 0: break
        i += 1
    # Tìm { body sau )
    start = content.find('{', i)
    depth, i = 0, start
    while i < len(content):
        if content[i] == '{': depth += 1
        elif content[i] == '}':
            depth -= 1
            if depth == 0:
                return content[:start+1] + new_body + content[i:]
        i += 1
    raise ValueError("Braces unmatched")

content = replace_function_body(content, 'function d()', 'return!0')  # Connections sidebar
content = replace_function_body(content, 'function f()', 'return!0')  # Control this Mac tab
open(filepath, 'w').write(content)
print("Done")
```

> ⚠️ **Lưu ý về `replace_function_body`:** Hàm `content.find('{', idx)` ngây thơ sẽ tìm nhầm `{` trong destructured parameters (ví dụ `function Qy({enabled:e,...})`), dẫn đến corrupt syntax. Phiên bản đúng ở trên skip qua `()` của param list trước.

### 2.2 — `settings-page-*.js`

```python
filepath = 'webview/assets/settings-page-mdGEmNCB.js'  # điều chỉnh tên
content = open(filepath).read()

for route in ['plugins-settings', 'skills-settings', 'keyboard-shortcuts']:
    old = f'case`{route}`:'
    new = f'case`{route}`:return!0;'
    assert old in content, f"Route not found: {route}"
    content = content.replace(old, new, 1)

open(filepath, 'w').write(content)
print("Done")
```

### 2.3 — `app-main-*.js` — Codex Mobile + Remote Connections

File này có 2 patch riêng biệt:

**Patch A — Codex Mobile gate (`Qy` / `Yy` tuỳ version)**

Tìm tên hàm đúng trước:
```bash
grep -o 'function [A-Za-z][A-Za-z0-9]*({enabled:e,hasCompletedCodexMobileSetup' \
  webview/assets/app-main-*.js
```

Body gốc là `{return e&&n&&r&&!t}` — thay bằng string replace trực tiếp (KHÔNG dùng `replace_function_body` vì hàm có destructured params):

```python
filepath = 'webview/assets/app-main-DG-Mf4Wj.js'  # điều chỉnh tên
content = open(filepath).read()

# Patch Codex Mobile gate (tên hàm thay đổi theo version: Yy, Qy, ...)
OLD_BODY = '{return e&&n&&r&&!t}function $y(e)'   # kiểm tra tên hàm kế tiếp
NEW_BODY = '{return!0}function $y(e)'
assert OLD_BODY in content, f"Mobile gate body not found"
content = content.replace(OLD_BODY, NEW_BODY, 1)
print("Codex Mobile gate patched")
```

> Nếu hàm tiếp theo không phải `$y`, xác định lại bằng cách grep tên hàm kế tiếp trong file.

**Patch B — Remote Connections gate (`Xv` selector)**

Gate `Xv` kiểm tra `config.features.remote_connections` từ API hoặc Statsig — luôn return false với tài khoản thường. Patch để luôn `return!0`:

```python
# Tìm Xv selector
idx = content.find('Xv=Wr(q,({get:e})=>{')
brace_start = content.find('{', idx + len('Xv=Wr(q,({get:e})=>'))
depth, i = 0, brace_start
while i < len(content):
    if content[i] == '{': depth += 1
    elif content[i] == '}':
        depth -= 1
        if depth == 0: break
    i += 1
content = content[:brace_start] + '{return!0}' + content[i+1:]
print("Remote connections gate (Xv) patched")

open(filepath, 'w').write(content)
```

---

## Bước 3 — Software Key cho Remote Control

File `main-*.js` trong `.vite/build/` chứa hàm load native module `remote-control-device-key.node` — module này yêu cầu Keychain access group `2DC432GLL2.*` của OpenAI, sẽ fail trên mọi app không được sign bởi OpenAI.

### 3.1 — Tìm tên hàm trong main process

```bash
# Tên hàm thay đổi theo version (OV, SU, ...)
grep -o 'function [A-Z][A-Za-z]*({resourcesPath:e})' \
  ~/Downloads/codex-extracted-v2/.vite/build/main-*.js

# Xác nhận payload builder (kV, CU, ...)
grep -o 'signDeviceKey:async(e,t)=>{let [a-z]=' \
  ~/Downloads/codex-extracted-v2/.vite/build/main-*.js
```

### 3.2 — Patch software key

Thay thế hàm native key factory bằng pure JS P-256 ECDSA, lưu keys vào `~/.codex/device-keys.json`.

Các biến module-level trong file (đã có sẵn):
- `r` = `require('node:os')` → `r.homedir()`
- `i` = `require('node:path')` → `(0,i.join)(...)`
- `o` = `require('node:fs')` → `o.readFileSync / o.writeFileSync / o.mkdirSync`
- `s` = `require('node:crypto')` → `s.generateKeyPairSync / s.createSign / s.randomUUID`

```python
filepath = '.vite/build/main-DVEWN1ng.js'  # điều chỉnh tên
content = open(filepath).read()

# Điều chỉnh: tên hàm (SU/OV), tên require var (vU/wV), const tên file (yU/TV), payload builder (CU/kV)
OLD = (
    'function SU({resourcesPath:e})'
    '{let t=null,n=()=>'
    '{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);'
    'if(e==null)throw Error(`Remote control device keys require resourcesPath`);'
    'return t??=vU((0,i.join)(e,`native`,yU)),t};'
    'return{'
    'createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),'
    'deleteDeviceKey:e=>n().deleteDeviceKey(e),'
    'getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),'
    'signDeviceKey:async(e,t)=>{let r=CU(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}'
    '}}'
)

NEW = (
    'function SU({resourcesPath:e}){'
    'let __sf=()=>{try{return JSON.parse(o.readFileSync((0,i.join)(r.homedir(),`.codex`,`device-keys.json`),`utf8`))}catch(e){return{}}};'
    'let __ss=st=>{'
      'try{o.mkdirSync((0,i.join)(r.homedir(),`.codex`),{recursive:!0})}catch(e){}'
      'o.writeFileSync((0,i.join)(r.homedir(),`.codex`,`device-keys.json`),JSON.stringify(st),`utf8`)'
    '};'
    'return{'
      'createDeviceKey:mode=>{'
        'let kp=s.generateKeyPairSync(`ec`,{namedCurve:`P-256`,'
          'publicKeyEncoding:{type:`spki`,format:`der`},'
          'privateKeyEncoding:{type:`pkcs8`,format:`pem`}});'
        'let keyId=s.randomUUID();'
        'let pub=kp.publicKey.toString(`base64`);'
        'let st=__sf();'
        'st[keyId]={p:kp.privateKey,b:pub};'
        '__ss(st);'
        'return{keyId,publicKeySpkiDerBase64:pub,algorithm:`ecdsa_p256_sha256`,protectionClass:`os_protected_nonextractable`}'
      '},'
      'deleteDeviceKey:keyId=>{'
        'let st=__sf();delete st[keyId];__ss(st)'
      '},'
      'getDeviceKeyPublic:keyId=>{'
        'let st=__sf();let k=st[keyId];'
        'if(!k)throw Error(`Device key not found: ${keyId}`);'
        'return{keyId,publicKeySpkiDerBase64:k.b,algorithm:`ecdsa_p256_sha256`,protectionClass:`os_protected_nonextractable`}'
      '},'
      'signDeviceKey:async(keyId,t)=>{'
        'let buf=CU(t);'  # điều chỉnh: CU → kV tuỳ version
        'let st=__sf();let k=st[keyId];'
        'if(!k)throw Error(`Device key not found: ${keyId}`);'
        'let sig=s.createSign(`SHA256`).update(buf).sign(k.p);'
        'return{keyId,publicKeySpkiDerBase64:k.b,algorithm:`ecdsa_p256_sha256`,protectionClass:`os_protected_nonextractable`,'
          'signatureDerBase64:sig.toString(`base64`),signedPayloadBase64:buf.toString(`base64`)}'
      '}'
    '}}'
)

assert OLD in content, "Hàm không tìm thấy — kiểm tra tên hàm và biến (xem Bước 3.1)"
content = content.replace(OLD, NEW, 1)
open(filepath, 'w').write(content)
print("Software key patched OK")
```

> **Tại sao `protectionClass: 'os_protected_nonextractable'`?**
> Server tại `/enroll/finish` chỉ chấp nhận `hardware_secure_enclave`, `hardware_tpm`, hoặc `os_protected_nonextractable`. Giá trị `software` bị reject 400.

---

## Bước 4 — Repack, Update Hash, Disable Fuse, Re-sign

```bash
cd ~/Downloads

# 1. Repack ASAR
~/.bun/bin/bunx @electron/asar pack codex-extracted-v2 /tmp/app-patched.asar

# 2. Tính SHA256 mới
NEW_HASH=$(shasum -a 256 /tmp/app-patched.asar | awk '{print $1}')
echo "New hash: $NEW_HASH"

# 3. Cập nhật Info.plist
python3 - <<EOF
import plistlib
new_hash = '${NEW_HASH}'
path = '/Applications/Codex.app/Contents/Info.plist'
with open(path, 'rb') as f:
    pl = plistlib.load(f)
pl['ElectronAsarIntegrity'] = {
    'Resources/app.asar': {'algorithm': 'SHA256', 'hash': new_hash}
}
with open(path, 'wb') as f:
    plistlib.dump(pl, f)
print("Info.plist updated:", new_hash)
EOF

# 4. Copy ASAR mới vào app
cp /tmp/app-patched.asar /Applications/Codex.app/Contents/Resources/app.asar

# 5. Disable ASAR integrity fuse (dùng "write" + "=off", không phải "set" + "=false")
~/.bun/bin/bunx @electron/fuses write \
  --app /Applications/Codex.app \
  EnableEmbeddedAsarIntegrityValidation=off

# 6. Re-sign ad-hoc (không dùng entitlements — thêm keychain-access-groups sẽ crash)
codesign --force --deep --sign - /Applications/Codex.app

# 7. Xoá quarantine flag — QUAN TRỌNG, tránh App Translocation
xattr -dr com.apple.quarantine /Applications/Codex.app

# 8. Verify
codesign --verify --deep /Applications/Codex.app && echo "Signature OK"
~/.bun/bin/bunx @electron/fuses read --app /Applications/Codex.app | grep -i integrity
```

---

## Bước 5 — Cấu hình API URL và OAuth Issuer

Codex dùng **2 lớp config riêng biệt** cho API endpoint:

| Layer | File / Cơ chế | Áp dụng cho |
|-------|---------------|-------------|
| Rust CLI (app-server) | `~/.codex/config.toml` → `openai_base_url` | Codex CLI gọi `api.openai.com/v1` |
| Electron main process | Environment variables | UI gọi `chatgpt.com/backend-api` + OAuth |

> ⚠️ **`config.toml` không ảnh hưởng đến Electron process.** Các biến env bên dưới mới kiểm soát được API mà giao diện dùng.

### 5.1 — Environment variables của Electron

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `CODEX_API_BASE_URL` | `https://chatgpt.com/backend-api` | Override toàn bộ API base URL của Electron UI |
| `CODEX_APP_SERVER_LOGIN_ISSUER` | `https://auth.openai.com` | Override OAuth issuer (authorization server) |
| `CODEX_API_ENDPOINT=localhost` | _(không set)_ | Bật dev mode, dùng `http://localhost:8000/api` |

> ⚠️ **KHÔNG set `CODEX_API_ENDPOINT=localhost` trước khi enroll Remote Control.** Enrollment key bao gồm API URL — nếu enroll qua `localhost:8000`, server sẽ revoke client ngay sau đó khi app kết nối vào production URL. Xem phần xử lý lỗi `Remote-control client has been revoked` bên dưới.

### 5.2 — Cách set Environment Variables (3 phương án)

#### Phương án A — `launchctl` (macOS, không cần patch lại ASAR)

```bash
launchctl setenv CODEX_API_BASE_URL "https://your-proxy.example.com/backend-api"
launchctl setenv CODEX_APP_SERVER_LOGIN_ISSUER "https://auth.openai.com"

pkill -f Codex; open /Applications/Codex.app
```

Xoá env:
```bash
launchctl unsetenv CODEX_API_BASE_URL
launchctl unsetenv CODEX_APP_SERVER_LOGIN_ISSUER
```

> `launchctl setenv` chỉ có hiệu lực cho session hiện tại. Dùng `launchd.plist` để persist qua reboot:

```bash
cat > ~/Library/LaunchAgents/com.codex.env.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.codex.env</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>
      launchctl setenv CODEX_API_BASE_URL "https://your-proxy.example.com/backend-api" &amp;&amp;
      launchctl setenv CODEX_APP_SERVER_LOGIN_ISSUER "https://auth.openai.com"
    </string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.codex.env.plist
```

#### Phương án B — Hardcode trực tiếp vào JS (cần repack ASAR)

```python
filepath = '.vite/build/main-DVEWN1ng.js'  # điều chỉnh tên
content = open(filepath).read()

PROXY_API = 'https://your-proxy.example.com/backend-api'
OAUTH_ISSUER = 'https://auth.openai.com'

content = content.replace('go=`https://chatgpt.com/backend-api`', f'go=`{PROXY_API}`')
content = content.replace('KB=`https://auth.openai.com`', f'KB=`{OAUTH_ISSUER}`')

open(filepath, 'w').write(content)
print("API URL patched:", PROXY_API)
```

#### Phương án C — Wrapper script

```bash
#!/bin/bash
export CODEX_API_BASE_URL="https://your-proxy.example.com/backend-api"
export CODEX_APP_SERVER_LOGIN_ISSUER="https://auth.openai.com"
open /Applications/Codex.app
```

### 5.3 — Config cho Rust CLI (config.toml)

```bash
python3 - <<'EOF'
import re, pathlib
cfg = pathlib.Path.home() / '.codex' / 'config.toml'
content = cfg.read_text() if cfg.exists() else ''
if 'openai_base_url' in content:
    content = re.sub(r'openai_base_url\s*=\s*"[^"]*"',
                     'openai_base_url = "https://your-proxy.example.com/v1"', content)
else:
    content += '\nopenai_base_url = "https://your-proxy.example.com/v1"\n'
cfg.write_text(content)
print("Done:", cfg)
EOF
```

---

## Bước 6 — Chạy app và test Remote Control

```bash
pkill -f "Codex" 2>/dev/null; sleep 1
open /Applications/Codex.app
```

### Flow authorize Remote Control

1. Mở **Settings → Connections → Control this Mac**
2. Click **Authorize** → trình duyệt mở OAuth với scope `codex.remote_control.enroll`
3. Đăng nhập / approve → browser redirect về `http://localhost:1455/auth/callback?code=...`
4. App nhận callback → `createDeviceKey()` tạo P-256 key lưu vào `~/.codex/device-keys.json`
5. `signDeviceKey()` ký challenge → POST `/codex/remote/control/client/enroll/finish`
6. Server trả 200 → enrollment thành công ✅

```bash
# Kiểm tra device key được tạo
cat ~/.codex/device-keys.json | python3 -m json.tool
```

---

## Lỗi thường gặp

| Lỗi | Nguyên nhân | Fix |
|-----|-------------|-----|
| App crash ngay khi mở (Code=163) | Thêm `keychain-access-groups` entitlement với ad-hoc signing | Sign lại **không** có entitlements |
| `errSecMissingEntitlement` (-34018) | Native module dùng Keychain group `2DC432GLL2.*` của OpenAI | Dùng software key (Bước 3) |
| `protection_class: software` rejected 400 | Server không chấp nhận giá trị này | Dùng `os_protected_nonextractable` |
| `EnableEmbeddedAsarIntegrityValidation` fail | ASAR hash không khớp sau repack | Update hash trong Info.plist + disable fuse |
| `createDeviceKey('hardware_only')` fail | Secure Enclave không available với ad-hoc signing | Software key bypass (Bước 3) |
| App treo màn hình loading (logo xoay mãi) | Patch `Qy()` dùng `replace_function_body` bị nhầm `{` trong params → syntax error crash webview | Dùng string replace trực tiếp lên body `{return e&&n&&r&&!t}` |
| Worker load từ `/Applications/Codex.app` trong khi app chạy từ `~/Desktop` | macOS App Translocation — app có quarantine flag | Cài vào `/Applications` + `xattr -dr com.apple.quarantine` |
| `Remote-control client has been revoked` (403) | Client đã enroll khi app đang dùng `localhost:8000` URL, server revoke | Xoá enrollment cũ và re-enroll (xem bên dưới) |

### Xử lý lỗi "Remote-control client has been revoked"

Server trả 403 khi client ID trong `~/.codex/.codex-global-state.json` bị thu hồi. Nguyên nhân phổ biến: enroll khi `CODEX_API_ENDPOINT=localhost` đang được set.

```python
import json, os, shutil

state_path = os.path.expanduser('~/.codex/.codex-global-state.json')
keys_path  = os.path.expanduser('~/.codex/device-keys.json')

# Backup
shutil.copy(state_path, state_path + '.bak')

with open(state_path) as f:
    state = json.load(f)

# Xoá enrollment bị revoke
removed = state.pop('electron-remote-control-client-enrollments', {})
print("Removed:", list(removed.keys()))

# Xoá env IDs để force re-discover
state.pop('added-remote-control-env-ids', None)

with open(state_path, 'w') as f:
    json.dump(state, f, indent=2)

# Xoá device keys cũ
if os.path.exists(keys_path):
    os.remove(keys_path)
    print("device-keys.json removed")

print("Restart app và enroll lại từ Settings → Connections")
```

---

## Cấu trúc files quan trọng

```
/Applications/Codex.app/         ← Cài ở đây, không dùng Desktop/Downloads
└── Contents/
    ├── Info.plist                ← ElectronAsarIntegrity SHA256
    ├── MacOS/Codex               ← Electron binary (fuses embedded)
    └── Resources/
        ├── app.asar              ← Bundle JS (cần repack sau patch)
        ├── app.asar.unpacked/    ← Native modules (không đụng vào)
        └── native/
            └── remote-control-device-key.node  ← Native module bị bypass

~/.codex/
├── config.toml                   ← openai_base_url cho Rust CLI
├── auth.json                     ← access_token, refresh_token
├── device-keys.json              ← Software P-256 keys (tạo sau enroll)
└── .codex-global-state.json      ← electron-remote-control-client-enrollments

codex-extracted-v2/               ← ASAR extracted
├── .vite/build/
│   └── main-DVEWN1ng.js          ← Main process (patch SU()/OV() ở đây)
└── webview/assets/
    ├── app-main-DG-Mf4Wj.js      ← Feature gates (Qy/Yy, Xv)
    ├── remote-connection-visibility-*.js  ← d(), f() gates
    └── settings-page-*.js        ← Route visibility switch
```

---

## Notes

- Tên file JS (hash suffix) thay đổi theo version. Dùng `ls` / `grep` để xác định.
- Tên hàm JS (Yy/Qy, OV/SU) cũng thay đổi theo version — luôn grep để tìm tên thật.
- Software key lưu private key PKCS#8 PEM trong JSON — **không commit hay export**.
- Ad-hoc signing hoạt động nhưng Gatekeeper sẽ warn lần đầu. Approve tại **System Settings → Privacy & Security**.
- Nếu app update, cần patch lại từ đầu với ASAR mới.
