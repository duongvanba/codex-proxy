# Build Guide

## Requirements

- [Bun](https://bun.sh) >= 1.3
- Node.js >= 18 (for Vite/Remix build)

## Development

```bash
# Install dependencies
bun install

# Start dev (honojs + remix vite dev server)
bun run dev
```

- Backend proxy: http://localhost:9876
- Dashboard UI:  http://localhost:9000

## Production Build

```bash
# Full build: Remix frontend + Bun server bundle
bun run build
```

Output in `dist/`:

```
dist/
├── server.js     # bundled honojs server (run with: bun run dist/server.js)
└── public/       # static frontend files (Remix SPA build)
    ├── index.html
    └── assets/
```

### Build steps (manual)

```bash
# 1. Build Remix frontend (Vite)
bun run build:web
# Output: apps/remix-v2/build/client/

# 2. Bundle honojs server
bun run build:server
# Output: dist/server.js (420KB, single bundled file)

# 3. Copy static files
cp -r apps/remix-v2/build/client dist/public
```

## Running Production Build

```bash
STATIC_DIR=./dist/public DATA_DIR=. bun run dist/server.js
```

### Environment Variables

| Variable          | Default         | Description                              |
|-------------------|-----------------|------------------------------------------|
| `PROXY_PORT`      | `9878`          | HTTP server port                         |
| `PROXY_HOST`      | `0.0.0.0`       | Bind address                             |
| `STATIC_DIR`      | _(empty)_       | Path to static frontend files            |
| `DATA_DIR`        | `process.cwd()` | Path to data files (accounts.json, logs) |
| `PROXY_TLS`       | `0`             | Set to `1` to enable TLS                 |
| `PUBLIC_BASE_URL` | auto-detected   | Public URL for OAuth callbacks           |

### Data Files (in `DATA_DIR`)

| File                   | Description                        |
|------------------------|------------------------------------|
| `accounts.json`        | OpenAI account list + tokens       |
| `account-state.json`   | Runtime account state              |
| `internal-auth.json`   | Internal JWT secret                |
| `logs/`                | Request logs                       |

> ⚠️ `accounts.json` contains sensitive tokens. Mount as a volume in Docker.

## Docker

```bash
# Build image
docker build -t codex-proxy .

# Run
docker run -d \
  -p 8000:8000 \
  -e PROXY_PORT=8000 \
  -v $(pwd)/data:/app/data \
  --name codex-proxy \
  codex-proxy
```

See [DEPLOY.sh](./DEPLOY.sh) for full deployment script.
