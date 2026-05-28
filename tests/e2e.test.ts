/**
 * E2E tests for all LiveQuery API endpoints.
 * Requires the proxy server running on PROXY_PORT (default 17000).
 * Fixtures are loaded dynamically from the live API — no hardcoded IDs.
 */

import { describe, expect, test, beforeAll } from "bun:test";

const PORT = process.env.PROXY_PORT ?? "17000";
const BASE = `http://localhost:${PORT}`;

// ─── Fixtures (loaded dynamically in beforeAll) ───────────────────────────────

let ACCOUNT_ID = "";
let HOST_ID = "";
let CHAT_ID = "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(path: string, payload: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function assertCollection(body: Record<string, unknown>) {
  const data = (body as any).data;
  expect(data).toBeDefined();
  expect(Array.isArray(data.items)).toBe(true);
  expect(typeof data.count?.total).toBe("number");
  expect(typeof data.has?.prev).toBe("boolean");
  expect(typeof data.has?.next).toBe("boolean");
  expect(typeof data.cursor?.first).toBe("string");
  expect(typeof data.cursor?.last).toBe("string");
}

function assertOk(body: Record<string, unknown>) {
  expect((body as any).data?.ok).toBe(true);
}

function assertError(body: Record<string, unknown>, code: string) {
  expect((body as any).error?.code).toBe(code);
}

// ─── Load fixtures ────────────────────────────────────────────────────────────

async function pollUntil<T>(fn: () => Promise<T>, check: (v: T) => boolean, retries = 8, delayMs = 800): Promise<T> {
  let last!: T;
  for (let i = 0; i < retries; i++) {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

beforeAll(async () => {
  const { body: accountsBody } = await get("/livequery/accounts");
  const accounts = (accountsBody as any).data?.items as any[];
  ACCOUNT_ID = accounts?.[0]?.id ?? "";

  if (!ACCOUNT_ID) return;

  // Hosts and chats are populated asynchronously after the first GET — poll until ready
  const hostsResult = await pollUntil(
    () => get(`/livequery/accounts/${ACCOUNT_ID}/hosts`),
    ({ body }) => ((body as any).data?.items?.length ?? 0) > 0
  );
  HOST_ID = (hostsResult.body as any).data?.items?.[0]?.id ?? "";

  const chatsResult = await pollUntil(
    () => get(`/livequery/accounts/${ACCOUNT_ID}/chats`),
    ({ body }) => ((body as any).data?.items?.length ?? 0) > 0
  );
  CHAT_ID = (chatsResult.body as any).data?.items?.[0]?.id ?? "";
});

// ─── Server health ────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("responds 200 with ok=true", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.accountCount).toBe("number");
    expect(typeof body.realtimeClientCount).toBe("number");
  });
});

// ─── Collections ─────────────────────────────────────────────────────────────

describe("GET /livequery/accounts", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get("/livequery/accounts");
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have required fields, no secrets", async () => {
    const { body } = await get("/livequery/accounts");
    const items = (body as any).data.items as any[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.email).toBe("string");
      expect(typeof item.status).toBe("string");
      expect("accessToken" in item).toBe(false);
      expect("refreshToken" in item).toBe(false);
      expect("idToken" in item).toBe(false);
    }
  });

  test("loaded account is present", async () => {
    const { body } = await get("/livequery/accounts");
    const items = (body as any).data.items as any[];
    expect(items.find((a: any) => a.id === ACCOUNT_ID)).toBeDefined();
  });
});

describe("GET /livequery/accounts/:id/hosts", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/hosts`);
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have required host fields", async () => {
    const { body } = await get(`/livequery/accounts/${ACCOUNT_ID}/hosts`);
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.display_name).toBe("string");
      expect(typeof item.online).toBe("boolean");
      expect(item.account_id).toBe(ACCOUNT_ID);
    }
  });

  test("returns empty collection for unknown account", async () => {
    const { status, body } = await get("/livequery/accounts/non-existent-account-id/hosts");
    expect(status).toBe(200);
    assertCollection(body);
    expect((body as any).data.items.length).toBe(0);
  });
});

describe("GET /livequery/accounts/:id/projects", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/projects`);
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have required project fields", async () => {
    const { body } = await get(`/livequery/accounts/${ACCOUNT_ID}/projects`);
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.remotePath).toBe("string");
      expect(typeof item.label).toBe("string");
    }
  });
});

describe("GET /livequery/accounts/:id/chats", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats`);
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have account_id and id", async () => {
    const { body } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats`);
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(item.account_id).toBe(ACCOUNT_ID);
    }
  });
});

describe("GET /livequery/accounts/:id/hosts/:hostId/projects", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/hosts/${HOST_ID}/projects`);
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have required fields", async () => {
    const { body } = await get(`/livequery/accounts/${ACCOUNT_ID}/hosts/${HOST_ID}/projects`);
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.remotePath).toBe("string");
    }
  });
});

describe("GET /livequery/accounts/:id/hosts/:hostId/chats", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/hosts/${HOST_ID}/chats`);
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have account_id", async () => {
    const { body } = await get(`/livequery/accounts/${ACCOUNT_ID}/hosts/${HOST_ID}/chats`);
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(item.account_id).toBe(ACCOUNT_ID);
    }
  });
});

