import type { AccountsService } from "./accounts";
import type { WatcherService } from "./watcher";
import type { Account } from "../schemas";
import { ChatGPTClient, CHATGPT_BASE, CODEX_RESPONSES_PATH, type TokenUsage } from "../libs/chatgpt";
import type { UpstreamProxy } from "../libs/upstream";

export type { TokenUsage };

// Route based on path prefix
type Route = { prefix: string; target: string; rewrite?: (pathname: string) => string };
const ROUTES: Route[] = [
  {
    prefix: "/v1/responses",
    target: CHATGPT_BASE,
    rewrite: (pathname) => pathname.replace(/^\/v1\/responses/, CODEX_RESPONSES_PATH),
  },
  { prefix: "/v1/", target: "https://api.openai.com" },
  { prefix: "/backend-api/", target: CHATGPT_BASE },
];

const MAX_RETRIES = 3;
const STRIP_UPSTREAM_HEADERS = [
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-ew-via",
  "cf-warp-tag-id",
  "connection",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-original-forwarded-for",
  "x-real-ip",
  "x-request-id",
  "x-request-start",
];

// Metadata attached to every proxied request — used by index.ts for SSE + file logs
export type ProxyMeta = {
  email: string;
  errorSnippet?: string;
  accountSwitched?: { from: string; to: string; reason: "rate_limit" | "expired" };
  accountSwitchBroadcasted?: boolean;
};

export type StreamErrorEvent = {
  email: string;
  status: number;
  errorSnippet: string;
};

export type StreamUsageEvent = {
  email: string;
  status: number;
  usage: TokenUsage;
};

export type AccountSwitchEvent = {
  from: string;
  to: string;
  reason: "rate_limit" | "expired";
};

type StreamErrorCallback = (event: StreamErrorEvent) => void;
type StreamUsageCallback = (event: StreamUsageEvent) => void;
type AccountSwitchCallback = (event: AccountSwitchEvent) => void;

