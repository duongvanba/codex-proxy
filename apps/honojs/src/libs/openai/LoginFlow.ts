import { randomBytes, createHash } from "crypto";
import type { AccountsService } from "../../services/accounts";
import type { LoggerService } from "../../services/logger";
import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants";

const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

type LoginStartResult =
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

// ─── Class ────────────────────────────────────────────────────────────────────

export class LoginFlowService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly logger: LoggerService
  ) {}

  private activeServer: ReturnType<typeof Bun.serve> | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private activeLogin: {
    state: string;
    verifier: string;
    onAccount: (email: string) => void;
    onError: (err: string) => void;
    onEvent?: (event: LoginEvent) => void;
  } | null = null;

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

  private stopServer() {
    if (this.timeoutHandle) { clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
    if (this.activeServer) {
      this.activeServer.stop(true);
      this.activeServer = null;
      console.log("[login] Callback server stopped (port 1455)");
    }
    this.activeLogin = null;
  }

  isLoginInProgress(): boolean {
    return this.activeServer !== null;
  }

  cancelLoginFlow(reason = "Login cancelled"): boolean {
    if (!this.activeServer) return false;
    this.stopServer();
    this.logger.logEvent("login_cancelled", reason);
    return true;
  }

  private async exchangeCodeForAccount(
    code: string,
    verifier: string,
    onAccount: (email: string) => void,
    onError: (err: string) => void,
    onEvent?: (event: LoginEvent) => void
  ): Promise<{ ok: boolean; email?: string; error?: string }> {
    try {
      const callbackMessage = "code received; exchanging token";
      this.logger.logEvent("login_callback", callbackMessage);
      onEvent?.({ type: "login_callback", message: callbackMessage });
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: OPENAI_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      const tokenResp = await fetch(OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });

      const body = await tokenResp.text();
      const contentType = tokenResp.headers.get("content-type") ?? "";
      const sanitizedBody = this.sanitizeTokenResponse(body);
      this.logger.logEvent("login_token_resp", `${tokenResp.status} ${contentType} ${sanitizedBody}`);
      onEvent?.({
        type: "login_token_resp",
        status: tokenResp.status,
        contentType,
        body: sanitizedBody,
      });

      if (!tokenResp.ok) {
        const error = `Token exchange failed (${tokenResp.status}): ${body}`;
        onError(error);
        this.stopServer();
        return { ok: false, error };
      }

      const tokens = JSON.parse(body);
      const account = this.accounts.importFromTokens(tokens);
      setTimeout(() => this.stopServer(), 500);

      if (!account) {
        const error = "Could not parse account from token.";
        this.logger.logEvent("login_import_error", error);
        onEvent?.({ type: "login_import_error", error });
        return { ok: false, error };
      }

      onAccount(account.email);
      return { ok: true, email: account.email };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.logEvent("login_exception", error);
      onEvent?.({ type: "login_exception", error });
      onError(error);
      this.stopServer();
      return { ok: false, error };
    }
  }

  async importCallbackUrl(callbackUrl: string): Promise<{
    ok: boolean;
    email?: string;
    error?: string;
  }> {
    if (!this.activeLogin) {
      return { ok: false, error: "No login flow is running. Click Login first, then paste the callback URL." };
    }

    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { ok: false, error: "Invalid callback URL" };
    }

    const returnedState = url.searchParams.get("state");
    if (returnedState !== this.activeLogin.state) {
      return { ok: false, error: "State does not match the current login flow" };
    }

    const error = url.searchParams.get("error");
    if (error) {
      const errorDescription = url.searchParams.get("error_description") ?? "";
      const message = `error=${error}${errorDescription ? ` desc=${errorDescription}` : ""}`;
      this.logger.logEvent("login_callback", message);
      this.activeLogin.onEvent?.({ type: "login_callback", error, message });
      this.activeLogin.onError(`Login failed: ${error}`);
      this.stopServer();
      return { ok: false, error: `Login failed: ${error}` };
    }

    const code = url.searchParams.get("code");
    if (!code) return { ok: false, error: "Callback URL does not include an OAuth code" };

    return this.exchangeCodeForAccount(
      code,
      this.activeLogin.verifier,
      this.activeLogin.onAccount,
      this.activeLogin.onError,
      this.activeLogin.onEvent
    );
  }

  sessionJsonToTokens(input: string): { ok: true; tokens: Record<string, any> } | { ok: false; error: string } {
    let parsed: any;
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, error: "Invalid JSON account export" };
    }

    const accessToken =
      typeof parsed.accessToken === "string" ? parsed.accessToken :
      typeof parsed.access_token === "string" ? parsed.access_token :
      typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token :
      "";

    if (!accessToken) return { ok: false, error: "JSON does not include accessToken" };

    const refreshToken =
      typeof parsed.refreshToken === "string" ? parsed.refreshToken :
      typeof parsed.refresh_token === "string" ? parsed.refresh_token :
      typeof parsed.tokens?.refresh_token === "string" ? parsed.tokens.refresh_token :
      "";

    const idToken =
      typeof parsed.idToken === "string" ? parsed.idToken :
      typeof parsed.id_token === "string" ? parsed.id_token :
      typeof parsed.tokens?.id_token === "string" ? parsed.tokens.id_token :
      undefined;

    const accountId =
      typeof parsed.account?.id === "string" ? parsed.account.id :
      typeof parsed.account_id === "string" ? parsed.account_id :
      typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id :
      undefined;

    return {
      ok: true,
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        account_id: accountId,
      },
    };
  }

  async importAccountInput(input: string): Promise<{
    ok: boolean;
    email?: string;
    error?: string;
  }> {
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

  startLoginFlow(
    onAccount: (email: string) => void,
    onError: (err: string) => void,
    onEvent?: (event: LoginEvent) => void
  ): LoginStartResult {
    if (this.activeServer) {
      return { ok: false, error: "Login is already in progress. Please wait." };
    }

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
    this.activeLogin = { state, verifier, onAccount, onError, onEvent };

    try {
      this.activeServer = Bun.serve({
        port: CALLBACK_PORT,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname !== "/auth/callback") {
            return new Response("Not found", { status: 404 });
          }

          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");

          if (returnedState !== state) {
            const error = "State does not match";
            this.logger.logEvent("login_callback", error);
            onEvent?.({ type: "login_callback", error });
            this.stopServer();
            return html("Security error", "<p>State does not match. Please try again.</p>", 400);
          }

          if (!code) {
            const error = url.searchParams.get("error") ?? "unknown";
            const errorDescription = url.searchParams.get("error_description") ?? "";
            const message = `error=${error}${errorDescription ? ` desc=${errorDescription}` : ""}`;
            this.logger.logEvent("login_callback", message);
            onEvent?.({ type: "login_callback", error, message });
            onError(`Login failed: ${error}`);
            this.stopServer();
            return html("Login failed", `<p>${error}</p>`, 400);
          }

          try {
            const result = await this.exchangeCodeForAccount(code, verifier, onAccount, onError, onEvent);
            if (result.ok) {
              return html(
                "Login successful",
                `<h2>Login successful</h2><p>Account <strong>${result.email}</strong> has been saved.<br>This tab will close automatically.</p><script>setTimeout(()=>window.close(),2000)</script>`,
                200
              );
            }

            return html("Login failed", `<pre>${result.error ?? "unknown"}</pre>`, 500);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.logEvent("login_exception", msg);
            onEvent?.({ type: "login_exception", error: msg });
            onError(msg);
            this.stopServer();
            return html("Error", `<pre>${msg}</pre>`, 500);
          }
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.activeLogin = null;
      onError(msg);
      return { ok: false, error: msg };
    }

    // Close automatically after 5 minutes if no callback arrives.
    this.timeoutHandle = setTimeout(() => {
      console.log("[login] 5-minute timeout — closing port 1455");
      this.stopServer();
      this.logger.logEvent("login_timeout", "Login timed out after 5 minutes.");
      onEvent?.({ type: "login_timeout", error: "Login timed out after 5 minutes." });
      onError("Login timed out after 5 minutes.");
    }, LOGIN_TIMEOUT_MS);

    console.log(`[login] Callback server started on http://localhost:${CALLBACK_PORT}`);

    Bun.$`open ${authorizeUrl}`.catch(() => {
      console.log(`[login] Could not open browser. URL: ${authorizeUrl}`);
    });

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
