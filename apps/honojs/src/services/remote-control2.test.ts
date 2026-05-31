import { test, expect, beforeAll, beforeEach, describe } from "bun:test";

// Mock chatgpt lib BEFORE importing the module under test
import { mock } from "bun:test";
mock.module("../libs/chatgpt", () => ({
  ChatGPTClient: { buildWebSocketHeaders: () => ({ "x-mock-header": "1" }) },
}));

import { WebsocketRelay } from "../libs/codex-remote-control";
import type { Account } from "../schemas";
import type { RCEnrollment } from "../libs/codex-remote-control";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockAccount: Account = {
  id: "acc_test",
  email: "test@example.com",
  accessToken: "tok_test",
  refreshToken: "ref_test",
  accountId: "acc_test",
  addedAt: Date.now(),
  status: "active",
  requestCount: 0,
};

let testEnrollment: RCEnrollment;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  testEnrollment = {
    clientId: "cli_test123",
    token: "rc_token_test",
    keyId: "key_test456",
    privateKeyPkcs8Base64: Buffer.from(pkcs8).toString("base64"),
  };
});

// ─── MockWebSocket ────────────────────────────────────────────────────────────

type WsEventHandler = (event: Record<string, unknown>) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState: number;
  url: string;
  sent: string[] = [];

  private listeners = new Map<string, Set<WsEventHandler>>();

  constructor(url: string, _opts?: unknown) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    MockWebSocket._last = this;
  }

  addEventListener(event: string, handler: WsEventHandler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  removeEventListener(event: string, handler: WsEventHandler) {
    this.listeners.get(event)?.delete(handler);
  }

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  static _last: MockWebSocket | null = null;

  emit(event: string, data?: Record<string, unknown>) {
    const handlers = this.listeners.get(event);
    if (handlers) for (const h of handlers) h(data ?? {});
  }

  open() { this.emit("open"); }
  message(payload: unknown) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", { data });
  }
  close_event(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }
  error_event() { this.emit("error"); }
}

