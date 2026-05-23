# codex

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

The proxy serves HTTP by default, even if local certificate files exist:

```bash
http://localhost:9876
```

Codex config is patched to use the public tunnel endpoint by default:

```bash
https://opaip.amazingproxy.xyz/v1
```

Override it with:

```bash
PUBLIC_BASE_URL=https://your-domain.example bun run index.ts
```

To enable the bundled local TLS certificate explicitly:

```bash
PROXY_TLS=1 bun run index.ts
```

Use the Web UI proxy switch to write or remove `openai_base_url` in
`~/.codex/config.toml`. Turning the switch on patches Codex to use this proxy
and restarts Codex. Turning it off removes that config and restarts Codex.

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

This project was created using `bun init` in bun v1.3.12. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

The Web UI includes a `Login` button. It starts an OAuth flow, opens a
temporary callback server on `http://localhost:1455/auth/callback`, imports the
returned tokens into `accounts.json`, then closes the callback port. The
callback server auto-closes after 5 minutes if login is not completed.
