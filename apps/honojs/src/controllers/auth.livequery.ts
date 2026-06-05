import { Hono } from "hono";
import type { AccountsService } from "../services/accounts";
import type { InternalAuthService } from "../services/internal-auth";

const REFRESH_COOKIE = "refresh_token";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function buildSetCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

function buildClearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export class AuthController extends Hono {
  constructor(
    private readonly accounts: AccountsService,
    private readonly internalAuth: InternalAuthService
  ) {
    super();

    this.post("/auth-api/passkey/register-options", async (c) => this.passkeyRegisterOptions(c.req.raw));
    this.post("/auth-api/passkey/register", async (c) => this.passkeyRegister(c.req.raw));
    this.post("/auth-api/passkey/login-options", async (c) => this.passkeyLoginOptions(c.req.raw));
    this.post("/auth-api/passkey/login", async (c) => this.passkeyLogin(c.req.raw));
    this.post("/auth-api/refresh", async (c) => this.refresh(c.req.raw));
    this.post("/auth-api/logout", async (c) => this.logout());
  }

  /** Danh sách account với tài khoản `primaryId` được đưa lên ĐẦU (vì internalAuth dùng
   *  accounts[0] làm primary cho `sub`/`email` của JWT). Nhờ vậy phiên gắn đúng account đã login,
   *  không bị rơi về account nằm đầu danh sách. */
  private orderedAccounts(primaryId?: string) {
    const accounts = this.accounts.getAccounts();
    if (!primaryId) return accounts;
    const idx = accounts.findIndex((a) => a.id === primaryId);
    const primary = idx > 0 ? accounts[idx] : undefined;
    if (!primary) return accounts;
    return [primary, ...accounts.slice(0, idx), ...accounts.slice(idx + 1)];
  }

  private async issueForCurrentAccounts(primaryId?: string) {
    const accounts = this.orderedAccounts(primaryId);
    if (accounts.length === 0) {
      return Response.json({ error: { message: "No OpenAI account is available", type: "auth" } }, { status: 401 });
    }
    return Response.json({ data: await this.internalAuth.issue(accounts) });
  }

  private async issueCurrentAccountWithRefreshCookie(account: ReturnType<AccountsService["getAccounts"]>[number], meta: { auth_provider?: "passkey"; username?: string } = {}) {
    const data = await this.internalAuth.issueCurrentAccount(account, meta);
    const refresh = await this.internalAuth.issueRefreshToken([account], meta);
    const res = Response.json({ data });
    res.headers.append("set-cookie", buildSetCookie(REFRESH_COOKIE, refresh.token, refresh.max_age));
    return res;
  }

  private passkeyContext(req: Request) {
    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
    const rpId = new URL(origin).hostname;
    return { origin, rpId };
  }

  private async currentAccountFromRequest(req: Request) {
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const validation = await this.internalAuth.validate(bearer);
    if (validation.ok) {
      const account = this.accounts.getAccounts().find((a) => a.id === validation.payload.sub);
      if (account) return account;
    }
    return this.accounts.getAccounts()[0] ?? null;
  }

  private async passkeyRegisterOptions(req: Request): Promise<Response> {
    const account = await this.currentAccountFromRequest(req);
    if (!account) return Response.json({ error: { message: "Import an account before registering a passkey", type: "auth" } }, { status: 400 });
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    const username = typeof payload.username === "string" ? payload.username.trim() : "";
    const { rpId } = this.passkeyContext(req);
    return Response.json({ data: this.internalAuth.beginPasskeyRegistration(account, rpId, username || account.email) });
  }

  private async passkeyRegister(req: Request): Promise<Response> {
    const account = await this.currentAccountFromRequest(req);
    if (!account) return Response.json({ error: { message: "Import an account before registering a passkey", type: "auth" } }, { status: 400 });
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const { origin, rpId } = this.passkeyContext(req);
      const registered = await this.internalAuth.finishPasskeyRegistration(payload, account, origin, rpId);
      return this.issueCurrentAccountWithRefreshCookie(account, { auth_provider: "passkey", username: registered.username });
    } catch (error) {
      return Response.json({ error: { message: error instanceof Error ? error.message : String(error), type: "auth" } }, { status: 400 });
    }
  }

  private async passkeyLoginOptions(req: Request): Promise<Response> {
    if (!this.internalAuth.hasPasskeys()) return Response.json({ error: { message: "No passkey has been registered", type: "auth" } }, { status: 400 });
    const { rpId } = this.passkeyContext(req);
    return Response.json({ data: this.internalAuth.beginPasskeyLogin(rpId) });
  }

  private async passkeyLogin(req: Request): Promise<Response> {
    const payload = await req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const { origin, rpId } = this.passkeyContext(req);
      const { account, passkey } = await this.internalAuth.finishPasskeyLogin(payload, this.accounts.getAccounts(), origin, rpId);
      return this.issueCurrentAccountWithRefreshCookie(account, { auth_provider: "passkey", username: passkey.username });
    } catch (error) {
      return Response.json({ error: { message: error instanceof Error ? error.message : String(error), type: "auth" } }, { status: 400 });
    }
  }

  private async refresh(req: Request): Promise<Response> {
    // Còn refresh cookie hợp lệ → tôn trọng (giữ đúng account/passkey của phiên cũ).
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    const validation = await this.internalAuth.validateRefreshToken(refreshToken);
    if (validation.ok) {
      if (validation.payload.auth_provider === "passkey") {
        const account = this.accounts.getAccounts().find((a) => a.id === validation.payload.sub);
        if (account) return Response.json({ data: await this.internalAuth.issueCurrentAccount(account, { auth_provider: "passkey", username: validation.payload.passkey_username }) });
      } else {
        return this.issueForCurrentAccounts(validation.payload.sub);
      }
    }
    // Không có cookie / cookie hỏng / account passkey biến mất → đăng nhập thẳng (auto-login),
    // không còn màn login. Account đầu danh sách làm phiên hiện hành.
    return Response.json({ data: await this.internalAuth.issue(this.orderedAccounts()) });
  }

  private async logout(): Promise<Response> {
    this.internalAuth.logout();
    // Xoá refresh token khỏi cookie khi logout.
    const res = Response.json({ data: { ok: true } });
    res.headers.append("set-cookie", buildClearCookie(REFRESH_COOKIE));
    return res;
  }
}
