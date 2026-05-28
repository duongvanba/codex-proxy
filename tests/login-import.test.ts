import { describe, expect, test } from "bun:test";
import { sessionJsonToTokens } from "../src/server/services/login-flow";
import { refreshAccountAccessToken } from "../src/server/services/accounts";
import type { Account } from "../src/server/schemas";

function fakeJwt(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

describe("account import parsing", () => {
  test("maps exported account JSON to stored token shape without session token", () => {
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "user@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
    });

    const result = sessionJsonToTokens(JSON.stringify({
      user: { email: "user@example.com" },
      account: { id: "acct-from-json", planType: "plus" },
      accessToken,
      sessionToken: "do-not-store",
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokens.access_token).toBe(accessToken);
    expect(result.tokens.account_id).toBe("acct-from-json");
    expect(result.tokens.refresh_token).toBe("");
    expect("sessionToken" in result.tokens).toBe(false);
  });

  test("rejects JSON without an access token", () => {
    const result = sessionJsonToTokens(JSON.stringify({ account: { id: "acct" } }));
    expect(result.ok).toBe(false);
  });

  test("skips refresh for access-token-only accounts", async () => {
    const account: Account = {
      id: "access-only",
      email: "user@example.com",
      accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
      refreshToken: "",
      accountId: "acct",
      addedAt: Date.now(),
      status: "active",
      requestCount: 0,
    };

    const result = await refreshAccountAccessToken(account, { force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refreshed).toBe(false);
  });
});
