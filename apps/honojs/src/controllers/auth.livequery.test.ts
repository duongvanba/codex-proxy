import { test, expect, describe } from "bun:test";
import { AuthController } from "./auth.livequery";
import { InternalAuthService } from "../services/internal-auth";

const ACCOUNTS = [{ id: "acc_1", email: "a@b.com" }] as any;

function makeController(internalAuth: InternalAuthService) {
  const accounts = { getAccounts: () => ACCOUNTS } as any;
  return new AuthController(accounts, internalAuth);
}

function cookieValue(res: Response, name: string): string | null {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${name}=([^;]*)`));
  return match ? match[1] : null;
}

function decodeJwt(token: string): any {
  const payload = token.split(".")[1] ?? "";
  const norm = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(norm, "base64").toString("utf8"));
}

// A nằm ĐẦU danh sách, B nằm sau — để chứng minh phiên gắn đúng account login, không phải A.
const MULTI = [
  { id: "acc_a", email: "a@b.com" },
  { id: "acc_b", email: "b@b.com" },
] as any[];

function makeMultiController(internalAuth: InternalAuthService) {
  const accounts = { getAccounts: () => MULTI } as any;
  return new AuthController(accounts, internalAuth);
}

describe("AuthController refresh-token cookie", () => {
  test("refresh thiếu cookie -> 401 lỗi", async () => {
    const app = makeController(new InternalAuthService());
    const res = await app.request("/auth-api/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Missing refresh token");
  });

  test("refresh với cookie hợp lệ -> cấp access token mới", async () => {
    const internalAuth = new InternalAuthService();
    const refresh = await internalAuth.issueRefreshToken(ACCOUNTS);
    const app = makeController(internalAuth);
    const res = await app.request("/auth-api/refresh", {
      method: "POST",
      headers: { cookie: `refresh_token=${encodeURIComponent(refresh.token)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.jwt).toBeTruthy();
  });

  test("refresh với token rác -> 401", async () => {
    const app = makeController(new InternalAuthService());
    const res = await app.request("/auth-api/refresh", {
      method: "POST",
      headers: { cookie: "refresh_token=not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  test("logout xoá refresh_token cookie (Max-Age=0)", async () => {
    const app = makeController(new InternalAuthService());
    const res = await app.request("/auth-api/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("refresh_token=;");
    expect(setCookie).toContain("Max-Age=0");
  });

  test("refresh token bị thu hồi sau logout (sessionVersion đổi)", async () => {
    const internalAuth = new InternalAuthService();
    const refresh = await internalAuth.issueRefreshToken(ACCOUNTS);
    internalAuth.logout();
    const app = makeController(internalAuth);
    const res = await app.request("/auth-api/refresh", {
      method: "POST",
      headers: { cookie: `refresh_token=${encodeURIComponent(refresh.token)}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("revoked");
  });
});

describe("AuthController gắn phiên vào account vừa login (không phải account đầu danh sách)", () => {
  test("refresh giữ nguyên account của phiên (sub=B), không rơi về A", async () => {
    const internalAuth = new InternalAuthService();
    // refresh token cấp với B làm primary (B đứng đầu)
    const refresh = await internalAuth.issueRefreshToken([MULTI[1], MULTI[0]]);
    expect(decodeJwt(refresh.token).sub).toBe("acc_b");

    const app = makeMultiController(internalAuth);
    const res = await app.request("/auth-api/refresh", {
      method: "POST",
      headers: { cookie: `refresh_token=${encodeURIComponent(refresh.token)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const claims = decodeJwt(body.data.jwt);
    expect(claims.sub).toBe("acc_b"); // vẫn B, dù A đứng đầu getAccounts()
    expect(claims.email).toBe("b@b.com");
  });
});

describe("InternalAuthService auth account session", () => {
  test("current account session chỉ trả auth username, không trả OpenAI account fields", async () => {
    const internalAuth = new InternalAuthService();
    const session = await internalAuth.issueCurrentAccount(ACCOUNTS[0], { auth_provider: "passkey", username: "duongvanba" });

    expect(session.jwt).toBeTruthy();
    expect(session.account).toEqual({ username: "duongvanba" });
    expect("email" in session.account).toBe(false);
    expect("status" in session.account).toBe(false);
    expect("requestCount" in session.account).toBe(false);
  });
});
