/**
 * SSE stream manager for /backend-api/codex/responses.
 * One SSE connection per active chat, multicast to all LiveQuery subscribers via RxJS share().
 */

import { Observable, share, finalize } from "rxjs";
import { buildCodexHttpHeaders, CHATGPT_BASE, CODEX_RESPONSES_PATH } from "../libs/chatgpt";
import type { Account } from "../schemas";
import type { SseDelta, SseTextDone, SseCompleted, SseError, SseEvent, SseRequestParams } from "../schemas/sse";
export type { SseDelta, SseTextDone, SseCompleted, SseError, SseEvent, SseRequestParams };

// ─── Active stream registry ───────────────────────────────────────────────────

const activeStreams = new Map<string, Observable<SseEvent>>();

export function getActiveStream(key: string): Observable<SseEvent> | undefined {
  return activeStreams.get(key);
}

export function clearActiveStream(key: string) {
  activeStreams.delete(key);
}

// ─── Request body builder ─────────────────────────────────────────────────────

function buildRequestBody(params: SseRequestParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model ?? "gpt-5.5",
    instructions: params.instructions ?? "",
    input: params.input,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    reasoning: { effort: "medium" },
    store: true,
    stream: true,
    include: [],
  };
  if (params.previousResponseId) body.previous_response_id = params.previousResponseId;
  if (params.environmentId) body.environment_id = params.environmentId;
  return body;
}

// ─── SSE parser ───────────────────────────────────────────────────────────────

function parseSseBlock(block: string): { eventType: string; data: unknown } | null {
  const lines = block.split(/\r?\n/);
  let eventType = "";
  let dataStr = "";
  for (const line of lines) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
  }
  if (!dataStr || dataStr === "[DONE]") return null;
  try {
    return { eventType, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

// ─── Observable factory ───────────────────────────────────────────────────────

export function createOrGetSseStream(
  account: Account,
  chatId: string,
  params: SseRequestParams
): Observable<SseEvent> {
  const key = `${account.id}:${chatId}`;
  const existing = activeStreams.get(key);
  if (existing) return existing;

  const stream$ = new Observable<SseEvent>((subscriber) => {
    const controller = new AbortController();
    let accumulated = "";
    let turnId = `turn-${Date.now()}`;
    let responseId: string | undefined;

    const requestBody = buildRequestBody(params);

    (async () => {
      try {
        const res = await fetch(`${CHATGPT_BASE}${CODEX_RESPONSES_PATH}`, {
          method: "POST",
          headers: buildCodexHttpHeaders(account, "text/event-stream"),
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          subscriber.error(new Error(`Upstream ${res.status}: ${errText.slice(0, 200)}`));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\n\n/);
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            if (!block.trim()) continue;
            const parsed = parseSseBlock(block);
            if (!parsed) continue;

            const { eventType, data } = parsed as { eventType: string; data: Record<string, unknown> };
            const type = String((data as any).type ?? eventType);

            // Extract response id and turn id from metadata
            if ((data as any).response?.id) responseId = String((data as any).response.id);
            if ((data as any).id) responseId = String((data as any).id);
            if ((data as any).turn_id) turnId = String((data as any).turn_id);

            if (type === "response.output_text.delta") {
              const delta = String((data as any).delta ?? "");
              accumulated += delta;
              subscriber.next({ type: "delta", chatId, turnId, delta, accumulated });
            } else if (type === "response.output_text.done") {
              const text = String((data as any).text ?? accumulated);
              accumulated = text;
              subscriber.next({ type: "text_done", chatId, turnId, text });
            } else if (
              type === "response.completed" ||
              type === "codex/event/task_complete" ||
              type === "codex/event/item_completed"
            ) {
              const outputItems: unknown[] = (data as any).response?.output ?? (data as any).output_items ?? [];
              subscriber.next({ type: "completed", chatId, turnId, responseId, outputItems, text: accumulated });
              subscriber.complete();
              return;
            } else if (type === "response.failed" || type === "error" || type === "codex/event/error") {
              const msg = (data as any).error?.message ?? (data as any).message ?? "Stream failed";
              subscriber.next({ type: "error", chatId, message: String(msg) });
              subscriber.error(new Error(String(msg)));
              return;
            }
          }
        }

        // Stream ended without explicit completed event
        if (accumulated) {
          subscriber.next({ type: "completed", chatId, turnId, responseId, outputItems: [], text: accumulated });
        }
        subscriber.complete();
      } catch (err) {
        if (!controller.signal.aborted) {
          subscriber.error(err);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }).pipe(
    finalize(() => activeStreams.delete(key)),
    share()
  );

  activeStreams.set(key, stream$);
  return stream$;
}
