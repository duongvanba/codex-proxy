import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { decodeTokenInfo } from "../src/server/libs/chatgpt";
import { getAccounts, refreshCodexUsageForAccounts } from "../src/server/accounts";

const ACCOUNTS_PATH = join(import.meta.dir, "..", "accounts.json");

describe("Integration: stored account validity", () => {
  test.skipIf(!existsSync(ACCOUNTS_PATH))("checks stored accounts without printing tokens", async () => {
    await refreshCodexUsageForAccounts(true);

    const accounts = getAccounts();
    const summary = accounts.map((account) => {
      const token = decodeTokenInfo(account.accessToken);
      return {
        email: account.email,
        status: account.status,
        accessTokenExpiresAt: token.expiresAt,
        accessTokenExpired: token.isExpired,
        quotaAllowed: account.codexUsage?.allowed ?? false,
        quotaLimitReached: account.codexUsage?.limitReached ?? false,
        quotaError: account.codexUsage?.error ?? "",
        usable:
          account.status === "active" &&
          token.isExpired === false &&
          account.codexUsage?.allowed === true &&
          account.codexUsage?.limitReached !== true,
      };
    });

    console.table(summary);

    expect(accounts.length).toBeGreaterThan(0);
    expect(summary.some((row) => row.usable)).toBe(true);
  }, 30_000);
});
