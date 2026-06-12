# Codex Unlock — Patch Guide

Hướng dẫn patch Codex (OpenAI) Electron app để:

1. **Mở khoá toàn bộ route ẩn** trong Settings (Connections, Plugins, Skills, Keyboard Shortcuts, Codex Mobile)
2. **Bypass Secure Enclave** cho tính năng Remote Control bằng software P-256 key (không cần Apple Developer cert / Keychain của OpenAI)
3. **Bật Remote Connections** (showRemoteProjectItem, remote project từ máy khác)

> Tested trên macOS với Codex `26.609.30741` (Electron 42.1.0). Tên file JS thay đổi theo version — dùng `ls` để xác định đúng tên.

### Bảng ánh xạ tên hàm/biến theo version

| Vai trò | `v0.133.0-alpha.1` | `26.609.30741` |
|---|---|---|
| Mobile gate (app-main) | `Qy` / `Yy` | `BT` |
| RemoteConnections selector (app-main) | `Xv=Wr(q,…)` | `Nw=c(g,({get:e})=>…)` |
| Visibility gates (remote-connection-visibility) | `d()`, `f()` | `c()` (export `n`), `l()` (export `r`) |
| Device-key factory (main) | `SU` / `OV` | `xZ` |
| Native loader / filename const / payload builder | `vU` / `yU` / `CU` | `_Z` / `vZ` / `SZ` |
| Module vars os/path/fs/crypto (main) | `r` / `i` / `o` / `s` | **`i` / `a` / `s` / `c`** |

> ⚠️ Tên trên CHỈ đúng cho `26.609.30741`. Mỗi version phải grep lại (xem từng bước). Đặc biệt **module var os/path/fs/crypto đổi mỗi build** — sai biến là crash main process.

### Pitfall macOS mới (Sonoma/Sequoia+)

- **App Management protection:** không sửa được file *bên trong* `/Applications/Codex.app` (EPERM dù app user-owned) vì app do OpenAI ký. Giải pháp: dựng app đã patch **ngoài** `/Applications` (vd `~/Downloads/Codex-patched.app`), ký xong rồi `mv` cả bundle vào `/Applications` (move cả bundle thì được phép).
- **Framework bị đổi tên** `Codex Framework.framework` (không phải `Electron Framework`) → `bunx @electron/fuses --app` báo `ENOENT`. Dùng API `flipFuses` trỏ vào binary framework qua **symlink ngoài /tmp** (lib rewrite mọi path chứa `.app` về tên `Electron Framework`, nên path không được chứa `.app`).
- **Homebrew python hỏng pyexpat** (`_XML_SetAllocTrackerActivationThreshold`) → dùng `/usr/bin/python3` cho `plistlib`, đừng dùng python homebrew.

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

File chứa 2 hàm gate. Ở `26.609.30741` là `c()` (export `n`, gate `features.remote_connections`) và `l()` (export `r`, load gate qua statsig `1042620455`). Dùng **string replace trực tiếp** (hàm có cache `(0,s.c)(3)` nên chèn `return!0;` ở đầu body):

```python
filepath = 'webview/assets/remote-connection-visibility-3y45XFqA.js'  # điều chỉnh tên
content = open(filepath).read()

# Gate c() — quyết định hiển thị mục Connections (kiểm tra features.remote_connections)
assert 'function c(){let e=(0,s.c)(3),' in content
content = content.replace('function c(){let e=(0,s.c)(3),',
                          'function c(){return!0;let e=(0,s.c)(3),', 1)
# Gate l() — load gate
assert 'function l(){return i(`1042620455`)}' in content
content = content.replace('function l(){return i(`1042620455`)}',
                          'function l(){return!0}', 1)
open(filepath, 'w').write(content)
print("Done")
```

> ⚠️ **Tìm gate đúng:** grep `remote_connections` và `1042620455` trong file. Gate `c()` chứa `if(o?.config[\`features.remote_connections\`]===!0)return!0` — đó là hàm cần ép `return!0`. KHÔNG dùng `content.find('{', idx)` ngây thơ vì sẽ trúng `{` trong destructured params.

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

**Patch A — Codex Mobile gate (`BT` ở 26.609; `Qy`/`Yy` ở bản cũ)**

Tìm tên hàm đúng trước (grep theo destructured params, ổn định hơn tên hàm):
```bash
grep -o 'function [A-Za-z][A-Za-z0-9]*({enabled:e,hasCompletedCodexMobileSetup[^)]*)' \
  webview/assets/app-main-*.js
```

