/**
 * Local Desktop App task execution via thread-follower protocol.
 *
 * Flow:
 *  1. Register broadcast listener for the conversationId.
 *  2. Send thread-follower-start-turn-request over the remote-control WS.
 *  3. Listen for ipc-broadcast / thread-stream-state-changed messages.
 *  4. Apply JSON Patch (or snapshot) updates to conversation state.
 *  5. Emit SseEvent deltas; complete when phase === "final_answer".
 */

import { Observable, share, finalize } from "rxjs";
import type { Account } from "../schemas";
import type { SseEvent } from "../schemas/sse";
import {
  getConnection,
  addBroadcastListener,
  removeBroadcastListener,
} from "../services/remote-control";

// ─── Minimal JSON Patch (RFC 6902) ────────────────────────────────────────────

type PatchOp = { op: string; path: string; value?: unknown };

function patchApply(doc: unknown, ops: PatchOp[]): unknown {
  let result = doc;
  for (const op of ops) {
    const parts = op.path.split("/").filter(Boolean);
    result = patchSet(result, op.op as "add" | "replace" | "remove", parts, op.value);
  }
  return result;
}

function patchSet(
  doc: unknown,
  op: "add" | "replace" | "remove",
  path: string[],
  value: unknown
): unknown {
  if (path.length === 0) return op === "remove" ? undefined : value;

  const head = path[0];
  const tail = path.slice(1);
  if (head === undefined) return doc;

  if (Array.isArray(doc)) {
    const arr = [...doc];
    if (head === "-") {
      if (op === "add") arr.push(tail.length === 0 ? value : patchSet(undefined, op, tail, value));
      return arr;
    }
    const idx = parseInt(head, 10);
    if (isNaN(idx)) return doc;
    if (tail.length === 0) {
      if (op === "remove") arr.splice(idx, 1);
      else if (op === "add") arr.splice(idx, 0, value);
      else arr[idx] = value;
    } else {
      arr[idx] = patchSet(arr[idx], op, tail, value);
    }
    return arr;
  }

  const obj = doc != null && typeof doc === "object"
    ? { ...(doc as Record<string, unknown>) }
    : {} as Record<string, unknown>;

  if (tail.length === 0) {
    if (op === "remove") delete obj[head];
    else obj[head] = value;
  } else {
    obj[head] = patchSet(obj[head], op, tail, value);
  }
  return obj;
}

// ─── Conversation state text extraction ───────────────────────────────────────

type ConversationState = Record<string, unknown>;

function extractAssistantOutput(state: ConversationState): { text: string; phase: string } {
  const turns = (state.turns as unknown[]) ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as Record<string, unknown>;
    if (turn.role !== "assistant" && turn.type !== "assistant") continue;
    const items = (turn.items as unknown[]) ?? [];
    for (const item of items) {
      const it = item as Record<string, unknown>;
      if (it.type !== "agentMessage") continue;
      const contentItems = (it.contentItems as unknown[]) ?? [];
      const text = contentItems
        .filter((c) => (c as Record<string, unknown>).type === "text")
        .map((c) => String((c as Record<string, unknown>).text ?? ""))
        .join("");
      return { text, phase: String(it.phase ?? "") };
    }
  }
  return { text: "", phase: "" };
}

// ─── Start local turn ─────────────────────────────────────────────────────────

export type LocalTurnParams = {
  input: string;
  conversationId: string;
  chatId: string;
  cwd?: string;
  model?: string;
};

export function startLocalTurn(
  account: Account,
  hostId: string,
  params: LocalTurnParams
): Observable<SseEvent> {
  const { input, conversationId, chatId, cwd, model } = params;

  const stream$ = new Observable<SseEvent>((subscriber) => {
    let state: ConversationState = {};
    let accumulatedText = "";
    let completed = false;

    function handleBroadcast(msg: Record<string, unknown>) {
      if (completed) return;
      try {
        const bParams = msg.params as Record<string, unknown>;
        const change = bParams.change as Record<string, unknown>;

        if (change.type === "snapshot") {
          state = (change.conversationState ?? {}) as ConversationState;
        } else if (change.type === "patches") {
          const patches = (change.patches ?? []) as PatchOp[];
          state = patchApply(state, patches) as ConversationState;
        } else {
          return;
        }

        const { text, phase } = extractAssistantOutput(state);

        if (text.length > accumulatedText.length) {
          const delta = text.slice(accumulatedText.length);
          accumulatedText = text;
          subscriber.next({ type: "delta", chatId, turnId: conversationId, delta, accumulated: text });
        }

        if (phase === "final_answer" && !completed) {
          completed = true;
          if (accumulatedText) {
            subscriber.next({ type: "text_done", chatId, turnId: conversationId, text: accumulatedText });
          }
          subscriber.next({
            type: "completed",
            chatId,
            turnId: conversationId,
            outputItems: [],
            text: accumulatedText,
          });
          subscriber.complete();
        }
      } catch {
        // ignore malformed broadcast
      }
    }

    // Register listener before sending request to avoid missing early broadcasts
    addBroadcastListener(conversationId, handleBroadcast);

    getConnection(account)
      .then((ws) => {
        if (completed) return;
        ws.send(
          JSON.stringify({
            type: "thread-follower-start-turn-request",
            requestId: crypto.randomUUID(),
            hostId,
            params: {
              conversationId,
              turnStartParams: {
                input,
                ...(cwd && { cwd }),
                ...(model && { model }),
              },
            },
          })
        );
      })
      .catch((err) => {
        if (!completed) subscriber.error(err);
      });

    return () => {
      completed = true;
      removeBroadcastListener(conversationId, handleBroadcast);
    };
  }).pipe(
    finalize(() => {}),
    share()
  );

  return stream$;
}

// ─── Cancel local turn ────────────────────────────────────────────────────────

export async function cancelLocalTurn(
  account: Account,
  hostId: string,
  conversationId: string
): Promise<void> {
  const ws = await getConnection(account);
  ws.send(
    JSON.stringify({
      type: "thread-follower-interrupt-turn-request",
      requestId: crypto.randomUUID(),
      hostId,
      params: { conversationId },
    })
  );
}