beforeEach(() => {
  MockWebSocket._last = null;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Intercepts ws.send and auto-responds to initialize requests.
function installInitInterceptor(ws: MockWebSocket) {
  const origSend = ws.send.bind(ws);
  ws.send = (data: string) => {
    origSend(data);
    try {
      const msg = JSON.parse(data);
      if (msg.message?.method === "initialize") {
        Promise.resolve().then(() => ws.message({
          type: "server_message",
          message: { id: msg.message.id, result: { protocolVersion: "1.0", userAgent: "test" } },
        }));
      }
    } catch {}
  };
}

function makeChallenge(clientId = "cli_test123") {
  return {
    type: "device_key_challenge",
    nonce: "nonce_abc",
    sessionId: "sess_xyz",
    targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/client",
    accountUserId: "user_001",
    clientId,
    tokenSha256Base64url: "abc123",
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
    scopes: ["codex.remote_control"],
    audience: "remote_control_client",
  };
}

const TEST_ENV_ID = "env_test";

async function connectWithChallenge(rc: WebsocketRelay): Promise<MockWebSocket> {
  rc.connect();                       // trả về Subscription; chờ sẵn sàng qua whenReady()
  await Bun.sleep(0);
  const ws = MockWebSocket._last!;
  installInitInterceptor(ws);
  ws.open();
  await Bun.sleep(0);
  ws.message(makeChallenge());
  await rc.whenReady();
  return ws;
}

// Helper: send a request, capture sent message, respond with result
async function doRequest(
  rc: WebsocketRelay,
  ws: MockWebSocket,
  method: string,
  params: Record<string, unknown>,
  result: unknown,
): Promise<unknown> {
  const sentBefore = ws.sent.length;
  const reqP = rc.request(method, params);
  await Bun.sleep(0);
  const msg = JSON.parse(ws.sent[sentBefore]);
  ws.message({ type: "server_message", message: { id: msg.message.id, result } });
  return reqP;
}

// ─── Connection ───────────────────────────────────────────────────────────────

describe("WebsocketRelay — connection", () => {

  test("connects: proof sent then auto-initializes before resolving", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);

    expect(ws.sent.length).toBeGreaterThanOrEqual(2);

    const proof = JSON.parse(ws.sent[0]);
    expect(proof.type).toBe("device_key_proof");
    expect(proof.keyId).toBe(testEnrollment.keyId);
    expect(proof.algorithm).toBe("ecdsa_p256_sha256");
    expect(typeof proof.signatureDerBase64).toBe("string");
    expect(typeof proof.signedPayloadBase64).toBe("string");

    const initMsg = JSON.parse(ws.sent[1]);
    expect(initMsg.message.method).toBe("initialize");

    expect(rc.isConnected).toBe(true);
  });

  test("rejects when WS closes before challenge-response", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    rc.connect();
    await Bun.sleep(0);
    const ws = MockWebSocket._last!;
    ws.open();
    await Bun.sleep(0);
    ws.close_event(1006, "connection lost");
    await expect(rc.whenReady()).rejects.toThrow("WS closed before ready");
  });

  test("rejects when WS closes while waiting for initialize response", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    rc.connect();
    await Bun.sleep(0);
    const ws = MockWebSocket._last!;
    // No init interceptor — proof is sent but initialize never gets a response
    ws.open();
    await Bun.sleep(0);
    ws.message(makeChallenge());
    await Bun.sleep(0);
    ws.close_event(1000, "closed");
    await expect(rc.whenReady()).rejects.toThrow();
  });

  test("rejects when challenge.clientId mismatches enrollment.clientId", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    rc.connect();
    await Bun.sleep(0);
    const ws = MockWebSocket._last!;
    installInitInterceptor(ws);
    ws.open();
    await Bun.sleep(0);
    ws.message(makeChallenge("cli_WRONG"));
    await expect(rc.whenReady()).rejects.toThrow("clientId mismatch");
  });

  test("concurrent connect() calls open only ONE WebSocket", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    let wsCreated = 0;
    class CountingWs extends MockWebSocket {
      constructor(url: string, opts?: unknown) { super(url, opts); wsCreated++; }
    }
    globalThis.WebSocket = CountingWs as unknown as typeof WebSocket;

    const s1 = rc.connect();
    const s2 = rc.connect();
    expect(s1).toBe(s2);           // cùng một subscription
    await Bun.sleep(0);
    const ws = MockWebSocket._last!;
    installInitInterceptor(ws);
    ws.open();
    await Bun.sleep(0);
    ws.message(makeChallenge());
    await rc.whenReady();

    expect(wsCreated).toBe(1);
  });

  test("isConnected: false before connect, true after, false after disconnect", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    expect(rc.isConnected).toBe(false);
    await connectWithChallenge(rc);
    expect(rc.isConnected).toBe(true);
    rc.close();
    expect(rc.isConnected).toBe(false);
  });

  test("stream_id is fresh on reconnect", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws1 = await connectWithChallenge(rc);
    const sid1 = JSON.parse(ws1.sent[1]).stream_id;

    rc.close();
    await Bun.sleep(0);

    const ws2 = await connectWithChallenge(rc);
    const sid2 = JSON.parse(ws2.sent[1]).stream_id;

    expect(sid1).not.toBe(sid2);
  });
});

// ─── request() ───────────────────────────────────────────────────────────────

