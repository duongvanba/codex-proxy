import { test, expect, describe, beforeEach } from "bun:test";
import { AccountService } from "./account-service";
import type { Account } from "../schemas";

// ─── Fixtures + mock builders ───────────────────────────────────────────────────

function mkAccount(over: Partial<Account> = {}): Account {
  return {
    id: "a1",
    email: "a1@example.com",
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
    idToken: "secret-id",
    accountId: "acc_a1",
    addedAt: 1,
    status: "active",
    requestCount: 0,
    ...over,
  } as Account;
}

type Published = { ref: string; type: string; data: Record<string, unknown> };

function build(opts: {
  accounts?: Account[];
  activeAccount?: Account | null;
  selectResult?: { ok: boolean; error?: string };
  enrollStatus?: "none" | "enrolling" | "ready";
  autoRefreshCount?: number;
} = {}) {
  let accountsList = opts.accounts ?? [mkAccount()];
  const hasActive = "activeAccount" in opts;
  const calls = {
    refreshCodexUsageForAccounts: 0,
    setSelectedAccount: [] as string[],
    clearBlockedState: [] as string[],
    getActiveAccount: 0,
    autoRefreshExpiringTokens: 0,
  };
  let enrollCb: (() => void) | null = null;
  const published: Published[] = [];

  const accounts = {
    getAccounts: () => accountsList,
    refreshCodexUsageForAccounts: async () => { calls.refreshCodexUsageForAccounts++; },
    setSelectedAccount: (id: string) => { calls.setSelectedAccount.push(id); return opts.selectResult ?? { ok: true }; },
    clearBlockedState: (id: string) => { calls.clearBlockedState.push(id); },
    getActiveAccount: () => { calls.getActiveAccount++; return hasActive ? (opts.activeAccount ?? null) : (accountsList[0] ?? null); },
    autoRefreshExpiringTokens: async () => { calls.autoRefreshExpiringTokens++; return opts.autoRefreshCount ?? 0; },
  };
  const enrollment = {
    onChange: (cb: () => void) => { enrollCb = cb; },
    getEnrollStatus: async () => opts.enrollStatus ?? "none",
  };
  const gateway = { next: (x: Published) => { published.push(x); } };

  const svc = new AccountService(accounts as any, enrollment as any, gateway as any);
  return { svc, calls, published, triggerEnroll: () => enrollCb?.(), setAccounts: (next: Account[]) => { accountsList = next; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AccountService", () => {
  describe("list", () => {
    test("strips tokens và đính kèm enroll status", async () => {
      const { svc } = build({ accounts: [mkAccount({ id: "x1", email: "x@e.com" })], enrollStatus: "ready" });
      const docs = await svc.list();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ id: "x1", email: "x@e.com", enrollStatus: "ready", enrolled: true });
      expect((docs[0] as any).accessToken).toBeUndefined();
      expect((docs[0] as any).refreshToken).toBeUndefined();
      expect((docs[0] as any).idToken).toBeUndefined();
    });
  });

  describe("fetchQuota", () => {
    test("force refresh quota rồi tự publish snapshot", async () => {
      const { svc, calls, published } = build();
      await svc.fetchQuota();
      await flush();
      expect(calls.refreshCodexUsageForAccounts).toBe(1);
      expect(published.some((p) => p.ref === "accounts")).toBe(true);
    });

    test("auto reload quota chạy nền và publish snapshot", async () => {
      const { svc, calls, published } = build();
      const scheduler = svc.startQuotaAutoReload(10_000);
      await flush();
      scheduler.stop();
      expect(calls.refreshCodexUsageForAccounts).toBe(1);
      expect(published.some((p) => p.ref === "accounts")).toBe(true);
    });
  });

  describe("switch", () => {
    test("select + clear cờ chặn + publish khi thành công", async () => {
      const { svc, calls, published } = build();
      const r = svc.switch("a1");
      await flush();
      expect(r.ok).toBe(true);
      expect(calls.setSelectedAccount).toEqual(["a1"]);
      expect(calls.clearBlockedState).toEqual(["a1"]);
      expect(published.some((p) => p.ref === "accounts")).toBe(true);
    });

    test("select fail → KHÔNG clear, KHÔNG publish, trả lỗi", async () => {
      const { svc, calls, published } = build({ selectResult: { ok: false, error: "nope" } });
      const r = svc.switch("ghost");
      await flush();
      expect(r).toEqual({ ok: false, error: "nope" });
      expect(calls.clearBlockedState).toEqual([]);
      expect(published).toEqual([]);
    });
  });

  describe("pickForProxy", () => {
    test("delegate getActiveAccount", () => {
      const target = mkAccount({ id: "active1" });
      const { svc, calls } = build({ activeAccount: target });
      expect(svc.pickForProxy()).toBe(target);
      expect(calls.getActiveAccount).toBe(1);
    });

    test("trả null khi không có account usable", () => {
      const { svc } = build({ activeAccount: null });
      expect(svc.pickForProxy()).toBeNull();
    });
  });

  describe("realtime sync", () => {
    test("id mới = added, lần sau = modified", async () => {
      // Constructor seed knownAccountIds = ["a1"]; sau đó thêm a2 → a2 phải là "added".
      const { svc, published, setAccounts } = build({ accounts: [mkAccount({ id: "a1" })] });
      setAccounts([mkAccount({ id: "a1" }), mkAccount({ id: "a2" })]);
      await (svc as any).publishSnapshot();
      const byId = Object.fromEntries(published.map((p) => [(p.data as any).id, p.type]));
      expect(byId.a1).toBe("modified"); // đã biết từ constructor
      expect(byId.a2).toBe("added");    // mới

      published.length = 0;
      await (svc as any).publishSnapshot();
      const byId2 = Object.fromEntries(published.map((p) => [(p.data as any).id, p.type]));
      expect(byId2.a2).toBe("modified"); // giờ đã biết
    });

    test("publishRemoved phát removed và quên id (thêm lại = added)", async () => {
      const { svc, published } = build({ accounts: [mkAccount({ id: "a1" })] });
      svc.publishRemoved("a1");
      expect(published).toEqual([{ ref: "accounts", type: "removed", data: { id: "a1" } }]);

      published.length = 0;
      await (svc as any).publishSnapshot();
      expect((published[0] as any).type).toBe("added"); // a1 bị quên → tính là added
    });

    test("enrollment.onChange → tự đồng bộ snapshot", async () => {
      const { published, triggerEnroll } = build();
      published.length = 0;
      triggerEnroll();
      await flush();
      expect(published.some((p) => p.ref === "accounts")).toBe(true);
    });
  });

  describe("startTokenAutoRefresh", () => {
    test("refresh >0 → publish snapshot realtime, rồi stop()", async () => {
      const { svc, calls, published } = build({ autoRefreshCount: 2 });
      published.length = 0;
      const handle = svc.startTokenAutoRefresh(1_000_000);
      await flush();
      handle.stop();
      expect(calls.autoRefreshExpiringTokens).toBeGreaterThanOrEqual(1);
      expect(published.some((p) => p.ref === "accounts")).toBe(true);
    });

    test("refresh =0 → KHÔNG publish gì", async () => {
      const { svc, calls, published } = build({ autoRefreshCount: 0 });
      published.length = 0;
      const handle = svc.startTokenAutoRefresh(1_000_000);
      await flush();
      handle.stop();
      expect(calls.autoRefreshExpiringTokens).toBeGreaterThanOrEqual(1);
      expect(published).toEqual([]);
    });
  });
});
