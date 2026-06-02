# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS builder

WORKDIR /build

# Install Node.js for Vite/Remix build
RUN apt-get update -qq && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests
COPY package.json bun.lockb* ./
COPY apps/honojs/package.json apps/honojs/
COPY apps/remix-v2/package.json apps/remix-v2/
COPY packages/ packages/

# Install deps
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build Remix frontend + Bun server bundle
RUN bun run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1.3-slim

WORKDIR /app

# Copy build output
COPY --from=builder /build/dist/server.js ./dist/server.js
COPY --from=builder /build/dist/public    ./dist/public

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/data/logs

ENV PROXY_PORT=8000
ENV PROXY_HOST=0.0.0.0
ENV STATIC_DIR=/app/dist/public
ENV DATA_DIR=/app/data

EXPOSE 8000

CMD ["bun", "run", "dist/server.js"]
