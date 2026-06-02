import { firstValueFrom, of } from "rxjs";
import { catchError, filter, timeout } from "rxjs/operators";
import type { AccountDoc } from "@codex/types";
import { IndexedDBBehaviorSubject } from "./IndexedDBBehaviorSubject";
import type { PasskeyCredentialJSON, PasskeyLoginOptions, PasskeyRegistrationOptions } from "../helpers/passkey-browser";

export type SystemAuthAccount = {
  username: string;
};

export type AuthAccount = SystemAuthAccount | (AccountDoc & { username?: string });

/** Phiên đăng nhập (đã chuẩn hoá): CHỈ chứa tài khoản hiện tại, KHÔNG phải danh sách.
 *  Danh sách account đầy đủ lấy qua collection livequery `accounts`. */
export type AuthSession = {
  jwt: string;
  expiresAt: number;
  account: AuthAccount | null;
};

/** Response từ backend `/auth-api/refresh` legacy — vẫn trả `accounts` (list);
 *  frontend chỉ rút ra tài khoản hiện tại theo JWT. */
export type AuthApiSession = {
  jwt: string;
  expires_at: number;
  accounts: AccountDoc[];
};

export type AuthCurrentAccountApiSession = {
  jwt: string;
  expires_at: number;
  account: AuthAccount | null;
};

export type AuthApiResponseSession = AuthApiSession | AuthCurrentAccountApiSession;

export type AuthAccountState = {
  loading: boolean;
  state?: AuthSession;
};

const JWT_REFRESH_SKEW_MS = 30_000;

function decodeJwtClaims(jwt?: string | null): { sub?: string; email?: string } {
  try {
    const payload = jwt?.split(".")[1];
    if (!payload) return {};
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string; email?: string };
  } catch {
    return {};
  }
}

/** Tài khoản hiện tại của phiên = account khớp `sub`/`email` trong JWT (fallback phần tử đầu). */
function currentAccountFromApi(jwt: string, accounts: AccountDoc[]): AuthAccount | null {
  if (!accounts || accounts.length === 0) return null;
  const { sub, email } = decodeJwtClaims(jwt);
  return (
    accounts.find((a) => a.id === sub) ??
    accounts.find((a) => a.email === email) ??
    accounts[0] ??
    null
  );
}

function normalizeSession(session: AuthApiResponseSession | AuthSession): AuthSession {
  const jwt = session.jwt;
  const expiresAt = "expiresAt" in session ? session.expiresAt : session.expires_at;
  const account = "account" in session ? session.account : currentAccountFromApi(jwt, session.accounts);
  return { jwt, expiresAt, account };
}

async function parseAuthResponse(response: Response): Promise<AuthSession> {
  const body = await response.json().catch(() => null) as { data?: AuthApiResponseSession; error?: { message?: string } } | null;
  if (!response.ok || !body?.data) {
    throw new Error(body?.error?.message ?? response.statusText ?? "Auth request failed");
  }
  return normalizeSession(body.data);
}

function buildAuthHeaders(body?: unknown, jwt?: string | null) {
  return {
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

async function fetchAuthSession(path: string, body?: unknown, jwt?: string | null): Promise<AuthSession> {
  const response = await fetch(path, {
    method: "POST",
    headers: buildAuthHeaders(body, jwt),
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseAuthResponse(response);
}

async function fetchPasskeyOptions<T>(path: string, requestBody?: unknown, jwt?: string | null): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: buildAuthHeaders(requestBody, jwt),
    body: requestBody ? JSON.stringify(requestBody) : undefined,
  });
  const body = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? response.statusText ?? "Passkey request failed");
  return body.data;
}

export class AuthService {
  // account$ lưu qua IndexedDB → không mất session giữa các lần F5 / khi SharedWorker tái tạo.
  public readonly account$ = new IndexedDBBehaviorSubject<AuthAccountState>("auth.account", { loading: true });
  private refreshPromise: Promise<AuthSession | null> | null = null;

