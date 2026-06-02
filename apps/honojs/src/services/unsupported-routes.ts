import { appendFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AccountService } from "./account-service";
import type { UpstreamProxy } from "../libs/upstream";

const PROXY_HOME = join(homedir(), ".codex-proxy");
const UNSUPPORTED_LOG_FILE = join(PROXY_HOME, "unsupported-endpoints.ndjson");
const MAX_SAMPLE_LENGTH = 4096;

interface UpstreamAttempt {
  target: string;
  status?: number;
  latencyMs?: number;
  error?: string;
  location?: string | null;
  contentType?: string | null;
  sampleBody?: string;
}

interface UnsupportedRouteLogEntry {
  timestamp: number;
  method: string;
  path: string;
  matchedTarget?: string;
  proxied: boolean;
  responseStatus?: number;
  attempts: UpstreamAttempt[];
}

// ─── UnsupportedRoutesService ─────────────────────────────────────────────────

export class UnsupportedRoutesService {
  constructor(
    private readonly accountService: AccountService,
    private readonly upstream: UpstreamProxy
  ) {}

  getLogPath(): string {
    return UNSUPPORTED_LOG_FILE;
  }

  private ensureProxyHome(): void {
    if (!existsSync(PROXY_HOME)) mkdirSync(PROXY_HOME, { recursive: true });
  }

  private truncate(value: string): string {
    if (value.length <= MAX_SAMPLE_LENGTH) return value;
    return `${value.slice(0, MAX_SAMPLE_LENGTH)}...<truncated>`;
  }

  private inferTargets(pathname: string): string[] {
    if (pathname.startsWith("/auth/") || pathname.startsWith("/oauth/"))
      return ["https://auth.openai.com"];
    if (pathname.startsWith("/backend-api/"))
      return ["https://chatgpt.com"];
    if (pathname.startsWith("/v1/"))
      return ["https://api.openai.com"];
    return ["https://chatgpt.com", "https://api.openai.com", "https://auth.openai.com"];
  }

  private appendLog(entry: UnsupportedRouteLogEntry): void {
    this.ensureProxyHome();
    appendFileSync(UNSUPPORTED_LOG_FILE, `${JSON.stringify(entry)}\n`);
  }

  private async readRequestBody(req: Request): Promise<ArrayBuffer | null> {
    if (req.method === "GET" || req.method === "HEAD") return null;
    return req.arrayBuffer();
  }

  private async readResponseSample(response: { text(): Promise<string> }): Promise<string> {
    try { return this.truncate(await response.text()); }
    catch { return "<non-text response>"; }
  }

  async proxyUnsupportedRoute(req: Request): Promise<{
    response: Response | null;
    logEntry: UnsupportedRouteLogEntry;
  }> {
    const url = new URL(req.url);
    const account = this.accountService.pickForProxy();
    const body = await this.readRequestBody(req);
    const attempts: UpstreamAttempt[] = [];
    const targets = this.inferTargets(url.pathname);

    for (const target of targets) {
      const headers = new Headers(req.headers);
      headers.delete("host");
      if (target !== "https://auth.openai.com" && account?.accessToken)
        headers.set("Authorization", `Bearer ${account.accessToken}`);

      const targetUrl = target + url.pathname + url.search;
      const startedAt = Date.now();
      try {
        const upstream = await this.upstream.forward(targetUrl, {
          method: req.method, headers, body,
          // @ts-ignore - Bun supports this
          decompress: false, redirect: "manual",
        });

        const sampleBody = await this.readResponseSample(upstream.clone());
        const attempt: UpstreamAttempt = {
          target, status: upstream.status, latencyMs: Date.now() - startedAt,
          location: upstream.headers.get("location"),
          contentType: upstream.headers.get("content-type"), sampleBody,
        };
        attempts.push(attempt);

        if (upstream.status !== 404) {
          const logEntry: UnsupportedRouteLogEntry = {
            timestamp: Date.now(), method: req.method,
            path: url.pathname + url.search, matchedTarget: target,
            proxied: true, responseStatus: upstream.status, attempts,
          };
          this.appendLog(logEntry);
          const responseHeaders = new Headers(upstream.headers);
          responseHeaders.delete("content-encoding");
          responseHeaders.set("x-codex-proxy-fallback", "1");
          responseHeaders.set("x-codex-proxy-target", target);
          return {
            response: new Response(upstream.body, {
              status: upstream.status, statusText: upstream.statusText,
              headers: responseHeaders,
            }),
            logEntry,
          };
        }
      } catch (error) {
        attempts.push({ target, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - startedAt });
      }
    }

    const logEntry: UnsupportedRouteLogEntry = {
      timestamp: Date.now(), method: req.method,
      path: url.pathname + url.search, proxied: false,
      responseStatus: 404, attempts,
    };
    this.appendLog(logEntry);
    return { response: null, logEntry };
  }
}
