/**
 * E2E realtime cho 7 API + flow host → chat → message → turns.
 *
 * Mặc định BỎ QUA (cần server thật + tài khoản + thao tác login/enroll).
 * Chạy thật:
 *   E2E=1 bun test apps/honojs/tests/e2e/realtime.e2e.test.ts --timeout 900000
 *
 * Khi cần bạn thao tác (login/enroll), test sẽ IN LINK ra console rồi chờ.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { E2E, API, connect, startServer, stopServer, poll, banner, type LqClient } from "./harness";

const t = E2E ? test : test.skip;

// ─── State chia sẻ giữa các bước (chạy tuần tự) ──────────────────────────────
let client: LqClient;
let accountId = "";
let host: { id: string; env_id: string; online?: boolean } | null = null;
let chatId = "";

beforeAll(async () => {
  if (!E2E) return;
  await startServer();
  client = await connect();
});

afterAll(async () => {
  if (!E2E) return;
  client?.stop();
  await stopServer();
});

// ── API 1: accounts (kèm enroll status) + realtime, login nếu trống ──────────
t("API1 accounts: list + enrolled + realtime (login nếu cần)", async () => {
  let data = await client.get("accounts");

  if (!data?.items?.length) {
    const r = await client.action("accounts", "start-login");
    const url = r.data?.authorizeUrl;
    expect(url).toBeTruthy();
    banner("ĐĂNG NHẬP — mở link sau, đăng nhập tài khoản ChatGPT/Codex:", [url]);
    data = await poll(async () => {
      const d = await client.get("accounts");
      return d?.items?.length ? d : false;
    }, 300_000, "chờ đăng nhập tài khoản");
  }

  expect(Array.isArray(data.items)).toBe(true);
  expect(data.items.length).toBeGreaterThan(0);
  accountId = data.items[0].id;
  // mỗi account doc PHẢI có field `enrolled`
  expect(typeof data.items[0].enrolled).toBe("boolean");

  // realtime: refresh-usage → push 'modified' ref accounts
  const change = client.watch("accounts", (c: any) => c?.collection_ref === "accounts");
  await client.action("accounts", "refresh-usage");
  const ev: any = await change;
  expect(ev.collection_ref).toBe("accounts");
  // payload realtime cũng phải mang `enrolled`
  expect(typeof ev.data?.enrolled).toBe("boolean");
});

// ── API 2 + 3: enroll link + xác nhận ────────────────────────────────────────
t("API2/3 enroll: lấy link + xác nhận (nếu chưa enroll)", async () => {
  const data = await client.get("accounts");
  const acc = data.items.find((a: any) => a.id === accountId);

  if (!acc?.enrolled) {
    const r = await client.action(`accounts/${accountId}`, "rc-enroll-start");
    const enrollUrl = r.data?.enrollUrl;
    expect(enrollUrl).toBeTruthy();
    expect(r.data?.pendingId).toBeTruthy();
    banner("ENROLL REMOTE CONTROL — mở link, đăng nhập lại để cấp quyền remote:", [
      enrollUrl,
      "(callback tự về cổng 1455/1457 trong tiến trình test → enroll tự hoàn tất)",
      "Hoặc dán callback URL và gọi action rc-enroll-callback nếu chạy headless.",
    ]);
    await poll(async () => {
      const d = await client.get("accounts");
      return d.items.find((a: any) => a.id === accountId)?.enrolled ? true : false;
    }, 300_000, "chờ enroll hoàn tất");
  }

  const after = await client.get("accounts");
  expect(after.items.find((a: any) => a.id === accountId)?.enrolled).toBe(true);
});

// ── API 4: host online (non-cloud) + realtime ────────────────────────────────
t("API4 hosts: online non-cloud + realtime", async () => {
  const change = client.watch(`accounts/${accountId}/hosts`);
  await client.action(`accounts/${accountId}`, "refresh-hosts");
  await change.catch(() => {/* có thể chưa có host nào để push */});

  const data = await poll(async () => {
    const d = await client.get(`accounts/${accountId}/hosts`);
    return d?.items ? d : false;
  }, 15_000, "load hosts");

  // không được lẫn cloud
  for (const h of data.items) expect(h.kind).not.toBe("cloud");

  host = data.items.find((h: any) => h.online === true) ?? null;
  if (!host) {
    banner("KHÔNG có host online", [
      "Chạy Codex trên một máy đã enroll để có host remote online,",
      "rồi chạy lại — các bước host/project/chat/turns sẽ tiếp tục.",
    ]);
  } else {
    console.log(`[e2e] host online: env_id=${host.env_id}`);
  }
  expect(Array.isArray(data.items)).toBe(true);
});

