/**
 * E2E harness cho LiveQuery realtime — tự spawn server honojs, kết nối WebSocket
 * client (@livequery/rest), và cung cấp helper GET/action/listen + waitFor.
 *
 * Chạy: E2E=1 bun test apps/honojs/tests/e2e --timeout 900000
 */
import { Socket } from "@livequery/rest/Socket";
import { firstValueFrom, filter, take, timeout as rxTimeout } from "rxjs";
import { join } from "path";

export const E2E = process.env.E2E === "1";

const PORT = Number(process.env.E2E_PORT ?? 18790);
const WS_PORT = Number(process.env.E2E_WS_PORT ?? 18791);
const HOST = "127.0.0.1";

export const API = `http://${HOST}:${PORT}/livequery`;
export const WS = `ws://${HOST}:${WS_PORT}/livequery/realtime-updates`;
const HEALTH = `http://${HOST}:${PORT}/health`;
const HONO_DIR = join(import.meta.dir, "..", "..");

// ─── Server lifecycle ───────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

export async function startServer(): Promise<void> {
  proc = Bun.spawn(["bun", "index.ts"], {
    cwd: HONO_DIR,
    env: {
      ...process.env,
      PROXY_PORT: String(PORT),
      LIVEQUERY_WS_PORT: String(WS_PORT),
      PROXY_HOST: HOST,
      PUBLIC_BASE_URL: `http://${HOST}:${PORT}`,
      DAILY_ROUTINE_DISABLED: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await poll(async () => {
    try { return (await fetch(HEALTH)).ok; } catch { return false; }
  }, 30_000, "server health");
}

export async function stopServer(): Promise<void> {
  try { proc?.kill(); } catch {}
  proc = null;
}

// ─── WebSocket client ───────────────────────────────────────────────────────

export type LqClient = {
  socket: Socket;
  gid: string;
  get(ref: string): Promise<any>;
  action(ref: string, name: string, payload?: Record<string, unknown>): Promise<{ status: number; data?: any; error?: any }>;
  /** Đăng ký subscription cho `ref` (GET kèm header bind) rồi trả về một promise chờ change kế tiếp. */
  watch(ref: string, predicate?: (c: any) => boolean, timeoutMs?: number): Promise<any>;
  stop(): void;
};

export async function connect(): Promise<LqClient> {
  const socket = new Socket(WS);
  const gid = await Promise.race([
    firstValueFrom(socket.$gateway),
    rejectAfter(5_000, "WS gateway 'hello'"),
  ]) as string;

  const headers = () => ({ "x-lcid": socket.client_id, "x-lgid": gid });

  const get = async (ref: string) => {
    const res = await fetch(`${API}/${ref}`, { headers: headers() });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GET ${ref} → ${res.status} ${JSON.stringify(body)}`);
    return body?.data;
  };

  const action = async (ref: string, name: string, payload: Record<string, unknown> = {}) => {
    const res = await fetch(`${API}/${ref}/~${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, data: body?.data, error: body?.error };
  };

  const watch = async (ref: string, predicate: (c: any) => boolean = () => true, timeoutMs = 20_000) => {
    await get(ref); // GET để middleware đăng ký subscription cho ref
    return firstValueFrom(
      socket.listen(ref).pipe(filter(predicate), take(1), rxTimeout({ first: timeoutMs }))
    );
  };

  return { socket, gid, get, action, watch, stop: () => socket.stop() };
}

// ─── Tiện ích ────────────────────────────────────────────────────────────────

export async function poll<T>(
  fn: () => Promise<T | false | undefined | null>,
  timeoutMs: number,
  label: string,
  intervalMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (e) { last = e; }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`poll timeout (${timeoutMs}ms): ${label}${last ? ` — last=${String(last)}` : ""}`);
}

function rejectAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms));
}

/** In một banner nổi bật để bạn thấy link cần bấm khi test chờ thao tác thủ công. */
export function banner(title: string, lines: string[]): void {
  const bar = "═".repeat(64);
  console.log(`\n╔${bar}╗`);
  console.log(`  👉 ${title}`);
  for (const l of lines) console.log(`     ${l}`);
  console.log(`╚${bar}╝\n`);
}
