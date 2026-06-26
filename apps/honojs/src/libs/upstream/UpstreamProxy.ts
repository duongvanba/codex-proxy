// ─── UpstreamProxy ───────────────────────────────────────────────────────────
// Centralizes raw HTTP/WS egress to upstream origins (api.openai.com, chatgpt.com,
// auth.openai.com). Services delegate all passthrough networking here.

export class UpstreamProxy {
  /** Forward a request to an upstream origin, returning the raw Response. */
  forward(targetUrl: string, init: RequestInit): Promise<Response> {
    return fetch(targetUrl, init);
  }

  /** Convert an http(s) target/base to its ws(s) equivalent. */
  toWebSocketTarget(httpTarget: string): string {
    return httpTarget.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  }
}