  constructor() {
    // Khôi phục state đã lưu trước (để có jwt ngay khi vào), rồi refresh nền để xác thực lại.
    this.account$.hydrated
      .then(() => this.refresh())
      .catch(() => {
        this.account$.next({ loading: false });
      });
  }

  async setSession(session: AuthSession | null, options: { loading?: boolean } = {}) {
    this.account$.next({ loading: options.loading ?? false, state: session ?? undefined });
  }

  async login(session: AuthApiResponseSession | AuthSession) {
    this.account$.next({ loading: false, state: normalizeSession(session) });
  }

  async beginPasskeyRegistration(username: string) {
    const displayName = username.trim();
    if (!displayName) throw new Error("Username is required");
    const current = this.account$.getValue().state;
    return fetchPasskeyOptions<PasskeyRegistrationOptions>("/auth-api/passkey/register-options", { username: displayName }, current?.jwt);
  }

  async finishPasskeyRegistration(username: string, credential: PasskeyCredentialJSON) {
    const displayName = username.trim();
    if (!displayName) throw new Error("Username is required");
    const current = this.account$.getValue().state;
    this.account$.next({ loading: true, state: current });
    try {
      const session = await fetchAuthSession("/auth-api/passkey/register", { ...credential, username: displayName }, current?.jwt);
      this.account$.next({ loading: false, state: session });
      return session;
    } catch (error) {
      this.account$.next({ loading: false, state: this.account$.getValue().state });
      throw error;
    }
  }

  async beginPasskeyLogin() {
    return fetchPasskeyOptions<PasskeyLoginOptions>("/auth-api/passkey/login-options");
  }

  async finishPasskeyLogin(credential: PasskeyCredentialJSON) {
    this.account$.next({ loading: true, state: this.account$.getValue().state });
    try {
      const session = await fetchAuthSession("/auth-api/passkey/login", credential);
      this.account$.next({ loading: false, state: session });
      return session;
    } catch (error) {
      this.account$.next({ loading: false });
      throw error;
    }
  }

  async logout() {
    const current = this.account$.getValue().state;
    this.account$.next({ loading: true, state: current });
    await fetch("/auth-api/logout", {
      method: "POST",
      headers: current?.jwt ? { Authorization: `Bearer ${current.jwt}` } : undefined,
    }).catch(() => {});
    this.account$.next({ loading: false });
  }

  async refresh() {
    const current = this.account$.getValue().state;
    if (this.refreshPromise) return this.refreshPromise;
    this.account$.next({ loading: true, state: current });

    this.refreshPromise = (async () => {
      const response = await fetch("/auth-api/refresh", {
        method: "POST",
        headers: current?.jwt ? { Authorization: `Bearer ${current.jwt}` } : undefined,
      });
      const nextSession = await parseAuthResponse(response);
      this.account$.next({ loading: false, state: nextSession });
      return nextSession;
    })().catch((error) => {
      this.account$.next({ loading: false });
      if (error instanceof Error) throw error;
      throw new Error(String(error));
    }).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /** Đợi account$ ổn định (loading=false) rồi mới lấy token — tránh việc vừa vào web (đang
   *  hydrate/refresh) đã trả null khiến request tài nguyên fail. Có timeout để không kẹt mãi. */
  private async waitUntilSettled(maxMs = 10_000): Promise<void> {
    if (!this.account$.getValue().loading) return;
    await firstValueFrom(
      this.account$.pipe(
        filter((s) => !s.loading),
        timeout({ first: maxMs }),
        catchError(() => of(null))
      )
    );
  }

  async getAccessToken() {
    await this.waitUntilSettled();
    const current = this.account$.getValue().state;
    if (!current?.jwt) return null;
    if (current.expiresAt - Date.now() > JWT_REFRESH_SKEW_MS) return current.jwt;
    const refreshed = await this.refresh();
    return refreshed?.jwt ?? null;
  }
}
