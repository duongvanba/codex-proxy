import type { AccountsService } from "../../services/accounts";
import type { Account } from "../../schemas";

const DEFAULT_TIME_ZONE = process.env.DAILY_ROUTINE_TIME_ZONE ?? "Asia/Ho_Chi_Minh";
const DEFAULT_HOUR = readNumber("DAILY_ROUTINE_HOUR", 7);
const DEFAULT_MINUTE = readNumber("DAILY_ROUTINE_MINUTE", 0);
const DEFAULT_CONCURRENCY = readNumber("DAILY_ROUTINE_CONCURRENCY", 2);
const DEFAULT_TIMEOUT_MS = readNumber("DAILY_ROUTINE_TIMEOUT_MS", 15_000);
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export type DailyRoutineAccountResult = {
  accountId: string;
  email: string;
  status: Account["status"];
  ok: boolean;
  skipped: boolean;
  httpStatus?: number;
  latencyMs?: number;
  error?: string;
};

export type DailyRoutineResult = {
  id: string;
  startedAt: number;
  finishedAt: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: DailyRoutineAccountResult[];
};

type ReportFn = (entry: Record<string, unknown>) => void;

function readNumber(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class DailyRoutineService {
  constructor(private readonly accounts: AccountsService) {}

  private codexHeadersForAccount(account: Account): Headers {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${account.accessToken}`);
    headers.set("ChatGPT-Account-Id", account.accountId);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("Origin", "https://chatgpt.com");
    headers.set("Referer", "https://chatgpt.com/");
    headers.set("Originator", "codex_cli_rs");
    headers.set("Version", "0.133.0");
    headers.set("User-Agent", "codex_cli_rs/0.133.0 (Mac OS; arm64)");
    headers.set("Accept", "text/event-stream");
    headers.set("Content-Type", "application/json");
    headers.set("Accept-Encoding", "identity");
    headers.set("X-Oai-Web-Search-Eligible", "true");
    return headers;
  }

  private warmUpBody(account: Account) {
    return JSON.stringify({
      model: "gpt-5.5",
      store: false,
      stream: true,
      instructions: "Reply with OK only.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Daily routine warm-up for ${account.email}. Reply OK only.`,
            },
          ],
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      text: { verbosity: "low" },
    });
  }

  private isLimitErrorText(text: string): boolean {
    return /rate[_-]?limit|limit[_-]?reached|usage[_-]?limit|quota|insufficient_quota/i.test(text);
  }

  private async warmUpAccount(account: Account): Promise<DailyRoutineAccountResult> {
    const startedAt = Date.now();

    if (!account.accessToken || !account.accountId) {
      return {
        accountId: account.id,
        email: account.email,
        status: account.status,
        ok: false,
        skipped: true,
        error: "Missing token or ChatGPT account id",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers: this.codexHeadersForAccount(account),
        body: this.warmUpBody(account),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      const text = await res.text();
      const latencyMs = Date.now() - startedAt;

      if (res.status === 401) {
        this.accounts.markExpired(account.id);
        return {
          accountId: account.id,
          email: account.email,
          status: account.status,
          ok: false,
          skipped: false,
          httpStatus: res.status,
          latencyMs,
          error: "Token expired or unauthorized",
        };
      }

      if (res.status === 429 || this.isLimitErrorText(text)) {
        const retryAfterMs = parseInt(res.headers.get("retry-after") ?? "60") * 1000;
        this.accounts.markRateLimited(account.id, retryAfterMs);
        return {
          accountId: account.id,
          email: account.email,
          status: account.status,
          ok: false,
          skipped: false,
          httpStatus: res.status,
          latencyMs,
          error: "Rate limited or usage limit reached",
        };
      }

      if (!res.ok) {
        return {
          accountId: account.id,
          email: account.email,
          status: account.status,
          ok: false,
          skipped: false,
          httpStatus: res.status,
          latencyMs,
          error: text.slice(0, 240) || `HTTP ${res.status}`,
        };
      }

      const completed = /event:\s*response\.completed|"type"\s*:\s*"response\.completed"/i.test(text);
      return {
        accountId: account.id,
        email: account.email,
        status: account.status,
        ok: completed,
        skipped: false,
        httpStatus: res.status,
        latencyMs,
        error: completed ? undefined : "Warm-up stream did not complete",
      };
    } catch (error) {
      clearTimeout(timeout);
      return {
        accountId: account.id,
        email: account.email,
        status: account.status,
        ok: false,
        skipped: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runDailyRoutineForEveryAccount(onReport?: ReportFn): Promise<DailyRoutineResult> {
    const startedAt = Date.now();
    const id = `${startedAt}-${crypto.randomUUID()}`;
    const accounts = this.accounts.getAccounts();
    const results: DailyRoutineAccountResult[] = [];

    onReport?.({
      type: "daily_routine_started",
      routineId: id,
      total: accounts.length,
      timestamp: startedAt,
    });

    for (let i = 0; i < accounts.length; i += DEFAULT_CONCURRENCY) {
      const batch = accounts.slice(i, i + DEFAULT_CONCURRENCY);
      const batchResults = await Promise.all(batch.map((a) => this.warmUpAccount(a)));
      results.push(...batchResults);
      for (const result of batchResults) {
        onReport?.({
          type: "daily_routine_account",
          routineId: id,
          ...result,
          timestamp: Date.now(),
        });
      }
    }

    const finishedAt = Date.now();
    const summary: DailyRoutineResult = {
      id,
      startedAt,
      finishedAt,
      total: accounts.length,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok && !result.skipped).length,
      skipped: results.filter((result) => result.skipped).length,
      results,
    };

    onReport?.({
      type: "daily_routine_completed",
      routineId: id,
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      skipped: summary.skipped,
      durationMs: finishedAt - startedAt,
      timestamp: finishedAt,
    });

    return summary;
  }

  private timeZoneParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
    };
  }

  private zonedTimeToUtcMs(
    timeZone: string,
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number
  ) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const actual = this.timeZoneParts(new Date(utcGuess), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    return utcGuess - (actualAsUtc - utcGuess);
  }

  nextDailyRoutineRunAt(
    now = new Date(),
    timeZone = DEFAULT_TIME_ZONE,
    hour = DEFAULT_HOUR,
    minute = DEFAULT_MINUTE
  ): Date {
    const parts = this.timeZoneParts(now, timeZone);
    let target = this.zonedTimeToUtcMs(timeZone, parts.year, parts.month, parts.day, hour, minute);
    if (target <= now.getTime()) {
      const tomorrowUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, hour, minute, 0));
      const tomorrow = this.timeZoneParts(tomorrowUtc, timeZone);
      target = this.zonedTimeToUtcMs(timeZone, tomorrow.year, tomorrow.month, tomorrow.day, hour, minute);
    }
    return new Date(target);
  }

  startDailyRoutineScheduler(onReport?: ReportFn) {
    if (process.env.DAILY_ROUTINE_DISABLED === "1") {
      console.log("[daily-routine] Scheduler disabled by DAILY_ROUTINE_DISABLED=1");
      return { stop() {} };
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const scheduleNext = () => {
      if (stopped) return;
      const next = this.nextDailyRoutineRunAt();
      const delay = Math.max(1_000, next.getTime() - Date.now());
      console.log(`[daily-routine] Next run at ${next.toISOString()} (${DEFAULT_TIME_ZONE})`);
      timer = setTimeout(async () => {
        try {
          await this.runDailyRoutineForEveryAccount(onReport);
        } catch (error) {
          onReport?.({
            type: "daily_routine_error",
            error: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          });
        } finally {
          scheduleNext();
        }
      }, delay);
    };

    scheduleNext();

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }
}