Ở `26.609` là `function BT({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}`. Thay nguyên hàm bằng string replace trực tiếp (KHÔNG dùng brace-walk vì có destructured params):

```python
filepath = 'webview/assets/app-main-CfLW6VUn.js'  # điều chỉnh tên
content = open(filepath).read()

OLD = 'function BT({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return e&&n&&r&&!t}'
NEW = 'function BT({enabled:e,hasCompletedCodexMobileSetup:t,remoteControlFeaturesVisible:n,remoteControlOnboardingEnabled:r}){return!0}'
assert OLD in content, "Mobile gate not found — grep lại tên hàm"
content = content.replace(OLD, NEW, 1)
print("Codex Mobile gate (BT) patched")
```

**Patch B — Remote Connections selector (`Nw` ở 26.609; `Xv` ở bản cũ)**

Selector kiểm tra `config.features.remote_connections` từ API/Statsig — false với tài khoản thường. Ở `26.609` là `Nw=c(g,({get:e})=>{…})`. Grep tìm rồi ép `=>!0`:

```bash
grep -oE '[A-Za-z0-9_$]{1,4}=c\(g,\(\{get:e\}\)=>\{let t=e\([^)]*\)\.data\?\.config[^}]*remote_connections[^}]*\}\)' \
  webview/assets/app-main-*.js
```

```python
OLD = 'Nw=c(g,({get:e})=>{let t=e($o,e(Ft)).data?.config,n=e(go,`4114442250`);if(t?.[`features.remote_connections`]===!0)return!0;let r=t?.features;return typeof r!=`object`||!r||Array.isArray(r)?n:Object.getOwnPropertyDescriptor(r,`remote_connections`)?.value===!0||n})'
NEW = 'Nw=c(g,({get:e})=>!0)'
assert OLD in content, "Nw selector not found — grep lại"
content = content.replace(OLD, NEW, 1)
print("Remote connections selector (Nw) patched")

open(filepath, 'w').write(content)
```

---

## Bước 3 — Software Key cho Remote Control

File `main-*.js` trong `.vite/build/` chứa hàm load native module `remote-control-device-key.node` — module này yêu cầu Keychain access group `2DC432GLL2.*` của OpenAI, sẽ fail trên mọi app không được sign bởi OpenAI.

### 3.1 — Tìm tên hàm trong main process

```bash
# Tên hàm factory (xZ ở 26.609; OV/SU ở bản cũ)
grep -o 'function [A-Za-z][A-Za-z0-9]*({resourcesPath:e})' \
  ~/Downloads/codex-ext-2609/.vite/build/main-*.js

# Xác nhận payload builder (SZ ở 26.609) + native loader + filename const
grep -o 'signDeviceKey:async([a-z],[a-z])=>{let [a-z]=[A-Za-z0-9_$]*(' \
  ~/Downloads/codex-ext-2609/.vite/build/main-*.js
grep -o 'return t??=[A-Za-z0-9_$]*((0,[a-z].join)(e,`native`,[A-Za-z0-9_$]*))' \
  ~/Downloads/codex-ext-2609/.vite/build/main-*.js

# Xác nhận tên require var os/path/fs/crypto (i/a/s/c ở 26.609)
grep -oE '[A-Za-z0-9_$]{1,4}=require\(`node:(os|path|fs|crypto)`\)' \
  ~/Downloads/codex-ext-2609/.vite/build/main-*.js
```

### 3.2 — Patch software key

Thay hàm native key factory bằng pure JS P-256 ECDSA, lưu keys vào `~/.codex/device-keys.json`.

Biến module-level ở `26.609.30741` (PHẢI grep lại mỗi version — xem 3.1):
- `i` = `require('node:os')` → `i.homedir()`
- `a` = `require('node:path')` → `(0,a.join)(...)`
- `s` = `require('node:fs')` → `s.readFileSync / s.writeFileSync / s.mkdirSync`
- `c` = `require('node:crypto')` → `c.generateKeyPairSync / c.createSign / c.randomUUID`
- factory `xZ`, native loader `_Z`, filename const `vZ`, payload builder `SZ`

