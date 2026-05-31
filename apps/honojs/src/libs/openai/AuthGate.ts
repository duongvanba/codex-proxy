const ALLOWED_PLANS = new Set(["plus", "pro", "max"]);
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const JWKS_TTL_MS = 60 * 60 * 1000;
const EXPECTED_ISS = "https://auth.openai.com";

export type GateResult =
  | { ok: true; email: string; planType: string }
  | { ok: false; status: number; error: string };

type Jwk = { kty: string; kid: string; use?: string; alg?: string; n?: string; e?: string };

// ─── AuthGateService ──────────────────────────────────────────────────────────

export class AuthGateService {
  private jwksEntry: { fetchedAt: number; promise: Promise<Jwk[]> } | null = null;
  private cryptoKeyEntries = new Map<string, Promise<CryptoKey | null>>();

  private async fetchJwks(): Promise<Jwk[]> {
    const t0 = Date.now();
    const res = await fetch(JWKS_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`JWKS fetch failed ${res.status}`);
    const data = await res.json() as { keys?: Jwk[] };
    if (!Array.isArray(data?.keys)) throw new Error("JWKS missing keys[]");
    console.log(`[gate] JWKS fetched: ${data.keys.length} keys in ${Date.now() - t0}ms`);
    return data.keys;
  }

  private getJwks(forceRefresh = false): Promise<Jwk[]> {
    const fresh = this.jwksEntry && Date.now() - this.jwksEntry.fetchedAt < JWKS_TTL_MS && !forceRefresh;
    if (fresh) return this.jwksEntry!.promise;
    const promise = this.fetchJwks();
    const entry = { fetchedAt: Date.now(), promise };
    this.jwksEntry = entry;
    this.cryptoKeyEntries.clear();
    promise.catch(() => { if (this.jwksEntry === entry) this.jwksEntry = null; });
    return promise;
  }

  private getCryptoKey(kid: string): Promise<CryptoKey | null> {
    const cached = this.cryptoKeyEntries.get(kid);
    if (cached) return cached;
    const promise = (async () => {
      let keys = await this.getJwks();
      let jwk = keys.find((k) => k.kid === kid);
      if (!jwk) { keys = await this.getJwks(true); jwk = keys.find((k) => k.kid === kid); }
      if (!jwk || jwk.kty !== "RSA") return null;
      return await crypto.subtle.importKey(
        "jwk",
        { ...jwk, alg: "RS256", use: "sig" } as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
    })();
    this.cryptoKeyEntries.set(kid, promise);
    promise.catch(() => { if (this.cryptoKeyEntries.get(kid) === promise) this.cryptoKeyEntries.delete(kid); });
    return promise;
  }

  private b64urlDecode(s: string): Uint8Array {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 ? "=".repeat(4 - (padded.length % 4)) : "";
    return Uint8Array.from(Buffer.from(padded + pad, "base64"));
  }

  private b64urlToText(s: string): string {
    return new TextDecoder().decode(this.b64urlDecode(s));
  }

  private extractBearer(req: Request): string {
    const auth = req.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : "";
  }

  private async verifyJwtSignature(token: string): Promise<{ ok: boolean; reason?: string }> {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "Malformed JWT" };
    let header: any;
    try { header = JSON.parse(this.b64urlToText(parts[0])); }
    catch { return { ok: false, reason: "Cannot parse JWT header" }; }
    if (header.alg !== "RS256") return { ok: false, reason: `Unsupported alg ${header.alg}` };
    if (!header.kid) return { ok: false, reason: "Missing kid in JWT header" };
    let key: CryptoKey | null;
    try { key = await this.getCryptoKey(header.kid); }
    catch (e: any) { return { ok: false, reason: `JWKS error: ${e?.message ?? e}` }; }
    if (!key) return { ok: false, reason: `Unknown kid: ${header.kid}` };
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = this.b64urlDecode(parts[2]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig as BufferSource, signed as BufferSource);
    return valid ? { ok: true } : { ok: false, reason: "Signature verification failed" };
  }

  async validateClientJwt(req: Request): Promise<GateResult> {
    const token = this.extractBearer(req);
    if (!token) return { ok: false, status: 401, error: "Missing Authorization Bearer token" };

    const sig = await this.verifyJwtSignature(token);
    if (!sig.ok) return { ok: false, status: 401, error: sig.reason ?? "Invalid signature" };

    let claims: Record<string, any>;
    try { claims = JSON.parse(this.b64urlToText(token.split(".")[1])); }
    catch { return { ok: false, status: 401, error: "Cannot parse claims" }; }

    if (claims.iss !== EXPECTED_ISS)
      return { ok: false, status: 401, error: `Invalid issuer: ${claims.iss}` };

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number")
      return { ok: false, status: 401, error: "Missing exp claim" };
    if (claims.exp <= now)
      return { ok: false, status: 401, error: `JWT expired (exp=${claims.exp}, now=${now})` };
    if (typeof claims.nbf === "number" && claims.nbf > now + 30)
      return { ok: false, status: 401, error: `JWT not yet valid (nbf=${claims.nbf})` };

    const authClaims = claims["https://api.openai.com/auth"] ?? {};
    const planType: string = (authClaims.chatgpt_plan_type ?? "").toString().toLowerCase();
    if (!ALLOWED_PLANS.has(planType))
      return { ok: false, status: 403, error: `Plan "${planType || "unknown"}" not allowed. Required: ${[...ALLOWED_PLANS].join(", ")}` };

    const profile = claims["https://api.openai.com/profile"] ?? {};
    const email: string = profile.email ?? authClaims.chatgpt_user_id ?? "unknown";
    return { ok: true, email, planType };
  }
}
