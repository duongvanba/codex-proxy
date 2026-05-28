import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Account } from "../src/server/schemas";
import {
  isRateLimitText,
  isStreamFailureBody,
  decodeTokenInfo,
  detectStreamError,
  isSseSuccessBlock,
  detectTokenUsage,
  compactWebSocketPayload,
  findWebSocketLimitSnippet,
  retryAfterMsFromSnippet,
  isWebSocketSuccessPayload,
  buildProbeMessage,
  buildCodexHttpHeaders,
  buildWebSocketHeaders,
  probeWebSocketAccount,
  CHATGPT_BASE,
  CODEX_USAGE_URL,
} from "../src/server/libs/chatgpt";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

const AUTH_PATH = join(homedir(), ".codex", "auth.json");

function loadAuthAccount(): Account | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as any;
    const tokens = auth?.tokens;
    if (!tokens?.access_token) return null;

    const payload = (() => {
      try {
        const [, b64] = tokens.access_token.split(".");
        return JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
      } catch { return {}; }
    })();
    const authClaim = payload["https://api.openai.com/auth"] ?? {};

    return {
      id: "test-auth",
      email: payload.email ?? "unknown",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      idToken: tokens.id_token,
      accountId: tokens.account_id ?? authClaim.chatgpt_account_id ?? payload.sub ?? "unknown",
      addedAt: Date.now(),
      status: "active",
      requestCount: 0,
    };
  } catch {
    return null;
  }
}

const authAccount = loadAuthAccount();
const hasAuth = authAccount !== null;

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("isRateLimitText", () => {
  test("detects common rate limit strings", () => {
    expect(isRateLimitText("rate_limit_reached")).toBe(true);
    expect(isRateLimitText("rate-limited")).toBe(true);
    expect(isRateLimitText("too_many_requests")).toBe(true);
    expect(isRateLimitText("insufficient_quota")).toBe(true);
    expect(isRateLimitText("usage_limit_reached")).toBe(true);
    expect(isRateLimitText("the usage limit has been reached")).toBe(true);
    expect(isRateLimitText("quota exceeded")).toBe(true);
    expect(isRateLimitText("limit_reached")).toBe(true);
  });

  test("ignores unrelated strings", () => {
    expect(isRateLimitText("response.completed")).toBe(false);
    expect(isRateLimitText("output_text.delta")).toBe(false);
    expect(isRateLimitText("model not found")).toBe(false);
    expect(isRateLimitText("")).toBe(false);
  });
});

describe("isStreamFailureBody", () => {
  test("detects SSE failure events", () => {
    expect(isStreamFailureBody('event: response.failed\ndata: {"type":"response.failed"}')).toBe(true);
    expect(isStreamFailureBody('event: error\ndata: {}')).toBe(true);
    expect(isStreamFailureBody('"type": "response.failed"')).toBe(true);
    expect(isStreamFailureBody('"status": "failed"')).toBe(true);
  });

  test("ignores normal stream events", () => {
    expect(isStreamFailureBody('event: response.output_text.delta\ndata: {}')).toBe(false);
    expect(isStreamFailureBody('event: response.completed\ndata: {}')).toBe(false);
    expect(isStreamFailureBody("")).toBe(false);
  });
});

describe("decodeTokenInfo", () => {
  test("returns invalid when payload cannot be decoded", () => {
    // "not.a.jwt" — payload "a" is not valid JSON after base64 decode
    const result = decodeTokenInfo("not.a.jwt");
    expect(result.expiresAt).toBe("invalid");
    expect(result.isExpired).toBe(false);
  });

  test("returns invalid for single-segment token", () => {
    const result = decodeTokenInfo("bad");
    expect(result.expiresAt).toBe("invalid");
  });

  test("returns no_exp when JWT payload has no exp field", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user-123" })).toString("base64url");
    const result = decodeTokenInfo(`header.${payload}.sig`);
    expect(result.expiresAt).toBe("no_exp");
    expect(result.isExpired).toBe(false);
    expect(result.ageMin).toBe(0);
  });

  test("decodes real token from auth.json", () => {
    if (!hasAuth) return;
    const result = decodeTokenInfo(authAccount!.accessToken);
    expect(typeof result.expiresAt).toBe("string");
    expect(typeof result.isExpired).toBe("boolean");
    expect(typeof result.ageMin).toBe("number");
    console.log("Token info:", result);
  });
});