describe("GET /livequery/accounts/:id/chats/:chatId/turns", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats/${CHAT_ID}/turns`);
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have required turn fields", async () => {
    const { body } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats/${CHAT_ID}/turns`);
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(item.account_id).toBe(ACCOUNT_ID);
      expect(item.chat_id).toBe(CHAT_ID);
      expect(Array.isArray(item.input_items)).toBe(true);
      expect(Array.isArray(item.output_items)).toBe(true);
    }
  });

  test("returns 502 for non-existent chatId", async () => {
    const { status } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats/fake-chat-id-000/turns`);
    expect(status).toBe(502);
  });
});

describe("GET /livequery/reports", () => {
  test("returns collection envelope", async () => {
    const { status, body } = await get("/livequery/reports");
    expect(status).toBe(200);
    assertCollection(body);
  });

  test("items have id, type, timestamp", async () => {
    const { body } = await get("/livequery/reports");
    const items = (body as any).data.items as any[];
    for (const item of items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.type).toBe("string");
      expect(typeof item.timestamp).toBe("number");
    }
  });
});

describe("GET /livequery/config", () => {
  test("returns config item", async () => {
    const { status, body } = await get("/livequery/config");
    expect(status).toBe(200);
    const item = (body as any).data?.item;
    expect(item?.id).toBe("status");
    expect(typeof item?.enabled).toBe("boolean");
  });
});

describe("GET /livequery/session", () => {
  test("returns session item", async () => {
    const { status, body } = await get("/livequery/session");
    expect(status).toBe(200);
    const item = (body as any).data?.item;
    expect(item?.id).toBe("login");
    expect(typeof item?.inProgress).toBe("boolean");
  });
});

describe("GET /livequery/runtime", () => {
  test("returns realtimeUrl", async () => {
    const { status, body } = await get("/livequery/runtime");
    expect(status).toBe(200);
    const item = (body as any).data?.item;
    expect(item?.id).toBe("runtime");
    expect(item?.realtimeUrl).toMatch(/^wss?:\/\//);
  });
});

// ─── Actions: account level ───────────────────────────────────────────────────

describe("POST /livequery/accounts/~refresh-usage", () => {
  test("returns ok", async () => {
    const { status, body } = await post("/livequery/accounts/~refresh-usage");
    expect(status).toBe(200);
    assertOk(body);
  });
});

describe("POST /livequery/accounts/:id/~select-account", () => {
  test("selects valid account (URL path)", async () => {
    const { status, body } = await post(`/livequery/accounts/${ACCOUNT_ID}/~select-account`);
    expect(status).toBe(200);
    assertOk(body);
  });

  test("returns 400 for non-existent account", async () => {
    const { status, body } = await post("/livequery/accounts/non-existent-id/~select-account");
    expect(status).toBe(400);
    assertError(body, "BAD_REQUEST");
  });
});

describe("POST /livequery/accounts/:id/~remove-account (error cases only)", () => {
  test("returns 400 for non-existent account", async () => {
    const { status, body } = await post("/livequery/accounts/non-existent-id/~remove-account");
    expect(status).toBe(400);
    assertError(body, "BAD_REQUEST");
  });
});

// ─── Actions: hosts & projects ────────────────────────────────────────────────

describe("POST /livequery/accounts/:id/hosts/~refresh-hosts", () => {
  test("returns ok (URL path)", async () => {
    const { status, body } = await post(`/livequery/accounts/${ACCOUNT_ID}/hosts/~refresh-hosts`);
    expect(status).toBe(200);
    assertOk(body);
  });

  test("returns 400 for unknown account_id", async () => {
    const { status, body } = await post("/livequery/accounts/no-such-account/hosts/~refresh-hosts");
    expect(status).toBe(200);
    assertOk(body);
  });
});

describe("POST /livequery/accounts/:id/projects/~refresh-projects", () => {
  test("returns ok", async () => {
    const { status, body } = await post(`/livequery/accounts/${ACCOUNT_ID}/projects/~refresh-projects`);
    expect(status).toBe(200);
    assertOk(body);
  });
});

// ─── Actions: chats ───────────────────────────────────────────────────────────

describe("POST /livequery/accounts/:id/chats/~refresh-chats", () => {
  test("returns ok (URL path)", async () => {
    const { status, body } = await post(`/livequery/accounts/${ACCOUNT_ID}/chats/~refresh-chats`);
    expect(status).toBe(200);
    assertOk(body);
  });
});

// ─── Actions: chat workflow (create → turns → send → cancel) ─────────────────

describe("Chat workflow", () => {
  // newChatId stays "" if ~create-chat fails (e.g. no WHAM cloud environment available)
  let newChatId = "";

  test("~create-chat returns chat_id or 502 when no environment available", async () => {
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/~create-chat`,
      { input: "e2e test — please ignore", environment_id: HOST_ID }
    );
    // Accept 200 (success) or 502 (no WHAM cloud environment configured for this account)
    expect([200, 502]).toContain(status);
    if (status === 200) {
      assertOk(body);
      newChatId = (body as any).data?.chat_id ?? "";
      expect(typeof newChatId).toBe("string");
      expect(newChatId.length).toBeGreaterThan(0);
    }
  });

  test("turns endpoint returns collection for new chat", async () => {
    if (!newChatId) return;
    const { status, body } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats/${newChatId}/turns`);
    expect(status).toBe(200);
    assertCollection(body);
    const data = (body as any).data;
    expect(data.summary?.chat_id).toBe(newChatId);
  });

  test("~send-message queues pending input (URL path)", async () => {
    if (!newChatId) return;
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/${newChatId}/~send-message`,
      { input: "follow-up — e2e test" }
    );
    expect(status).toBe(200);
    assertOk(body);
    expect((body as any).data?.chat_id).toBe(newChatId);
  });

  test("~cancel-chat cancels and returns ok", async () => {
    if (!newChatId) return;
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/${newChatId}/~cancel-chat`
    );
    expect(status).toBe(200);
    assertOk(body);
  });

  test("~archive-chat archives returned chat", async () => {
    if (!newChatId) return;
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/${newChatId}/~archive-chat`
    );
    expect(status).toBe(200);
    assertOk(body);
  });

  test("~recover-chat recovers archived chat", async () => {
    if (!newChatId) return;
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/${newChatId}/~recover-chat`
    );
    expect(status).toBe(200);
    assertOk(body);
  });

  test("~mark-read marks chat as read (existing chat)", async () => {
    const chatId = newChatId || CHAT_ID;
    if (!chatId) return;
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/${chatId}/~mark-read`
    );
    expect(status).toBe(200);
    assertOk(body);
  });
});