describe("WebsocketRelay — request()", () => {

  test("sends correct client_message envelope — no jsonrpc field", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const reqP = rc.request("thread/list", { workspaceRoot: "/foo" });
    await Bun.sleep(0);

    const msg = JSON.parse(ws.sent[sentBefore]);
    expect(msg.type).toBe("client_message");
    expect(msg.client_id).toBe(testEnrollment.clientId);
    expect(msg.env_id).toBe(TEST_ENV_ID);
    expect(typeof msg.seq_id).toBe("number");
    expect(typeof msg.stream_id).toBe("string");
    expect(msg.skip_history).toBe(false);

    expect(msg.message.jsonrpc).toBeUndefined();
    expect(typeof msg.message.id).toBe("string");
    expect(msg.message.method).toBe("thread/list");
    expect(msg.message.params).toEqual({ workspaceRoot: "/foo" });

    reqP.catch(() => {});
    rc.close();
  });

  test("all requests in a session share the same stream_id", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const p1 = rc.request("method-a");
    const p2 = rc.request("method-b");
    await Bun.sleep(0);

    const msgs = ws.sent.slice(sentBefore).map(s => JSON.parse(s));
    expect(msgs[0].stream_id).toBe(msgs[1].stream_id);

    p1.catch(() => {}); p2.catch(() => {});
    rc.close();
  });

  test("seq_id increments per request", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const p1 = rc.request("method-a");
    const p2 = rc.request("method-b");
    await Bun.sleep(0);

    const msgs = ws.sent.slice(sentBefore).map(s => JSON.parse(s));
    expect(msgs[0].seq_id).toBeLessThan(msgs[1].seq_id);

    p1.catch(() => {}); p2.catch(() => {});
    rc.close();
  });

  test("resolves with result when matching server_message arrives", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const reqP = rc.request("thread/list");
    await Bun.sleep(0);

    const rpcId = JSON.parse(ws.sent[sentBefore]).message.id;
    ws.message({ type: "server_message", message: { id: rpcId, result: { threads: ["t1"] } } });

    expect(await reqP).toEqual({ threads: ["t1"] });
  });

  test("rejects when server_message contains error", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const reqP = rc.request("thread/list");
    await Bun.sleep(0);

    const rpcId = JSON.parse(ws.sent[sentBefore]).message.id;
    ws.message({ type: "server_message", message: { id: rpcId, error: { code: -32601, message: "Method not found" } } });

    await expect(reqP).rejects.toThrow("Method not found");
  });

  test("ack messages do not resolve the request", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const reqP = rc.request("thread/list");
    await Bun.sleep(0);

    const sentMsg = JSON.parse(ws.sent[sentBefore]);
    ws.message({ type: "ack", seq_id: sentMsg.seq_id });
    await Bun.sleep(10);

    let resolved = false;
    reqP.then(() => { resolved = true; }).catch(() => {});
    await Bun.sleep(0);
    expect(resolved).toBe(false);

    rc.close();
  });

  test("server_message with unknown id is silently ignored", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);

    const reqP = rc.request("method-a");
    await Bun.sleep(0);

    ws.message({ type: "server_message", message: { id: "wrong-id", result: {} } });
    await Bun.sleep(10);

    let resolved = false;
    reqP.then(() => { resolved = true; }).catch(() => {});
    await Bun.sleep(0);
    expect(resolved).toBe(false);

    rc.close();
  });

  test("server notification (no id) is silently ignored", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);

    ws.message({ type: "server_message", message: { method: "remoteControl/status/changed", params: { status: "ready" } } });
    await Bun.sleep(0);

    expect(rc.isConnected).toBe(true);
    rc.close();
  });

  test("disconnect() rejects all pending requests immediately", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const errors: Error[] = [];
    const p1 = rc.request("method-a").catch((e: unknown) => errors.push(e as Error));
    const p2 = rc.request("method-b").catch((e: unknown) => errors.push(e as Error));

    await Bun.sleep(0);
    expect(ws.sent.length).toBe(sentBefore + 2);

    rc.close();
    await Promise.all([p1, p2]);

    expect(errors).toHaveLength(2);
    for (const e of errors) expect(e.message).toContain("WebsocketRelay disconnected");
  });

  test("WS close rejects all pending requests", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);

    const reqP = rc.request("thread/list");
    await Bun.sleep(0);

    ws.close_event(1001, "going away");

    await expect(reqP).rejects.toThrow("Remote control disconnected");
  });

  test("WS close during initialize rejects connect() without timeout delay", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    rc.connect();
    await Bun.sleep(0);
    const ws = MockWebSocket._last!;
    ws.open();
    await Bun.sleep(0);
    ws.message(makeChallenge());
    await Bun.sleep(0); // proof + initialize sent, waiting for response
    ws.close_event(1000, "server closed");
    // should reject quickly, not after 20s timeout
    await expect(rc.whenReady()).rejects.toThrow();
  });
});

// ─── auto-initialize ──────────────────────────────────────────────────────────

describe("WebsocketRelay — auto-initialize during connect()", () => {

  test("initialize is sent with correct params before connect() resolves", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);

    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    const initMsg = JSON.parse(ws.sent[1]);
    expect(initMsg.type).toBe("client_message");
    expect(initMsg.message.method).toBe("initialize");
    expect(initMsg.message.params.clientInfo.name).toBe("codex-proxy");
    expect(initMsg.message.params.capabilities.experimentalApi).toBe(true);
    expect(initMsg.message.jsonrpc).toBeUndefined();

    rc.close();
  });

  test("connect() rejects if initialize fails with error response", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    rc.connect();
    await Bun.sleep(0);
    const ws = MockWebSocket._last!;

    // Override to respond to initialize with an error
    const origSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      origSend(data);
      try {
        const msg = JSON.parse(data);
        if (msg.message?.method === "initialize") {
          Promise.resolve().then(() => ws.message({
            type: "server_message",
            message: { id: msg.message.id, error: { message: "not authorized" } },
          }));
        }
      } catch {}
    };

    ws.open();
    await Bun.sleep(0);
    ws.message(makeChallenge());

    await expect(rc.whenReady()).rejects.toThrow("not authorized");
  });
});

