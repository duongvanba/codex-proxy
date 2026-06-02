#!/usr/bin/env bash
# =============================================================================
# Deploy codex-proxy to TrueNAS via Dockge
#
# Usage:
#   ./docs/DEPLOY.sh
#
# Requirements:
#   - SSH access to truenas_admin@192.168.2.4
#   - Docker available on TrueNAS (sudo)
#   - Dockge running at http://192.168.2.4:31000
#
# What this script does:
#   1. Build Docker image locally
#   2. Save + transfer image to TrueNAS
#   3. Create Dockge stack (docker compose)
#   4. Start the stack
# =============================================================================

set -euo pipefail

TRUENAS_HOST="truenas_admin@192.168.2.4"
IMAGE_NAME="codex-proxy"
IMAGE_TAG="latest"
APP_PORT=8000
DOCKGE_STACKS_DIR="/mnt/d2/dockge/data"
STACK_NAME="codex-proxy"
DATA_DIR="/mnt/d2/${STACK_NAME}/data"

echo "=== Codex Proxy — Deploy to TrueNAS ==="
echo "  Target : ${TRUENAS_HOST}"
echo "  Port   : ${APP_PORT}"
echo "  Stack  : ${DOCKGE_STACKS_DIR}/${STACK_NAME}"
echo ""

# ── Step 1: Build Docker image ─────────────────────────────────────────────────
echo "[1/4] Building Docker image..."
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .
echo "      ✓ Image built: ${IMAGE_NAME}:${IMAGE_TAG}"

# ── Step 2: Transfer image to TrueNAS ─────────────────────────────────────────
echo "[2/4] Transferring image to TrueNAS..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | \
  ssh "${TRUENAS_HOST}" "sudo docker load"
echo "      ✓ Image loaded on TrueNAS"

# ── Step 3: Create Dockge stack ────────────────────────────────────────────────
echo "[3/4] Creating Dockge stack..."
ssh "${TRUENAS_HOST}" "
  sudo mkdir -p ${DOCKGE_STACKS_DIR}/${STACK_NAME}
  sudo mkdir -p ${DATA_DIR}
  sudo tee ${DOCKGE_STACKS_DIR}/${STACK_NAME}/compose.yaml > /dev/null << 'COMPOSE'
services:
  codex-proxy:
    image: codex-proxy:latest
    container_name: ${STACK_NAME}
    restart: unless-stopped
    ports:
      - '${APP_PORT}:8000'
    volumes:
      - ${DATA_DIR}:/app/data
    environment:
      - PROXY_PORT=8000
      - STATIC_DIR=/app/dist/public
      - DATA_DIR=/app/data
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8000/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
COMPOSE
  echo '✓ compose.yaml created'
"
echo "      ✓ Stack created at ${DOCKGE_STACKS_DIR}/${STACK_NAME}/compose.yaml"

# ── Step 4: Start stack ────────────────────────────────────────────────────────
echo "[4/4] Starting stack..."
ssh "${TRUENAS_HOST}" "
  cd ${DOCKGE_STACKS_DIR}/${STACK_NAME}
  sudo docker compose up -d
"
echo "      ✓ Stack started"

# ── Verify ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Verifying deployment ==="
sleep 3
STATUS=$(ssh "${TRUENAS_HOST}" "curl -sf http://localhost:${APP_PORT}/health 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"accounts:\", d[\"accountCount\"])' 2>/dev/null || echo 'not ready yet'")
echo "  Health: ${STATUS}"
echo ""
echo "=== Done ==="
echo "  App    : http://192.168.2.4:${APP_PORT}"
echo "  Dockge : http://192.168.2.4:31000"
echo "  Data   : ${DATA_DIR}"
echo ""
echo "Next steps:"
echo "  1. Copy accounts.json to ${DATA_DIR}/accounts.json on TrueNAS"
echo "  2. Restart stack: ssh ${TRUENAS_HOST} 'cd ${DOCKGE_STACKS_DIR}/${STACK_NAME} && sudo docker compose restart'"
