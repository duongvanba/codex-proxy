import { describe, expect, test } from "bun:test";
import {
  collectionResponse,
  getLivequeryHealth,
  serializeAccount,
} from "../src/livequery";
import { nextDailyRoutineRunAt } from "../src/daily-routine";
import type { Account } from "../src/types";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct-1",
    email: "user@example.com",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
    accountId: "chatgpt-account",
    addedAt: 1,
    status: "active",
    requestCount: 0,
    dailyUsage: { key: "2026-05-24", count: 0, limit: 100 },
    weeklyUsage: { key: "2026-05-18", count: 0, limit: 500 },
    codexUsage: {
      fetchedAt: 2,
      allowed: true,
      limitReached: false,
      primaryWindow: {
        usedPercent: 12,
        limitWindowSeconds: 18000,
        resetAfterSeconds: 1200,
        resetAt: 3,
      },
      secondaryWindow: {
        usedPercent: 34,
        limitWindowSeconds: 604800,
        resetAfterSeconds: 3400,
        resetAt: 4,
      },
    },
    ...overrides,
  };
}

describe("LiveQuery helpers", () => {
  test("serializeAccount removes tokens", () => {
    const safe = serializeAccount(account());

    expect("accessToken" in safe).toBe(false);
    expect("refreshToken" in safe).toBe(false);
    expect("idToken" in safe).toBe(false);
    expect(safe.email).toBe("user@example.com");
  });

  test("serializeAccount marks quota timers as pending when requested", () => {
    const safe = serializeAccount(account(), { pendingQuotaTimers: true });

    expect(safe.codexUsage?.primaryWindow?.resetAfterSeconds).toBe(-1);
    expect(safe.codexUsage?.secondaryWindow?.resetAfterSeconds).toBe(-1);
  });

  test("collectionResponse builds a LiveQuery collection envelope", () => {
    const response = collectionResponse([{ id: "a" }, { id: "b" }], { collection: "test" });

    expect(response.items).toHaveLength(2);
    expect(response.count.total).toBe(2);
    expect(response.cursor.first).toBe("a");
    expect(response.cursor.last).toBe("b");
    expect(response.summary?.collection).toBe("test");
  });

  test("health payload exposes server status without tokens", () => {
    const health = getLivequeryHealth("http://localhost:17000/v1");

    expect(health.ok).toBe(true);
    expect(health.openaiBaseUrl).toBe("http://localhost:17000/v1");
    expect(typeof health.accountCount).toBe("number");
    expect("accessToken" in health).toBe(false);
  });

  test("daily routine scheduler chooses the next 7am Ho Chi Minh run", () => {
    const before = new Date("2026-05-23T23:30:00.000Z"); // 06:30 in Ho Chi Minh
    const after = new Date("2026-05-24T01:00:00.000Z");  // 08:00 in Ho Chi Minh

    expect(nextDailyRoutineRunAt(before, "Asia/Ho_Chi_Minh", 7, 0).toISOString()).toBe("2026-05-24T00:00:00.000Z");
    expect(nextDailyRoutineRunAt(after, "Asia/Ho_Chi_Minh", 7, 0).toISOString()).toBe("2026-05-25T00:00:00.000Z");
  });
});