export class ProxyService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly watcher: WatcherService,
    private readonly upstream: UpstreamProxy
  ) {}

  private resolveRoute(pathname: string): Route | null {
    for (const route of ROUTES) {
      if (pathname.startsWith(route.prefix)) return route;
    }
    return null;
  }

  private stripUpstreamHeaders(headers: Headers) {
    for (const name of STRIP_UPSTREAM_HEADERS) headers.delete(name);
    for (const name of Array.from(headers.keys())) {
      if (name.toLowerCase().startsWith("cf-")) headers.delete(name);
    }
  }

  private async probeAccount(account: Account): Promise<{ ok: boolean; error?: string; status?: number }> {
    const body = JSON.stringify({
      model: "gpt-5.5",
      store: false,
      stream: true,
      instructions: "Reply with OK only.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
    });

    try {
      const res = await ChatGPTClient.openResponsesStream(account, body);
      const text = await res.text();

      if (res.status === 401) {
        this.accounts.markExpired(account.id);
        return { ok: false, status: res.status, error: "probe 401" };
      }

      if (res.status === 429) {
        const retryAfterMs = parseInt(res.headers.get("retry-after") ?? "60") * 1000;
        this.accounts.markRateLimited(account.id, retryAfterMs);
        return { ok: false, status: res.status, error: "probe 429" };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: text.slice(0, 200) || `probe HTTP ${res.status}` };
      }

      if (ChatGPTClient.isStreamFailure(text)) {
        if (ChatGPTClient.isRateLimit(text)) this.accounts.markRateLimited(account.id);
        return { ok: false, status: res.status, error: text.slice(0, 200) || "probe stream failed" };
      }

      if (!/event:\s*response\.completed|"type"\s*:\s*"response\.completed"/i.test(text)) {
        return { ok: false, status: res.status, error: "probe did not complete" };
      }

      return { ok: true, status: res.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async findVerifiedSwitchAccount(excludeAccountId: string): Promise<Account | null> {
    for (const candidate of this.accounts.getSwitchCandidates(excludeAccountId)) {
      console.log(`[proxy] probing switch candidate: ${candidate.email}`);
      const probe = await this.probeAccount(candidate);
      if (probe.ok) {
        this.accounts.setSelectedAccount(candidate.id);
        console.log(`[proxy] probe OK, switching to ${candidate.email}`);
        return candidate;
      }
      console.warn(
        `[proxy] probe failed for ${candidate.email}: ${probe.status ?? "no_status"} ${probe.error ?? ""}`
      );
    }
    return null;
  }

  private retryAfterMs(headers: Headers, fallbackMs = 60_000): number {
    const raw = headers.get("retry-after");
    if (!raw) return fallbackMs;

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

    return fallbackMs;
  }

  private async retryWithSwitchedAccount(
    req: Request,
    body: ArrayBuffer | null,
    meta: ProxyMeta,
    account: Account,
    reason: "rate_limit" | "expired",
    retries: number,
    onStreamError?: StreamErrorCallback,
    onStreamUsage?: StreamUsageCallback,
    onAccountSwitch?: AccountSwitchCallback
  ): Promise<Response | null> {
    if (retries >= MAX_RETRIES) return null;

    const nextAccount = await this.findVerifiedSwitchAccount(account.id);
    if (!nextAccount || nextAccount.id === account.id) return null;

    const label = reason === "rate_limit" ? "Rate limited" : "Token expired (401)";
    console.log(
      `[proxy] ${label} on ${account.email} → switching to ${nextAccount.email} (retry ${retries + 1}/${MAX_RETRIES})`
    );
    meta.accountSwitched = { from: account.email, to: nextAccount.email, reason };
    meta.accountSwitchBroadcasted = true;
    onAccountSwitch?.(meta.accountSwitched);

    const retryReq = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: body ?? undefined,
    });
    return this.proxyRequestInner(retryReq, meta, onStreamError, onStreamUsage, onAccountSwitch, retries + 1);
  }

  private replayStream(
    bufferedChunks: Uint8Array[],
    reader: any,
    upstreamDone: boolean
  ): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < bufferedChunks.length) {
          controller.enqueue(bufferedChunks[index++]);
          return;
        }

        if (upstreamDone) {
          controller.close();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  private async preflightCodexStream(
    body: ReadableStream<Uint8Array> | null,
    account: Account
  ): Promise<
    | { kind: "body"; body: ReadableStream<Uint8Array> | null }
    | { kind: "limit_error"; snippet: string }
  > {
    if (!body) return { kind: "body", body };

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const bufferedChunks: Uint8Array[] = [];
    let buffer = "";
    let upstreamDone = false;
    let blockCount = 0;
    const deadline = Date.now() + 1500;

    while (Date.now() < deadline && bufferedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) < 64_000) {
      const { done, value } = await reader.read();
      if (done) {
        upstreamDone = true;
        break;
      }

      bufferedChunks.push(value);
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        blockCount++;
        const snippet = ChatGPTClient.detectError(block);
        if (snippet && ChatGPTClient.isRateLimit(snippet)) {
          this.accounts.markRateLimited(account.id);
          await reader.cancel().catch(() => {});
          return { kind: "limit_error", snippet: snippet.slice(0, 800) };
        }
        if (snippet || ChatGPTClient.isSuccessBlock(block) || blockCount >= 12) {
          return { kind: "body", body: this.replayStream(bufferedChunks, reader, upstreamDone) };
        }
      }
    }

    return { kind: "body", body: this.replayStream(bufferedChunks, reader, upstreamDone) };
  }

  private streamWithErrorTap(
    body: ReadableStream<Uint8Array> | null,
    account: Account,
    status: number,
    onStreamError?: StreamErrorCallback,
    onStreamUsage?: StreamUsageCallback
  ): ReadableStream<Uint8Array> | null {
    if (!body || (!onStreamError && !onStreamUsage)) return body;

    const accounts = this.accounts;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reportedError = false;
    let reportedUsage = false;
    let closed = false;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (closed) return;
          const { done, value } = await reader.read();
          if (done) {
            if (buffer && !reportedError && onStreamError) {
              const snippet = ChatGPTClient.detectError(buffer);
              if (snippet) {
                reportedError = true;
                if (ChatGPTClient.isRateLimit(snippet)) accounts.markRateLimited(account.id);
                onStreamError({ email: account.email, status, errorSnippet: snippet.slice(0, 800) });
              }
            }
            if (buffer && !reportedUsage && onStreamUsage) {
              const usage = ChatGPTClient.detectTokenUsage(buffer);
              if (usage) {
                reportedUsage = true;
                onStreamUsage({ email: account.email, status, usage });
              }
            }
            closed = true;
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          buffer += text;
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() ?? "";

          if ((!reportedError && onStreamError) || (!reportedUsage && onStreamUsage)) {
            for (const block of blocks) {
              if (!reportedError && onStreamError) {
                const snippet = ChatGPTClient.detectError(block);
                if (snippet) {
                  reportedError = true;
                  if (ChatGPTClient.isRateLimit(snippet)) accounts.markRateLimited(account.id);
                  onStreamError({ email: account.email, status, errorSnippet: snippet.slice(0, 800) });
                }
              }

              if (!reportedUsage && onStreamUsage) {
                const usage = ChatGPTClient.detectTokenUsage(block);
                if (usage) {
                  reportedUsage = true;
                  onStreamUsage({ email: account.email, status, usage });
                }
              }

              if (reportedError && reportedUsage) break;
            }
          }

          if (buffer.length > 64_000) buffer = buffer.slice(-16_000);
          try {
            controller.enqueue(value);
          } catch {
            closed = true;
            await reader.cancel().catch(() => {});
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (closed || /controller is already closed|invalid state/i.test(msg)) return;
          if (!reportedError && onStreamError) {
            reportedError = true;
            onStreamError({
              email: account.email,
              status,
              errorSnippet: `Stream read error: ${msg}`,
            });
          }
          controller.error(error);
        }
      },
      cancel(reason) {
        closed = true;
        return reader.cancel(reason);
      },
    });
  }

  private async proxyRequestInner(
    req: Request,
    meta: ProxyMeta,
    onStreamError?: StreamErrorCallback,
    onStreamUsage?: StreamUsageCallback,
    onAccountSwitch?: AccountSwitchCallback,
    retries = 0
  ): Promise<Response> {
    const account = this.accounts.getActiveAccount();
    if (!account) {
      return new Response(
        JSON.stringify({
          error: { message: "No active account. Login to Codex to add one.", type: "proxy_error" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    meta.email = account.email;

    const url = new URL(req.url);
    const route = this.resolveRoute(url.pathname);
    if (!route) return new Response("Not found", { status: 404 });

    const targetPath = route.rewrite ? route.rewrite(url.pathname) : url.pathname;
    const targetUrl = route.target + targetPath + url.search;

    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${account.accessToken}`);
    if (targetPath.startsWith("/backend-api/codex/")) {
      headers.set("ChatGPT-Account-Id", account.accountId);
      headers.set("OpenAI-Beta", "responses=experimental");
      headers.set("Origin", CHATGPT_BASE);
      headers.set("Referer", `${CHATGPT_BASE}/`);
      headers.set("Originator", "codex_cli_rs");
      headers.set("Version", "0.133.0");
      headers.set("User-Agent", "codex_cli_rs/0.133.0 (Mac OS; arm64)");
      headers.set("Accept", "text/event-stream");
      headers.set("X-Oai-Web-Search-Eligible", "true");
    }
    headers.set("Accept-Encoding", "identity");
    this.stripUpstreamHeaders(headers);

    let body: ArrayBuffer | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
    }

    const tokenSnippet = account.accessToken.slice(-12);
    console.log(`\n[proxy →] ${req.method} ${targetUrl}`);
    console.log(`  account : ${account.email}`);
    console.log(`  token   : ...${tokenSnippet}`);
    console.log(`  req-headers:`);
    for (const [k, v] of headers.entries()) {
      const val = k.toLowerCase() === "authorization" ? `Bearer ...${v.slice(-12)}` : v;
      console.log(`    ${k}: ${val}`);
    }
    if (body && body.byteLength > 0) {
      const bodySnippet = new TextDecoder().decode(body.slice(0, 500));
      console.log(`  body[0:500]: ${bodySnippet}`);
    }

    const start = Date.now();
    let upstream: Response;
    try {
      upstream = await this.upstream.forward(targetUrl, { method: req.method, headers, body });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: { message: `Proxy upstream error: ${e}`, type: "proxy_error" } }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const latencyMs = Date.now() - start;
    console.log(`[proxy ←] ${upstream.status} (${latencyMs}ms)`);
    console.log(`  res-headers:`);
    for (const [k, v] of upstream.headers.entries()) {
      console.log(`    ${k}: ${v}`);
    }

    if (upstream.status === 401 || upstream.status === 429) {
      let errorText = "";
      try { errorText = await upstream.text(); } catch {}
      meta.errorSnippet = (errorText || `HTTP ${upstream.status} ${upstream.statusText}`).slice(0, 400);

      const reason: "rate_limit" | "expired" = upstream.status === 429 ? "rate_limit" : "expired";

      if (upstream.status === 401) {
        const info = ChatGPTClient.decodeToken(account.accessToken);
        console.error(`[proxy] 401 on ${account.email}`);
        console.error(`  token_exp : ${info.expiresAt}`);
        console.error(`  is_expired: ${info.isExpired}${info.isExpired ? ` (${info.ageMin}m ago)` : ""}`);
        console.error(`  401 body  : ${errorText}`);

        if (retries === 0) {
          const freshAuth = this.watcher.readAuth();
          const freshToken = freshAuth?.tokens?.access_token;
          if (freshToken && freshToken !== account.accessToken) {
            console.log(`[proxy] auth.json has a fresher token — using it directly`);
            this.accounts.importFromTokens(freshAuth!.tokens);
            const retryReq = new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: body ?? undefined,
            });
            return this.proxyRequestInner(retryReq, meta, onStreamError, onStreamUsage, onAccountSwitch, retries + 1);
          }

          const refreshed = await this.accounts.refreshAccountAccessToken(account, { force: true });
          if (refreshed.ok && refreshed.refreshed) {
            console.log(`[proxy] refreshed access token for ${account.email}; retrying request`);
            const retryReq = new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: body ?? undefined,
            });
            return this.proxyRequestInner(retryReq, meta, onStreamError, onStreamUsage, onAccountSwitch, retries + 1);
          }
          if (!refreshed.ok) {
            console.error(`[proxy] token refresh failed for ${account.email}: ${refreshed.error}`);
          }
        }

        this.accounts.markExpired(account.id);
      } else {
        this.accounts.markRateLimited(account.id, this.retryAfterMs(upstream.headers));
      }

      const switched = await this.retryWithSwitchedAccount(
        req, body, meta, account, reason, retries, onStreamError, onStreamUsage, onAccountSwitch
      );
      if (switched) return switched;

      const errHeaders = new Headers(upstream.headers);
      errHeaders.delete("content-encoding");
      return new Response(errorText, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: errHeaders,
      });
    }

    if (upstream.status >= 400) {
      try {
        const text = await upstream.clone().text();
        meta.errorSnippet = (text || `HTTP ${upstream.status} ${upstream.statusText}`).slice(0, 400);
        if (ChatGPTClient.isRateLimit(text)) {
          this.accounts.markRateLimited(account.id, this.retryAfterMs(upstream.headers));
          const switched = await this.retryWithSwitchedAccount(
            req, body, meta, account, "rate_limit", retries, onStreamError, onStreamUsage, onAccountSwitch
          );
          if (switched) return switched;
        }
      } catch {
        meta.errorSnippet = `HTTP ${upstream.status} ${upstream.statusText}`;
      }
    }

    if (upstream.status < 400) this.accounts.recordRequest(account.id);

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    let responseBody = upstream.body;
    if (targetPath.startsWith(CODEX_RESPONSES_PATH)) {
      const preflight = await this.preflightCodexStream(upstream.body, account);
      if (preflight.kind === "limit_error") {
        meta.errorSnippet = preflight.snippet;
        const switched = await this.retryWithSwitchedAccount(
          req, body, meta, account, "rate_limit", retries, onStreamError, onStreamUsage, onAccountSwitch
        );
        if (switched) return switched;

        return new Response(
          JSON.stringify({ error: { message: preflight.snippet, type: "proxy_error" } }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      responseBody = preflight.body as typeof responseBody;
    }

    const bodyWithErrorTap = this.streamWithErrorTap(responseBody, account, upstream.status, onStreamError, onStreamUsage);
    return new Response(bodyWithErrorTap, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  public async proxyRequest(
    req: Request,
    onStreamError?: StreamErrorCallback,
    onStreamUsage?: StreamUsageCallback,
    onAccountSwitch?: AccountSwitchCallback
  ): Promise<{ response: Response; meta: ProxyMeta }> {
    const meta: ProxyMeta = { email: "" };
    const response = await this.proxyRequestInner(req, meta, onStreamError, onStreamUsage, onAccountSwitch);
    return { response, meta };
  }

  public buildWebSocketProxyData(req: Request): {
    upstreamUrl: string;
    headers: Record<string, string>;
    email: string;
    accountId: string;
  } | null {
    const account = this.accounts.getActiveAccount();
    if (!account) return null;

    const url = new URL(req.url);
    const route = this.resolveRoute(url.pathname);
    if (!route) return null;

    const targetPath = route.rewrite ? route.rewrite(url.pathname) : url.pathname;
    const wsTarget = this.upstream.toWebSocketTarget(route.target);
    const upstreamUrl = wsTarget + targetPath + url.search;

    const base = new Headers(req.headers);
    this.stripUpstreamHeaders(base);

    const headers = targetPath.startsWith("/backend-api/codex/")
      ? ChatGPTClient.buildWebSocketHeaders(Object.fromEntries(base.entries()), account)
      : { ...Object.fromEntries(base.entries()), Authorization: `Bearer ${account.accessToken}` };

    console.log(`\n[ws →] ${url.pathname} [${account.email}]`);
    console.log(`  upstream: ${upstreamUrl}`);
    console.log(`  token   : ...${account.accessToken.slice(-12)}`);

    return { upstreamUrl, headers, email: account.email, accountId: account.id };
  }
}