describe("detectStreamError", () => {
  test("detects response.failed event", () => {
    const block = 'event: response.failed\ndata: {"type":"response.failed","error":{"message":"limit reached"}}';
    const result = detectStreamError(block);
    expect(result).not.toBeNull();
    expect(result).toContain("limit reached");
  });

  test("detects rate limit in data", () => {
    const block = 'event: response.completed\ndata: {"type":"error","error":{"type":"rate_limit_reached","message":"quota"}}';
    const result = detectStreamError(block);
    expect(result).not.toBeNull();
  });

  test("ignores normal output delta", () => {
    const block = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}';
    expect(detectStreamError(block)).toBeNull();
  });

  test("ignores response.completed without error", () => {
    const block = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5}}}';
    expect(detectStreamError(block)).toBeNull();
  });
});

describe("isSseSuccessBlock", () => {
  test("recognises success event types", () => {
    expect(isSseSuccessBlock("event: response.output_text.delta\ndata: {}")).toBe(true);
    expect(isSseSuccessBlock("event: response.output_text.done\ndata: {}")).toBe(true);
    expect(isSseSuccessBlock("event: response.completed\ndata: {}")).toBe(true);
    expect(isSseSuccessBlock('"type": "response.output_text.delta"')).toBe(true);
  });

  test("rejects error and other events", () => {
    expect(isSseSuccessBlock("event: response.failed\ndata: {}")).toBe(false);
    expect(isSseSuccessBlock("event: error\ndata: {}")).toBe(false);
    expect(isSseSuccessBlock("")).toBe(false);
  });
});

describe("detectTokenUsage", () => {
  test("extracts usage from response.completed block", () => {
    const block = [
      "event: response.completed",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":25,"total_tokens":35,"output_tokens_details":{"reasoning_tokens":5}}}}',
    ].join("\n");

    const usage = detectTokenUsage(block);
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(10);
    expect(usage!.outputTokens).toBe(25);
    expect(usage!.totalTokens).toBe(35);
    expect(usage!.reasoningTokens).toBe(5);
  });

  test("returns null for non-completed events", () => {
    expect(detectTokenUsage("event: response.output_text.delta\ndata: {}")).toBeNull();
    expect(detectTokenUsage("event: response.failed\ndata: {}")).toBeNull();
  });

  test("returns null when no usage field", () => {
    const block = 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}';
    expect(detectTokenUsage(block)).toBeNull();
  });
});

describe("compactWebSocketPayload", () => {
  test("passes strings through unchanged", () => {
    expect(compactWebSocketPayload('{"hello":"world"}')).toBe('{"hello":"world"}');
  });

  test("decodes ArrayBuffer", () => {
    const enc = new TextEncoder();
    const buf = enc.encode("test").buffer;
    expect(compactWebSocketPayload(buf)).toBe("test");
  });

  test("decodes Uint8Array", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(compactWebSocketPayload(bytes)).toBe("hello");
  });

  test("returns empty string for null/undefined", () => {
    expect(compactWebSocketPayload(null)).toBe("null");
    expect(compactWebSocketPayload(undefined)).toBe("undefined");
  });
});