```python
filepath = '.vite/build/main-DS-bu3Xr.js'  # điều chỉnh tên
content = open(filepath).read()

OLD = (
    'function xZ({resourcesPath:e}){let t=null,n=()=>'
    '{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);'
    'if(e==null)throw Error(`Remote control device keys require resourcesPath`);'
    'return t??=_Z((0,a.join)(e,`native`,vZ)),t};'
    'return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),'
    'deleteDeviceKey:e=>n().deleteDeviceKey(e),'
    'getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),'
    'signDeviceKey:async(e,t)=>{let r=SZ(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}'
)

# vars: i=os, a=path, s=fs, c=crypto ; payload builder=SZ
NEW = (
    'function xZ({resourcesPath:e}){'
    'let __sf=()=>{try{return JSON.parse(s.readFileSync((0,a.join)(i.homedir(),`.codex`,`device-keys.json`),`utf8`))}catch(e){return{}}},'
    '__ss=st=>{try{s.mkdirSync((0,a.join)(i.homedir(),`.codex`),{recursive:!0})}catch(e){}'
    's.writeFileSync((0,a.join)(i.homedir(),`.codex`,`device-keys.json`),JSON.stringify(st),`utf8`)};'
    'return{'
    'createDeviceKey:mode=>{let kp=c.generateKeyPairSync(`ec`,{namedCurve:`P-256`,publicKeyEncoding:{type:`spki`,format:`der`},privateKeyEncoding:{type:`pkcs8`,format:`pem`}}),'
    'keyId=c.randomUUID(),pub=kp.publicKey.toString(`base64`),st=__sf();st[keyId]={p:kp.privateKey,b:pub};__ss(st);'
    'return{keyId,publicKeySpkiDerBase64:pub,algorithm:`ecdsa_p256_sha256`,protectionClass:`os_protected_nonextractable`}},'
    'deleteDeviceKey:keyId=>{let st=__sf();delete st[keyId];__ss(st)},'
    'getDeviceKeyPublic:keyId=>{let st=__sf(),k=st[keyId];if(!k)throw Error(`Device key not found: ${keyId}`);'
    'return{keyId,publicKeySpkiDerBase64:k.b,algorithm:`ecdsa_p256_sha256`,protectionClass:`os_protected_nonextractable`}},'
    'signDeviceKey:async(keyId,t)=>{let buf=SZ(t),st=__sf(),k=st[keyId];if(!k)throw Error(`Device key not found: ${keyId}`);'
    'let sig=c.createSign(`SHA256`).update(buf).sign(k.p);'
    'return{keyId,publicKeySpkiDerBase64:k.b,algorithm:`ecdsa_p256_sha256`,protectionClass:`os_protected_nonextractable`,'
    'signatureDerBase64:sig.toString(`base64`),signedPayloadBase64:buf.toString(`base64`)}}}}'
)

assert OLD in content, "Hàm không tìm thấy — grep lại tên hàm + biến (Bước 3.1)"
content = content.replace(OLD, NEW, 1)
open(filepath, 'w').write(content)
print("Software key patched OK")
```

> **Tại sao `protectionClass: 'os_protected_nonextractable'`?**
> Server tại `/enroll/finish` chỉ chấp nhận `hardware_secure_enclave`, `hardware_tpm`, hoặc `os_protected_nonextractable`. Giá trị `software` bị reject 400.

---

## Bước 4 — Repack, Update Hash, Disable Fuse, Re-sign, Swap

> ⚠️ **App Management protection (macOS Sonoma+):** KHÔNG sửa được file bên trong `/Applications/Codex.app` đang cài (EPERM). Phải patch một **bản copy ngoài `/Applications`** rồi `mv` cả bundle vào. Quit Codex trước.

```bash
cd ~/Downloads
osascript -e 'quit app "Codex"'; sleep 2; pkill -f "Codex.app/Contents/MacOS/Codex" 2>/dev/null

# 1. Repack ASAR đã patch
~/.bun/bin/bunx @electron/asar pack codex-ext-2609 /tmp/app-patched.asar
NEW_HASH=$(shasum -a 256 /tmp/app-patched.asar | awk '{print $1}'); echo "hash=$NEW_HASH"

# 2. Dựng bản copy ngoài /Applications từ DMG (pristine)
VOL=$(ls -d "/Volumes/Codex Installer"* | head -1)
rm -rf ~/Downloads/Codex-patched.app
cp -R "$VOL/Codex.app" ~/Downloads/Codex-patched.app
cd ~/Downloads/Codex-patched.app/Contents

# 3. Thay asar + update Info.plist hash (DÙNG /usr/bin/python3, KHÔNG homebrew python)
cp /tmp/app-patched.asar Resources/app.asar
/usr/bin/python3 - "$NEW_HASH" <<'PY'
import plistlib,sys
pl=plistlib.load(open("Info.plist","rb"))
pl["ElectronAsarIntegrity"]={"Resources/app.asar":{"algorithm":"SHA256","hash":sys.argv[1]}}
plistlib.dump(pl,open("Info.plist","wb"))
print("Info.plist updated")
PY
```

