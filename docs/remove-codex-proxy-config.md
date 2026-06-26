# Go bo proxy config cho Codex

Project nay patch Codex CLI bang cach them `openai_base_url` vao
`~/.codex/config.toml`.

- Nut `Install` tren Web UI goi `patchCodexConfig()` va ghi:
  `openai_base_url = "<proxy>/v1"`.
- Nut `Uninstall` goi `restoreCodexConfig()` va xoa dong proxy khoi
  `~/.codex/config.toml`.
- Server khong tu patch config khi khoi dong.

## Cach go bo bang Web UI

1. Chay proxy app neu chua chay:

   ```bash
   bun run index.ts
   ```

2. Mo Web UI:

   ```bash
   http://localhost:9878
   ```

3. Bam `Uninstall`.
4. Khi UI hoi co restart Codex khong, chon restart neu dang mo Codex.

Sau khi uninstall, dong `openai_base_url` do project nay tao se bi xoa va
Codex CLI quay ve endpoint mac dinh cua OpenAI.

## Cach go bo thu cong

Dung cach nay khi khong mo duoc Web UI.

1. Mo file:

   ```bash
   nano ~/.codex/config.toml
   ```

2. Xoa dong dang tro ve proxy, vi du:

   ```toml
   openai_base_url = "http://localhost:9878/v1"
   ```

   hoac:

   ```toml
   openai_base_url = "https://opaip.amazingproxy.xyz/v1"
   ```

3. Luu file, roi restart Codex.

Khong nen xoa ca file `config.toml` neu file con cac cau hinh khac can giu.

## Kiem tra lai

Chay:

```bash
rg -n '^openai_base_url' ~/.codex/config.toml
```

Neu khong co ket qua thi Codex CLI khong con dung proxy qua `config.toml`.

Neu Codex van di qua proxy, kiem tra them cac bien moi truong co the dang override
endpoint:

```bash
env | rg 'CODEX_API|OPENAI|PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY'
```
