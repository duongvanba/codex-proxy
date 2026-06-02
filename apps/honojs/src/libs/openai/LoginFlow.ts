import { randomBytes, createHash } from "crypto";
import type { AccountsService } from "../../services/accounts";
import type { LoggerService } from "../../services/logger";
import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants";

const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 phút

// ─── Types ────────────────────────────────────────────────────────────────────

export type LoginStartResult =
  | { ok: true; authorizeUrl: string }
  | { ok: false; error: string };

type LoginEvent = {
  type: string;
  message?: string;
  status?: number;
  contentType?: string;
  body?: string;
  email?: string;
  error?: string;
};

type LoginSession = {
  state: string;
  verifier: string;
  authorizeUrl: string;
  onAccount: (email: string) => void;
  onError: (err: string) => void;
  onEvent?: (event: LoginEvent) => void;
  expiresAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

// ─── Class ────────────────────────────────────────────────────────────────────

export class LoginFlowService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly logger: LoggerService
  ) {}

  // Map<state, session> — nhiều session song song
  private readonly sessions = new Map<string, LoginSession>();

  // ─── Private ────────────────────────────────────────────────────────────────

  private generatePKCE() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  private sanitizeTokenResponse(text: string): string {
    try {
      const parsed = JSON.parse(text);
      for (const key of ["access_token", "refresh_token", "id_token"]) {
        if (key in parsed) parsed[key] = "[redacted]";
      }
      return JSON.stringify(parsed).slice(0, 1000);
    } catch {
      return text.slice(0, 1000);
    }
  }

  private expireSession(state: string, reason = "timeout"): void {
    const session = this.sessions.get(state);
    if (!session) return;
    clearTimeout(session.timeoutHandle);
    this.sessions.delete(state);
    console.log(`[login] Session ${state.slice(0, 8)}… expired (${reason}). Active: ${this.sessions.size}`);
  }

  private async exchangeCodeForAccount(
    session: LoginSession,
    code: string
  ): Promise<{ ok: boolean; email?: string; error?: string }> {
    try {
      const callbackMessage = "code received; exchanging token";
      this.logger.logEvent("login_callback", callbackMessage);
      session.onEvent?.({ type: "login_callback", message: callbackMessage });

      const tokenResp = await fetch(OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: OPENAI_CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: session.verifier,
        }),
      });

      const body = await tokenResp.text();
      const contentType = tokenResp.headers.get("content-type") ?? "";
      const sanitizedBody = this.sanitizeTokenResponse(body);
      this.logger.logEvent("login_token_resp", `${tokenResp.status} ${contentType} ${sanitizedBody}`);
      session.onEvent?.({ type: "login_token_resp", status: tokenResp.status, contentType, body: sanitizedBody });

      if (!tokenResp.ok) {
        const error = `Token exchange failed (${tokenResp.status}): ${body}`;
        session.onError(error);
        this.expireSession(session.state, "token_error");
        return { ok: false, error };
      }

      const tokens = JSON.parse(body);
      const account = this.accounts.importFromTokens(tokens);
      this.expireSession(session.state, "completed");

      if (!account) {
        const error = "Could not parse account from token.";
        this.logger.logEvent("login_import_error", error);
        session.onEvent?.({ type: "login_import_error", error });
        return { ok: false, error };
      }

      session.onAccount(account.email);
      return { ok: true, email: account.email };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.logEvent("login_exception", error);
      session.onEvent?.({ type: "login_exception", error });
      session.onError(error);
      this.expireSession(session.state, "exception");
      return { ok: false, error };
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  isLoginInProgress(): boolean {
    return this.sessions.size > 0;
  }

  /** Danh sách URL của các session đang chờ (để hiển thị lại cho user). */
  getActiveSessions(): Array<{ authorizeUrl: string; expiresAt: number }> {
    const now = Date.now();
    return [...this.sessions.values()]
      .filter(s => s.expiresAt > now)
      .map(s => ({ authorizeUrl: s.authorizeUrl, expiresAt: s.expiresAt }));
  }

  cancelLoginFlow(reason = "Login cancelled"): boolean {
    if (this.sessions.size === 0) return false;
    for (const state of [...this.sessions.keys()]) {
      this.expireSession(state, reason);
    }
    this.logger.logEvent("login_cancelled", reason);
    return true;
  }

  async importCallbackUrl(callbackUrl: string): Promise<{ ok: boolean; email?: string; error?: string }> {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { ok: false, error: "Invalid callback URL" };
    }

    const returnedState = url.searchParams.get("state") ?? "";
    const session = this.sessions.get(returnedState);

    if (!session) {
      if (this.sessions.size === 0) {
        return { ok: false, error: "No login flow is running. Click Login first, then paste the callback URL." };
      }
      return { ok: false, error: "State does not match any active login session." };
    }

    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      const desc = url.searchParams.get("error_description") ?? "";
      session.onEvent?.({ type: "login_callback", error: oauthError });
      session.onError(`Login failed: ${oauthError}`);
      this.expireSession(returnedState, "oauth_error");
      return { ok: false, error: `Login failed: ${oauthError}${desc ? ` (${desc})` : ""}` };
    }

    const code = url.searchParams.get("code");
    if (!code) return { ok: false, error: "Callback URL does not include an OAuth code" };

    return this.exchangeCodeForAccount(session, code);
  }

  sessionJsonToTokens(input: string): { ok: true; tokens: Record<string, any> } | { ok: false; error: string } {
    let parsed: any;
    try { parsed = JSON.parse(input); } catch { return { ok: false, error: "Invalid JSON account export" }; }

    const accessToken =
      typeof parsed.accessToken === "string" ? parsed.accessToken :
      typeof parsed.access_token === "string" ? parsed.access_token :
      typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token : "";

    if (!accessToken) return { ok: false, error: "JSON does not include accessToken" };

    const refreshToken =
      typeof parsed.refreshToken === "string" ? parsed.refreshToken :
      typeof parsed.refresh_token === "string" ? parsed.refresh_token :
      typeof parsed.tokens?.refresh_token === "string" ? parsed.tokens.refresh_token : "";

    const idToken =
      typeof parsed.idToken === "string" ? parsed.idToken :
      typeof parsed.id_token === "string" ? parsed.id_token :
      typeof parsed.tokens?.id_token === "string" ? parsed.tokens.id_token : undefined;

    const accountId =
      typeof parsed.account?.id === "string" ? parsed.account.id :
      typeof parsed.account_id === "string" ? parsed.account_id :
      typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id : undefined;

    return { ok: true, tokens: { access_token: accessToken, refresh_token: refreshToken, id_token: idToken, account_id: accountId } };
  }

  async importAccountInput(input: string): Promise<{ ok: boolean; email?: string; error?: string }> {
    const value = input.trim();
    if (!value) return { ok: false, error: "Missing import input" };
    if (value.startsWith("{")) {
      const converted = this.sessionJsonToTokens(value);
      if (!converted.ok) return converted;
      const account = this.accounts.importFromTokens(converted.tokens);
      if (!account) return { ok: false, error: "Could not parse account from JSON accessToken" };
      return { ok: true, email: account.email };
    }
    return this.importCallbackUrl(value);
  }

  /** Tạo session login mới, không giới hạn số lượng song song. */
  startLoginFlow(
    onAccount: (email: string) => void,
    onError: (err: string) => void,
    onEvent?: (event: LoginEvent) => void
  ): LoginStartResult {
    const { verifier, challenge } = this.generatePKCE();
    const state = randomBytes(16).toString("base64url");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: OPENAI_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "Codex Desktop",
    });

    const authorizeUrl = `${AUTHORIZE_URL}?${params}`;

    const timeoutHandle = setTimeout(() => {
      console.log(`[login] Session ${state.slice(0, 8)}… timed out after 5 minutes`);
      this.logger.logEvent("login_timeout", `Session ${state.slice(0, 8)}… expired`);
      const session = this.sessions.get(state);
      session?.onEvent?.({ type: "login_timeout", error: "Login timed out after 5 minutes." });
      session?.onError("Login timed out after 5 minutes.");
      this.expireSession(state, "timeout");
    }, SESSION_TTL_MS);

    const session: LoginSession = {
      state,
      verifier,
      authorizeUrl,
      onAccount,
      onError,
      onEvent,
      expiresAt: Date.now() + SESSION_TTL_MS,
      timeoutHandle,
    };

    this.sessions.set(state, session);
    console.log(`[login] New session created. Active: ${this.sessions.size}`);

    return { ok: true, authorizeUrl };
  }
}

function html(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>${title}</title>
    <style>body{font-family:system-ui;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .box{background:#111;border:1px solid #222;border-radius:12px;padding:32px 40px;max-width:400px;text-align:center}
    h2{color:#22c55e;margin-bottom:12px}pre{text-align:left;font-size:12px;color:#f87171;overflow:auto}</style>
    </head><body><div class="box">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