```bash
# 4. Disable ASAR integrity fuse — framework đã đổi tên "Codex Framework.framework"
#    nên CLI `@electron/fuses --app` báo ENOENT. Dùng API qua symlink ngoài /tmp
#    (lib rewrite mọi path chứa ".app" về tên "Electron Framework" → path không được chứa ".app")
REAL=$(readlink -f ~/Downloads/Codex-patched.app/Contents/Frameworks/"Codex Framework.framework"/"Codex Framework")
ln -sf "$REAL" /tmp/cfbin
mkdir -p /tmp/fusefix && cd /tmp/fusefix && ~/.bun/bin/bun add @electron/fuses >/dev/null 2>&1
cat > run.mjs <<'EOF'
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
await flipFuses(process.argv[2], { version: FuseVersion.V1, resetAdHocDarwinSignature: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false });
console.log("EnableEmbeddedAsarIntegrityValidation -> off");
EOF
~/.bun/bin/bun run run.mjs /tmp/cfbin

# 5. Re-sign ad-hoc (KHÔNG entitlements — thêm keychain-access-groups sẽ crash 163)
codesign --force --deep --sign - ~/Downloads/Codex-patched.app
codesign --verify --deep ~/Downloads/Codex-patched.app && echo "Signature OK"

# 6. Swap vào /Applications (move cả bundle thì được phép; sửa bên trong thì không)
mv /Applications/Codex.app /Applications/Codex.app.orig-bak
mv ~/Downloads/Codex-patched.app /Applications/Codex.app

# 7. Xoá quarantine (macOS này không có `xattr -dr`; dùng -c đệ quy thủ công nếu cần)
xattr -c /Applications/Codex.app 2>/dev/null || true

# 8. Verify + launch
codesign --verify --deep /Applications/Codex.app && echo "Signature OK"
open /Applications/Codex.app
```

> Lưu ý: nếu đã cập nhật đúng `ElectronAsarIntegrity` hash trong Info.plist + re-sign, integrity validation vẫn pass kể cả khi fuse còn bật; disable fuse là lớp an toàn thêm.

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
| Toggle "Allow this device to be controlled and discovered" không bật được; log WS `409 Conflict {"detail":"Remote app server already online"}` | Account/environment đã có 1 remote app server khác đang online giữ chỗ (vd `rc-daemon` / máy khác) | Dừng server đang online đó trước, hoặc đợi nó timeout, rồi bật lại |
| App `/Applications/Codex.app` sửa file bên trong báo `Operation not permitted` (EPERM) | macOS App Management protection trên app đã ký | Patch bản copy ngoài `/Applications` rồi `mv` cả bundle vào (Bước 4) |
| `@electron/fuses --app` báo `ENOENT … Electron Framework` | Framework đã rename `Codex Framework.framework` | Dùng API `flipFuses` qua symlink ngoài `/tmp` (Bước 4) |

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

codex-ext-2609/                   ← ASAR extracted (26.609.30741)
├── .vite/build/
│   └── main-DS-bu3Xr.js          ← Main process (patch device-key xZ ở đây)
└── webview/assets/
    ├── app-main-CfLW6VUn.js      ← Feature gates (BT mobile, Nw remote_connections)
    ├── remote-connection-visibility-3y45XFqA.js  ← c(), l() gates
    └── settings-page-VwJS5VYK.js ← Route visibility switch
```

---

## Notes

- Tên file JS (hash suffix) thay đổi theo version. Dùng `ls` / `grep` để xác định.
- Tên hàm JS (Yy/Qy, OV/SU) cũng thay đổi theo version — luôn grep để tìm tên thật.
- Software key lưu private key PKCS#8 PEM trong JSON — **không commit hay export**.
- Ad-hoc signing hoạt động nhưng Gatekeeper sẽ warn lần đầu. Approve tại **System Settings → Privacy & Security**.
- Nếu app update, cần patch lại từ đầu với ASAR mới.