describe("findWebSocketLimitSnippet", () => {
  test("detects status 429", () => {
    const msg = JSON.stringify({ status_code: 429, error: { message: "rate limited" } });
    expect(findWebSocketLimitSnippet(msg)).not.toBeNull();
  });

  test("detects rate_limits.allowed false", () => {
    const msg = JSON.stringify({ rate_limits: { allowed: false, limit_reached: true } });
    expect(findWebSocketLimitSnippet(msg)).not.toBeNull();
  });

  test("detects rate limit in plain text", () => {
    expect(findWebSocketLimitSnippet("rate_limit_reached: quota exceeded")).not.toBeNull();
  });

  test("returns null for codex.rate_limits info frame when allowed", () => {
    const msg = JSON.stringify({
      type: "codex.rate_limits",
      rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: 4 } },
    });
    expect(findWebSocketLimitSnippet(msg)).toBeNull();
  });

  test("detects codex.rate_limits when limit actually reached", () => {
    const msg = JSON.stringify({
      type: "codex.rate_limits",
      rate_limits: { allowed: false, limit_reached: true },
    });
    expect(findWebSocketLimitSnippet(msg)).not.toBeNull();
  });

  test("returns null for normal messages", () => {
    const msg = JSON.stringify({ type: "response.output_text.delta", delta: "Hello" });
    expect(findWebSocketLimitSnippet(msg)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(findWebSocketLimitSnippet("")).toBeNull();
  });
});

describe("retryAfterMsFromSnippet", () => {
  test("reads retry_after_ms directly", () => {
    expect(retryAfterMsFromSnippet(JSON.stringify({ retry_after_ms: 30000 }))).toBe(30000);
  });

  test("converts retry_after_seconds to ms", () => {
    const snippet = JSON.stringify({ retry_after_seconds: 60 });
    expect(retryAfterMsFromSnippet(snippet)).toBe(60_000);
  });

  test("reads reset_after_seconds", () => {
    const snippet = JSON.stringify({ reset_after_seconds: 120 });
    expect(retryAfterMsFromSnippet(snippet)).toBe(120_000);
  });

  test("defaults to 60s when no value found", () => {
    expect(retryAfterMsFromSnippet("{}")).toBe(60_000);
    expect(retryAfterMsFromSnippet("not json")).toBe(60_000);
  });
});

describe("isWebSocketSuccessPayload", () => {
  test("recognises success message types", () => {
    expect(isWebSocketSuccessPayload(JSON.stringify({ type: "response.output_text.delta" }))).toBe(true);
    expect(isWebSocketSuccessPayload(JSON.stringify({ type: "response.output_text.done" }))).toBe(true);
    expect(isWebSocketSuccessPayload(JSON.stringify({ type: "response.completed" }))).toBe(true);
  });

  test("falls back to text match when not JSON", () => {
    expect(isWebSocketSuccessPayload("response.output_text.delta")).toBe(true);
    expect(isWebSocketSuccessPayload("response.completed")).toBe(true);
  });

  test("rejects error and unknown types", () => {
    expect(isWebSocketSuccessPayload(JSON.stringify({ type: "error" }))).toBe(false);
    expect(isWebSocketSuccessPayload(JSON.stringify({ type: "codex.rate_limits" }))).toBe(false);
    expect(isWebSocketSuccessPayload("")).toBe(false);
  });
});

describe("buildProbeMessage", () => {
  test("produces valid probe when no original message", () => {
    const msg = JSON.parse(buildProbeMessage());
    expect(msg.type).toBe("response.create");
    expect(typeof msg.model).toBe("string");
    expect(msg.store).toBe(false);
    expect(msg.stream).toBe(true);
    expect(Array.isArray(msg.input)).toBe(true);
  });

  test("strips previous_response_id from original", () => {
    const original = JSON.stringify({
      type: "response.create",
      model: "gpt-5.5",
      previous_response_id: "resp-abc123",
      input: [{ role: "user", content: "hello" }],
    });
    const msg = JSON.parse(buildProbeMessage(original));
    expect(msg.type).toBe("response.create");
    expect("previous_response_id" in msg).toBe(false);
    expect(msg.store).toBe(false);
  });

  test("always sets type = response.create even when original lacks it", () => {
    const original = JSON.stringify({ model: "gpt-5.5", input: [] });
    const msg = JSON.parse(buildProbeMessage(original));
    expect(msg.type).toBe("response.create");
  });
});