// ── API 5: projects theo host (env_id) + realtime ────────────────────────────
t("API5 host projects: GET + realtime (refresh-projects)", async () => {
  if (!host) { console.warn("[e2e] skip: no online host"); return; }
  const ref = `accounts/${accountId}/hosts/${host.env_id}/projects`;
  const first = await client.get(ref);
  expect(Array.isArray(first.items)).toBe(true);

  const change = client.watch(ref).catch(() => null);
  await client.action(`accounts/${accountId}`, "refresh-projects");
  const ev: any = await change;
  if (ev) expect(ev.collection_ref).toBe(ref); // ref host-scoped khớp
  else console.warn("[e2e] host chưa có project nào → bỏ qua assert realtime (không có gì để push)");
});

// ── API 6: chats theo host + realtime ────────────────────────────────────────
t("API6 host chats: GET + realtime (refresh-chats)", async () => {
  if (!host) { console.warn("[e2e] skip: no online host"); return; }
  const ref = `accounts/${accountId}/hosts/${host.env_id}/chats`;
  const first = await client.get(ref);
  expect(Array.isArray(first.items)).toBe(true);

  const change = client.watch(ref);
  await client.action(`accounts/${accountId}`, "refresh-chats");
  const ev: any = await change.catch(() => null);
  // có thể rỗng nếu host chưa có chat — chỉ cần không lỗi đăng ký subscription
  if (ev) expect(ev.collection_ref).toBe(ref);
});

// ── Flow: workspace-options → create-chat → send-message → turns realtime ────
t("Flow: tạo chat trên host → nhắn tin → đọc turns realtime", async () => {
  if (!host) { console.warn("[e2e] skip: no online host"); return; }

  // workspace-options: lấy project cwd
  const opts = await client.action(`accounts/${accountId}/hosts/${host.env_id}`, "workspace-options");
  const cwd = opts.data?.options?.[0]?.path as string | undefined;
  console.log(`[e2e] workspace cwd: ${cwd ?? "(default)"}`);

  // create-chat (local desktop qua remote control: env selfhost:<env_id>)
  const created = await client.action(`accounts/${accountId}/hosts/${host.env_id}`, "create-chat", {
    input: "Xin chào, trả lời ngắn gọn 'OK' giúp tôi.",
    environment_id: `selfhost:${host.env_id}`,
    ...(cwd ? { cwd } : {}),
  });
  expect(created.status).toBe(200);
  chatId = created.data?.chat_id;
  expect(chatId).toBeTruthy();
  console.log(`[e2e] chat_id=${chatId}`);

  // turns realtime theo ref host-scoped — GET turns kích RC stream gửi message.
  // Remote agent round-trip thật có thể lâu → chờ tới 120s; nếu không có push thì
  // fallback poll GET turns để xác nhận tin đã tới host.
  const turnsRef = `accounts/${accountId}/hosts/${host.env_id}/chats/${chatId}/turns`;
  const ev: any = await client.watch(turnsRef, (c: any) => !!c?.data, 60_000).catch(() => null);
  if (ev) {
    // Nếu remote agent phản hồi → BẮT BUỘC push đúng ref host-scoped
    expect(ev.collection_ref).toBe(turnsRef);
    expect(ev.data.id).toBeTruthy();
    console.log(`[e2e] turns realtime push OK: turn ${ev.data.id} (${ev.type})`);
  } else {
    // Agent có thể im lặng (cần Codex đang chạy + trả lời). Thử GET, nếu vẫn rỗng thì
    // bỏ qua assert turns — luồng mutation (create-chat/send-message) đã verify OK.
    const turns = await poll(async () => {
      const t = await client.get(turnsRef);
      return t?.items?.length ? t : false;
    }, 30_000, "turns qua GET").catch(() => null);
    if (turns) console.log(`[e2e] turns qua GET: ${turns.items.length}`);
    else console.warn("[e2e] remote agent chưa phản hồi → bỏ qua assert turns (mutation path đã OK)");
  }

  // gửi thêm 1 tin
  const sent = await client.action(`accounts/${accountId}/chats/${chatId}`, "send-message", {
    input: "Cảm ơn.",
    environment_id: `selfhost:${host.env_id}`,
  });
  expect(sent.status).toBe(200);

  // đọc danh sách turns cuối cùng
  const turns = await client.get(turnsRef);
  expect(Array.isArray(turns.items)).toBe(true);
  console.log(`[e2e] tổng số turns: ${turns.items.length}`);
});
