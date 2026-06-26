import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CODEX_CALLBACK = "http://localhost:1455/auth/callback";
const OPENAI_AUTH_ORIGIN = "https://auth.openai.com";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RelayState {
  redirectUri: string;
  state: string;
}

// ─── AuthService ──────────────────────────────────────────────────────────────

export class AuthService {
  private encodeRelayState(value: RelayState): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  private decodeRelayState(value: string): RelayState | null {
    try {
      const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (!parsed || typeof parsed.redirectUri !== "string" || typeof parsed.state !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  buildLoginRedirect(_requestUrl: URL, authorizeUrl: string): string {
    const upstream = new URL(authorizeUrl);
    if (upstream.origin !== OPENAI_AUTH_ORIGIN || upstream.pathname !== "/oauth/authorize") {
      throw new Error("Unsupported authorize URL");
    }

    const originalState = upstream.searchParams.get("state");
    if (!originalState) {
      throw new Error("Missing OAuth state");
    }

    const originalRedirectUri = DEFAULT_CODEX_CALLBACK;

    upstream.searchParams.set("redirect_uri", DEFAULT_CODEX_CALLBACK);
    upstream.searchParams.set(
      "state",
      this.encodeRelayState({ redirectUri: originalRedirectUri, state: originalState })
    );

    return upstream.toString();
  }

  buildCodexCallback(callbackUrl: URL): URL {
    const encodedState = callbackUrl.searchParams.get("state");
    if (!encodedState) {
      throw new Error("Missing relay state");
    }

    const relayState = this.decodeRelayState(encodedState);
    if (!relayState) {
      throw new Error("Invalid relay state");
    }

    const target = new URL(relayState.redirectUri);
    const code = callbackUrl.searchParams.get("code");
    const error = callbackUrl.searchParams.get("error");
    const errorDescription = callbackUrl.searchParams.get("error_description");

    target.searchParams.set("state", relayState.state);
    if (code) target.searchParams.set("code", code);
    if (error) target.searchParams.set("error", error);
    if (errorDescription) target.searchParams.set("error_description", errorDescription);

    return target;
  }

  /**
   * Exchange a refresh token for a fresh token set at the OpenAI token endpoint.
   * Returns the raw HTTP status + body so callers can parse/handle as needed.
   */
  async exchangeRefreshToken(
    refreshToken: string
  ): Promise<{ ok: true; status: number; text: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: OPENAI_CLIENT_ID,
        }),
      });
      return { ok: true, status: res.status, text: await res.text() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
