#!/usr/bin/env bash
# =============================================================================
# Deploy codex-proxy to TrueNAS via Dockge
#
# Usage:
#   ./docs/DEPLOY.sh
#
# Requirements:
#   - SSH access to truenas_admin@192.168.2.4
#   - Docker running on TrueNAS (via sudo)
#   - Dockge at http://192.168.2.4:31000
#   - Container already created (first-time setup below)
#
# Architecture:
#   - Image  : oven/bun:1.3 (no custom build needed)
#   - Dataset: d2/codex → /mnt/d2/codex
#   - Runtime: /mnt/d2/codex/dist (server.js + web build, flat)
#   - Data   : /mnt/d2/codex/data (accounts.json, account-state.json, logs/)
#   - Port   : 9876 → 8000 (container)
# =============================================================================

set -euo pipefail

TRUENAS_HOST="truenas_admin@192.168.2.4"
DIST_REMOTE="/mnt/d2/codex/dist"

echo "=== Codex Proxy — Deploy to TrueNAS ==="

# ── Step 1: Build ──────────────────────────────────────────────────────────────
echo "[1/3] Building..."
bun run build
echo "      ✓ dist/server.js ($(du -sh dist/server.js | cut -f1))"

# ── Step 2: Rsync ──────────────────────────────────────────────────────────────
echo "[2/3] Syncing to TrueNAS..."
# Web build: rsync flat từ apps/remix-v2/build/client/ vào dist/ (compose env STATIC_DIR=/app/dist).
# Không dùng dist/public/ vì `bun run build` có bug lồng dist/public/client.
# --delete dọn asset hash cũ; exclude server.js để không bị xóa trước khi sync ở bước kế tiếp.
rsync -az --delete --exclude='server.js' apps/remix-v2/build/client/ "${TRUENAS_HOST}:${DIST_REMOTE}/"
rsync -az dist/server.js "${TRUENAS_HOST}:${DIST_REMOTE}/server.js"
echo "      ✓ Synced (server.js + web build)"

# ── Step 3: Restart ────────────────────────────────────────────────────────────
echo "[3/3] Restarting container..."
ssh "${TRUENAS_HOST}" "sudo docker restart codex-proxy"
sleep 3

# ── Verify ─────────────────────────────────────────────────────────────────────
RESULT=$(ssh "${TRUENAS_HOST}" "sudo docker exec codex-proxy bun -e \
  'const r=await fetch(\"http://localhost:8000/health\");const d=await r.json();
   console.log(\"accounts:\",d.accountCount,\"active:\",d.activeAccountCount)' 2>/dev/null")
echo ""
echo "=== Done === $RESULT"
echo "  App : http://192.168.2.4:9876"

# =============================================================================
# FIRST-TIME SETUP (run once manually)
# =============================================================================
# ssh truenas_admin@192.168.2.4
#
# # Create ZFS dataset + folders
# sudo zfs create d2/codex
# sudo mkdir -p /mnt/d2/codex/data/logs /mnt/d2/codex/dist
# sudo chown -R truenas_admin:truenas_admin /mnt/d2/codex
# sudo mkdir -p /mnt/d2/dockge/data/codex-proxy
#
# # Create compose stack
# sudo tee /mnt/d2/dockge/data/codex-proxy/compose.yaml << 'EOF'
# services:
#   codex-proxy:
#     image: oven/bun:1.3
#     container_name: codex-proxy
#     restart: unless-stopped
#     working_dir: /app
#     command: bun run dist/server.js
#     ports:
#       - '9876:8000'
#     volumes:
#       - /mnt/d2/codex/dist:/app/dist
#       - /mnt/d2/codex/data:/app/data
#     environment:
#       - PROXY_PORT=8000
#       - STATIC_DIR=/app/dist
#       - DATA_DIR=/app/data
#     healthcheck:
#       test: ['CMD-SHELL', 'curl -sf http://localhost:8000/health || exit 1']
#       interval: 30s
#       timeout: 5s
#       retries: 3
#       start_period: 10s
# EOF
#
# # Seed accounts.json (lần đầu)
# # rsync -az accounts.json truenas_admin@192.168.2.4:/mnt/d2/codex/data/
#
# # Start
# cd /mnt/d2/dockge/data/codex-proxy && sudo docker compose up -d