// ─── sendMessage() ────────────────────────────────────────────────────────────

describe("WebsocketRelay — sendMessage()", () => {

  test("uses thread/start when no threadId provided", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("hello");
    await Bun.sleep(0);

    const msg = JSON.parse(ws.sent[sentBefore]);
    expect(msg.message.method).toBe("thread/start");
    expect(msg.message.params.threadId).toBeNull();

    ws.message({ type: "server_message", message: { id: msg.message.id, result: { thread: { id: "t_new" } } } });
    await sendP;
  });

  test("uses thread/resume when threadId provided", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("follow up", { threadId: "t_existing" });
    await Bun.sleep(0);

    // Thread có sẵn → gửi thread/resume (LOAD) trước, rồi turn/start (SUBMIT).
    const msg = JSON.parse(ws.sent[sentBefore]);
    expect(msg.message.method).toBe("thread/resume");
    expect(msg.message.params.threadId).toBe("t_existing");
    ws.message({ type: "server_message", message: { id: msg.message.id, result: { thread: { id: "t_existing" } } } });
    await Bun.sleep(0);

    const turnMsg = JSON.parse(ws.sent[sentBefore + 1]);
    expect(turnMsg.message.method).toBe("turn/start");
    expect(turnMsg.message.params.threadId).toBe("t_existing");
    ws.message({ type: "server_message", message: { id: turnMsg.message.id, result: { thread: { id: "t_existing" } } } });
    await sendP;
  });

  test("passes text as input array", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("test message");
    await Bun.sleep(0);

    const params = JSON.parse(ws.sent[sentBefore]).message.params;
    expect(params.input).toEqual([{ type: "text", text: "test message", text_elements: [] }]);

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({ type: "server_message", message: { id: msg.message.id, result: {} } });
    await sendP;
  });

  test("uses on-request approvalPolicy by default", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("hi");
    await Bun.sleep(0);

    const params = JSON.parse(ws.sent[sentBefore]).message.params;
    expect(params.approvalPolicy).toBe("on-request");

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({ type: "server_message", message: { id: msg.message.id, result: {} } });
    await sendP;
  });

  test("passes custom options: workspaceRoot, model, approvalPolicy", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("task", {
      workspaceRoot: "/project",
      model: "gpt-4o",
      approvalPolicy: "never",
    });
    await Bun.sleep(0);

    const params = JSON.parse(ws.sent[sentBefore]).message.params;
    expect(params.cwd).toBe("/project");
    expect(params.model).toBe("gpt-4o");
    expect(params.approvalPolicy).toBe("never");

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({ type: "server_message", message: { id: msg.message.id, result: {} } });
    await sendP;
  });

  test("extracts threadId from result.thread.id", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("hi");
    await Bun.sleep(0);

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({
      type: "server_message",
      message: {
        id: msg.message.id,
        result: { thread: { id: "019e7013-abc", sessionId: "x" }, model: "gpt-5.5" },
      },
    });

    const { threadId, turnId } = await sendP;
    expect(threadId).toBe("019e7013-abc");
    expect(turnId).toBe(""); // thread/start response has no turn field
  });

  test("extracts threadId from result.threadId as fallback", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("hi");
    await Bun.sleep(0);

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({
      type: "server_message",
      message: { id: msg.message.id, result: { threadId: "t_flat", turnId: "turn_1" } },
    });

    const { threadId, turnId } = await sendP;
    expect(threadId).toBe("t_flat");
    expect(turnId).toBe("turn_1");
  });

  test("extracts turnId from result.turn.id when present", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("hi");
    await Bun.sleep(0);

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({
      type: "server_message",
      message: {
        id: msg.message.id,
        result: { thread: { id: "t_1" }, turn: { id: "turn_abc" } },
      },
    });

    const { threadId, turnId } = await sendP;
    expect(threadId).toBe("t_1");
    expect(turnId).toBe("turn_abc");
  });

  test("propagates errors from the host", async () => {
    const rc = new WebsocketRelay(mockAccount, testEnrollment, TEST_ENV_ID);
    const ws = await connectWithChallenge(rc);
    const sentBefore = ws.sent.length;

    const sendP = rc.sendMessage("hi");
    await Bun.sleep(0);

    const msg = JSON.parse(ws.sent[sentBefore]);
    ws.message({
      type: "server_message",
      message: { id: msg.message.id, error: { message: "quota exceeded" } },
    });

    await expect(sendP).rejects.toThrow("quota exceeded");
  });
});