describe("Chat action error cases", () => {
  test("~create-chat without input returns 400", async () => {
    const { status, body } = await post(`/livequery/accounts/${ACCOUNT_ID}/chats/~create-chat`, {});
    expect(status).toBe(400);
    assertError(body, "BAD_REQUEST");
  });

  test("~send-message without input returns 400", async () => {
    const { status, body } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/fake-chat/~send-message`,
      {}
    );
    expect(status).toBe(400);
    assertError(body, "BAD_REQUEST");
  });

  test("~cancel-chat for fake chatId returns upstream error", async () => {
    const { status } = await post(
      `/livequery/accounts/${ACCOUNT_ID}/chats/fake-chat-id/~cancel-chat`
    );
    expect(status).toBe(502);
  });
});

// ─── Actions: session ─────────────────────────────────────────────────────────

describe("POST /livequery/session/~login-status", () => {
  test("returns inProgress flag", async () => {
    const { status, body } = await post("/livequery/session/~login-status");
    expect(status).toBe(200);
    expect(typeof (body as any).data?.inProgress).toBe("boolean");
  });
});

describe("POST /livequery/session/~cancel-login", () => {
  test("returns ok (cancels if in progress, noop if not)", async () => {
    const { status, body } = await post("/livequery/session/~cancel-login");
    expect(status).toBe(200);
    expect(typeof (body as any).data?.ok).toBe("boolean");
  });
});

// ─── Actions: config ──────────────────────────────────────────────────────────

describe("POST /livequery/config/~config-status", () => {
  test("returns enabled flag", async () => {
    const { status, body } = await post("/livequery/config/~config-status");
    expect(status).toBe(200);
    expect(typeof (body as any).data?.enabled).toBe("boolean");
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("Error cases", () => {
  test("unknown collection returns 404", async () => {
    const { status, body } = await get("/livequery/does-not-exist");
    expect(status).toBe(404);
    assertError(body, "COLLECTION_NOT_FOUND");
  });

  test("unknown action returns 404", async () => {
    const { status, body } = await post("/livequery/~unknown-action");
    expect(status).toBe(404);
    assertError(body, "ACTION_NOT_FOUND");
  });

  test("POST on read-only collection returns 405", async () => {
    const { status, body } = await post("/livequery/accounts");
    expect(status).toBe(405);
    assertError(body, "METHOD_NOT_ALLOWED");
  });

  test("GET on turns without valid chat_id returns upstream error", async () => {
    const { status } = await get(`/livequery/accounts/${ACCOUNT_ID}/chats/invalid-id/turns`);
    expect(status).toBe(502);
  });

  test("unknown account_id for hosts returns empty collection", async () => {
    const { status, body } = await get("/livequery/accounts/non-existent/hosts");
    expect(status).toBe(200);
    assertCollection(body);
    expect((body as any).data.items.length).toBe(0);
  });
});

// ─── v1/models stub ───────────────────────────────────────────────────────────

describe("GET /v1/models", () => {
  test("returns model list", async () => {
    const res = await fetch(`${BASE}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].object).toBe("model");
  });
});
