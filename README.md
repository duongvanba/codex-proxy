# codex

To install dependencies:

```bash
bun install
```

To run on the default development port:

```bash
bun run index.ts
```

The dev branch serves HTTP on `9878` by default so it can run beside an
existing proxy instance:

```bash
http://localhost:9878
```

For LAN testing, run the Bun server on one shared port and bind to all network
interfaces:

```bash
PROXY_PORT=17000 PROXY_HOST=0.0.0.0 PUBLIC_BASE_URL=http://localhost:17000 bun run index.ts
```

Then open:

```bash
http://localhost:17000
http://<your-lan-ip>:17000
```

The same Bun server port serves:

- Frontend HTML/CSS/JS: `/`, `/app.js`, `/app.css`
- LiveQuery REST collections and actions: `/livequery/*`
- LiveQuery realtime WebSocket: `/livequery/realtime-updates`
- Codex/OpenAI proxy traffic: `/v1/*` and `/backend-api/*`

Codex config is patched to use the active proxy endpoint when the Web UI
`Install` button is clicked:

```bash
http://localhost:9878/v1
```

Override it with:

```bash
PROXY_PORT=9888 PUBLIC_BASE_URL=http://localhost:9888 bun run index.ts
```

To enable the bundled local TLS certificate explicitly:

```bash
PROXY_TLS=1 bun run index.ts
```

Use the Web UI `Install` and `Uninstall` buttons to write or remove
`openai_base_url` in `~/.codex/config.toml`. Installing patches Codex to use
this proxy. Uninstalling removes that config. The UI asks whether Codex should
be restarted after either operation; restart is no longer forced by default.
The server does not auto-patch the Codex config on startup.

The Web UI uses `@livequery/client`, `@livequery/react`, and `@livequery/rest`
against backend handlers built with `@livequery/core`.

Collections:

- `accounts`: account list, selected account, status, and usage metadata.
- `reports`: realtime request, login, config, token usage, and account switch
  reports.

The `accounts` collection returns local account data immediately. Quota reset
timers are returned as `-1` until the background OpenAI quota refresh finishes.
The UI shows skeleton rows for those pending timers, then updates via
`/livequery/realtime-updates` when the backend emits refreshed account data.
Account updates are batched into a single realtime sync event where possible.

Account tokens and runtime state are persisted separately:

- `accounts.json`: OAuth tokens and stable account identity fields.
- `account-state.json`: selected account, status, request counts, usage cache,
  and other runtime metadata.

Usage bars in the Web UI refresh from ChatGPT's Codex usage endpoint when the
account token is valid. If usage fetch fails or no remote data is available, the
UI falls back to successful requests observed by the proxy. You can tune the
fallback limits:

```bash
CODEX_DAILY_LIMIT=100 CODEX_WEEKLY_LIMIT=500 bun run index.ts
```

Remote usage refresh is cached for 60 seconds by default:

```bash
CODEX_USAGE_TTL_SECONDS=120 bun run index.ts
```

Remote usage refresh is parallelized with a small concurrency limit and per
request timeout:

```bash
CODEX_USAGE_CONCURRENCY=3 CODEX_USAGE_TIMEOUT_MS=3000 bun run index.ts
```

Health checks:

```bash
curl http://localhost:17000/health
```

Daily routine warm-up:

The Bun server schedules a daily routine-limit warm-up for every account at
7:00 AM in `Asia/Ho_Chi_Minh`. Each run sends the lightest Codex warm-up
message per account and publishes per-account results to the `reports`
collection. Tokens are not logged.

Configuration:

```bash
DAILY_ROUTINE_TIME_ZONE=Asia/Ho_Chi_Minh
DAILY_ROUTINE_HOUR=7
DAILY_ROUTINE_MINUTE=0
DAILY_ROUTINE_CONCURRENCY=2
DAILY_ROUTINE_TIMEOUT_MS=15000
DAILY_ROUTINE_DISABLED=1
```

Tests:

```bash
bun test
```

This project was created using `bun init` in bun v1.3.12. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

The Web UI includes a `Login` button. It starts an OAuth flow, opens a
temporary callback server on `http://localhost:1455/auth/callback`, imports the
returned tokens into `accounts.json`, then closes the callback port. The
callback server auto-closes after 5 minutes if login is not completed.

## Troubleshooting

- Port is busy: set `PROXY_PORT` to another port or stop the old process.
- LAN access does not work: run with `PROXY_HOST=0.0.0.0` and check macOS
  firewall settings.
- Codex still uses the old endpoint: click `Install`, confirm the target URL in
  `~/.codex/config.toml`, then restart Codex if needed.
- Quota rows show skeletons: the local account list has loaded, but background
  OpenAI quota refresh is still running or timed out.
- Token expired: log in again from the Web UI, or let the watcher import a fresh
  token from `~/.codex/auth.json`.
