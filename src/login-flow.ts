import { randomBytes, createHash } from "crypto";
import { importFromTokens } from "./accounts";
import { logEvent } from "./logger";

const CALLBACK_PORT = 1455;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

let activeServer: ReturnType<typeof Bun.serve> | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
let activeLogin: {
  state: string;
  verifier: string;
  onAccount: (email: string) => void;
  onError: (err: string) => void;
  onEvent?: (event: LoginEvent) => void;
} | null = null;

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

function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function sanitizeTokenResponse(text: string): string {
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

function stopServer() {
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  if (activeServer) {
    activeServer.stop(true);
    activeServer = null;
    console.log("[login] Callback server stopped (port 1455)");
  }
  activeLogin = null;
}

export function isLoginInProgress(): boolean {
  return activeServer !== null;
}

export function cancelLoginFlow(reason = "Login cancelled"): boolean {
  if (!activeServer) return false;
  stopServer();
  logEvent("login_cancelled", reason);
  return true;
}

async function exchangeCodeForAccount(
  code: string,
  verifier: string,
  onAccount: (email: string) => void,
  onError: (err: string) => void,
  onEvent?: (event: LoginEvent) => void
): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const callbackMessage = "code received; exchanging token";
    logEvent("login_callback", callbackMessage);
    onEvent?.({ type: "login_callback", message: callbackMessage });
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });

    const body = await tokenResp.text();
    const contentType = tokenResp.headers.get("content-type") ?? "";
    const sanitizedBody = sanitizeTokenResponse(body);
    logEvent("login_token_resp", `${tokenResp.status} ${contentType} ${sanitizedBody}`);
    onEvent?.({
      type: "login_token_resp",
      status: tokenResp.status,
      contentType,
      body: sanitizedBody,
    });

    if (!tokenResp.ok) {
      const error = `Token exchange thất bại (${tokenResp.status}): ${body}`;
      onError(error);
      stopServer();
      return { ok: false, error };
    }

    const tokens = JSON.parse(body);
    const account = importFromTokens(tokens);
    setTimeout(stopServer, 500);

    if (!account) {
      const error = "Không parse được account từ token.";
      logEvent("login_import_error", error);
      onEvent?.({ type: "login_import_error", error });
      return { ok: false, error };
    }

    onAccount(account.email);
    return { ok: true, email: account.email };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logEvent("login_exception", error);
    onEvent?.({ type: "login_exception", error });
    onError(error);
    stopServer();
    return { ok: false, error };
  }
}

export async function importCallbackUrl(callbackUrl: string): Promise<{
  ok: boolean;
  email?: string;
  error?: string;
}> {
  if (!activeLogin) {
    return { ok: false, error: "Chưa có login flow đang chạy. Bấm Login trước rồi paste callback URL." };
  }

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { ok: false, error: "Callback URL không hợp lệ" };
  }

  const returnedState = url.searchParams.get("state");
  if (returnedState !== activeLogin.state) {
    return { ok: false, error: "State không khớp với login flow hiện tại" };
  }

  const error = url.searchParams.get("error");
  if (error) {
    const errorDescription = url.searchParams.get("error_description") ?? "";
    const message = `error=${error}${errorDescription ? ` desc=${errorDescription}` : ""}`;
    logEvent("login_callback", message);
    activeLogin.onEvent?.({ type: "login_callback", error, message });
    activeLogin.onError(`Login thất bại: ${error}`);
    stopServer();
    return { ok: false, error: `Login thất bại: ${error}` };
  }

  const code = url.searchParams.get("code");
  if (!code) return { ok: false, error: "Callback URL không có OAuth code" };

  return exchangeCodeForAccount(
    code,
    activeLogin.verifier,
    activeLogin.onAccount,
    activeLogin.onError,
    activeLogin.onEvent
  );
}

export function startLoginFlow(
  onAccount: (email: string) => void,
  onError: (err: string) => void,
  onEvent?: (event: LoginEvent) => void
): LoginStartResult {
  if (activeServer) {
    return { ok: false, error: "Login đang tiến hành, vui lòng đợi." };
  }

  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
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
  activeLogin = { state, verifier, onAccount, onError, onEvent };

  try {
    activeServer = Bun.serve({
      port: CALLBACK_PORT,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") {
          return new Response("Not found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (returnedState !== state) {
          const error = "State không khớp";
          logEvent("login_callback", error);
          onEvent?.({ type: "login_callback", error });
          stopServer();
          return html("Lỗi bảo mật", "<p>State không khớp. Vui lòng thử lại.</p>", 400);
        }

        if (!code) {
          const error = url.searchParams.get("error") ?? "unknown";
          const errorDescription = url.searchParams.get("error_description") ?? "";
          const message = `error=${error}${errorDescription ? ` desc=${errorDescription}` : ""}`;
          logEvent("login_callback", message);
          onEvent?.({ type: "login_callback", error, message });
          onError(`Login thất bại: ${error}`);
          stopServer();
          return html("Login thất bại", `<p>${error}</p>`, 400);
        }

        try {
          const result = await exchangeCodeForAccount(code, verifier, onAccount, onError, onEvent);
          if (result.ok) {
            return html(
              "Login thành công",
              `<h2>✓ Login thành công!</h2><p>Tài khoản <strong>${result.email}</strong> đã được lưu.<br>Tab này sẽ tự đóng.</p><script>setTimeout(()=>window.close(),2000)</script>`,
              200
            );
          }

          return html("Login thất bại", `<pre>${result.error ?? "unknown"}</pre>`, 500);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logEvent("login_exception", msg);
          onEvent?.({ type: "login_exception", error: msg });
          onError(msg);
          stopServer();
          return html("Lỗi", `<pre>${msg}</pre>`, 500);
        }
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    activeLogin = null;
    onError(msg);
    return { ok: false, error: msg };
  }

  // Tự đóng sau 5 phút nếu không có callback
  timeoutHandle = setTimeout(() => {
    console.log("[login] Timeout 5 phút — tự đóng port 1455");
    stopServer();
    logEvent("login_timeout", "Hết thời gian chờ login (5 phút).");
    onEvent?.({ type: "login_timeout", error: "Hết thời gian chờ login (5 phút)." });
    onError("Hết thời gian chờ login (5 phút).");
  }, LOGIN_TIMEOUT_MS);

  console.log(`[login] Callback server started on http://localhost:${CALLBACK_PORT}`);

  Bun.$`open ${authorizeUrl}`.catch(() => {
    console.log(`[login] Không mở được browser. URL: ${authorizeUrl}`);
  });

  return { ok: true, authorizeUrl };
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