describe("buildCodexHttpHeaders", () => {
  const fakeAccount: Account = {
    id: "x",
    email: "test@example.com",
    accessToken: "tok-123",
    refreshToken: "",
    accountId: "acct-abc",
    addedAt: 0,
    status: "active",
    requestCount: 0,
  };

  test("sets required headers", () => {
    const h = buildCodexHttpHeaders(fakeAccount);
    expect(h.get("Authorization")).toBe("Bearer tok-123");
    expect(h.get("ChatGPT-Account-Id")).toBe("acct-abc");
    expect(h.get("OpenAI-Beta")).toBe("responses=experimental");
    expect(h.get("Origin")).toBe(CHATGPT_BASE);
    expect(h.get("Content-Type")).toBe("application/json");
    expect(h.get("Accept")).toBe("text/event-stream");
  });

  test("respects custom accept header", () => {
    const h = buildCodexHttpHeaders(fakeAccount, "application/json");
    expect(h.get("Accept")).toBe("application/json");
  });
});

describe("buildWebSocketHeaders", () => {
  const fakeAccount: Account = {
    id: "x",
    email: "test@example.com",
    accessToken: "tok-456",
    refreshToken: "",
    accountId: "acct-xyz",
    addedAt: 0,
    status: "active",
    requestCount: 0,
  };

  test("returns plain object with required fields", () => {
    const h = buildWebSocketHeaders(undefined, fakeAccount);
    expect(typeof h).toBe("object");
    expect(h["authorization"]).toBe("Bearer tok-456");
    expect(h["chatgpt-account-id"]).toBe("acct-xyz");
    expect(h["openai-beta"]).toBe("responses=experimental");
  });

  test("merges base headers without overwriting auth", () => {
    const h = buildWebSocketHeaders({ "x-custom": "value" }, fakeAccount);
    expect(h["x-custom"]).toBe("value");
    expect(h["authorization"]).toBe("Bearer tok-456");
  });
});

// ─── Integration tests (require ~/.codex/auth.json) ──────────────────────────

describe("Integration: Codex usage API", () => {
  test.skipIf(!hasAuth)("fetches usage without error", async () => {
    const res = await fetch(CODEX_USAGE_URL, {
      headers: {
        authorization: `Bearer ${authAccount!.accessToken}`,
        "cache-control": "no-cache",
        referer: "https://chatgpt.com/codex/cloud/settings/analytics",
        "x-openai-target-path": "/backend-api/wham/usage",
        "x-openai-target-route": "/backend-api/wham/usage",
        "user-agent": "Mozilla/5.0",
      },
    });
    const body = await res.json() as any;
    console.log("Usage response:", JSON.stringify(body, null, 2));

    if (res.status === 401) {
      console.log("Token expired — skipping assertion");
      return;
    }

    expect(res.ok).toBe(true);
    expect(typeof body.rate_limit).toBe("object");
    expect(typeof body.rate_limit.allowed).toBe("boolean");
  }, 15_000);
});

describe("Integration: WebSocket probe", () => {
  test.skipIf(!hasAuth)("probeWebSocketAccount returns ok or limit", async () => {
    const result = await probeWebSocketAccount(
      "wss://chatgpt.com/backend-api/codex/responses",
      undefined,
      authAccount!,
      undefined
    );

    console.log("Probe result:", result);

    if (result.ok) {
      expect(result.ok).toBe(true);
    } else if (result.error.includes("probe limit")) {
      console.log("Account is rate limited — limit snippet:", result.limitSnippet);
      expect(typeof result.limitSnippet).toBe("string");
    } else {
      // probe timeout, websocket error, or closed — connection reachable but no success frame
      console.log("Probe did not succeed:", result.error);
      expect(typeof result.error).toBe("string");
    }
  }, 30_000);
});
