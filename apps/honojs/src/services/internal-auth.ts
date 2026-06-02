import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash, timingSafeEqual } from "crypto";
import type { Account } from "../schemas";
import { serializeAccount } from "./livequery";

const INTERNAL_AUTH_FILE = join(import.meta.dir, "..", "..", "..", "..", "internal-auth.json");
const TOKEN_TTL_SECONDS = Number(process.env.INTERNAL_JWT_TTL_SECONDS ?? 15 * 60);
// Refresh token sống 1 tháng (~30 ngày) theo yêu cầu, có thể override qua env.
const REFRESH_TTL_SECONDS = Number(process.env.INTERNAL_REFRESH_TTL_SECONDS ?? 30 * 24 * 60 * 60);

type InternalAuthState = {
  secret: string;
  sessionVersion: number;
  passkeys?: StoredPasskey[];
};

type InternalJwtPayload = {
  sub: string;
  email: string;
  account_ids: string[];
  sv: number;
  iat: number;
  exp: number;
};

type RefreshJwtPayload = {
  sub: string;
  account_ids: string[];
  sv: number;
  type: "refresh";
  auth_provider?: "passkey";
  passkey_username?: string;
  iat: number;
  exp: number;
};

type CurrentAccountSessionMeta = {
  auth_provider?: "passkey";
  username?: string;
};

type StoredPasskey = {
  id: string;
  accountId: string;
  email: string;
  username: string;
  publicKeySpki: string;
  signCount: number;
};

type PasskeyChallenge = {
  challenge: string;
  accountId?: string;
  type: "register" | "login";
  createdAt: number;
};

function base64Url(input: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(bytes).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseBase64UrlJson<T>(value: string): T {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as T;
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}

function readSignCount(authData: Uint8Array): number {
  return new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);
}

function verifyRpIdHash(authData: Uint8Array, rpId: string) {
  const expected = createHash("sha256").update(rpId).digest();
  const actual = Buffer.from(authData.slice(0, 32));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Passkey RP ID mismatch");
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseAttestedCredentialData(authData: Uint8Array) {
  const flags = authData[32] ?? 0;
  if ((flags & 0x40) === 0) throw new Error("Passkey registration is missing attested credential data");
  const signCount = readSignCount(authData);
  let offset = 37 + 16;
  const credentialIdLength = new DataView(authData.buffer, authData.byteOffset + offset, 2).getUint16(0, false);
  offset += 2;
  const credentialId = authData.slice(offset, offset + credentialIdLength);
  offset += credentialIdLength;
  const cose = decodeCbor(authData.slice(offset));
  const publicKeySpki = coseEc2ToSpki(cose);
  return { credentialId, publicKeySpki, signCount };
}

function coseEc2ToSpki(value: unknown): Uint8Array {
  if (!(value instanceof Map)) throw new Error("Unsupported passkey public key");
  const kty = value.get(1);
  const alg = value.get(3);
  const crv = value.get(-1);
  const x = value.get(-2);
  const y = value.get(-3);
  if (kty !== 2 || alg !== -7 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("Only ES256 P-256 passkeys are supported");
  }
  const header = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  return new Uint8Array(Buffer.concat([header, Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]));
}

function derToRawEcdsa(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Invalid ECDSA signature");
  const seqLen = der[offset++];
  if (seqLen & 0x80) offset += seqLen & 0x7f;
  const readInt = () => {
    if (der[offset++] !== 0x02) throw new Error("Invalid ECDSA signature");
    const len = der[offset++];
    const bytes = der.slice(offset, offset + len);
    offset += len;
    const trimmed = bytes[0] === 0 ? bytes.slice(1) : bytes;
    const out = new Uint8Array(32);
    out.set(trimmed.slice(-32), 32 - Math.min(trimmed.length, 32));
    return out;
  };
  return new Uint8Array([...readInt(), ...readInt()]);
}

function decodeCbor(bytes: Uint8Array): unknown {
  let offset = 0;
  const read = (): unknown => {
    const first = bytes[offset++];
    const major = first >> 5;
    const info = first & 0x1f;
    const len = (): number => {
      if (info < 24) return info;
      if (info === 24) return bytes[offset++];
      if (info === 25) { const v = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false); offset += 2; return v; }
      if (info === 26) { const v = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false); offset += 4; return v; }
      throw new Error("Unsupported CBOR length");
    };
    if (major === 0) return len();
    if (major === 1) return -1 - len();
    if (major === 2) { const n = len(); const out = bytes.slice(offset, offset + n); offset += n; return out; }
    if (major === 3) { const n = len(); const out = new TextDecoder().decode(bytes.slice(offset, offset + n)); offset += n; return out; }
    if (major === 4) { const n = len(); return Array.from({ length: n }, read); }
    if (major === 5) {
      const n = len();
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) map.set(read(), read());
      return map;
    }
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
    }
    throw new Error("Unsupported CBOR value");
  };
  return read();
}

function timingSafeEqualString(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class InternalAuthService {
  private state: InternalAuthState;
  private passkeyChallenges = new Map<string, PasskeyChallenge>();

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): InternalAuthState {
    if (existsSync(INTERNAL_AUTH_FILE)) {
      try {
        const parsed = JSON.parse(readFileSync(INTERNAL_AUTH_FILE, "utf8")) as Partial<InternalAuthState>;
        if (parsed.secret) return { secret: parsed.secret, sessionVersion: Number(parsed.sessionVersion ?? 1), passkeys: Array.isArray(parsed.passkeys) ? parsed.passkeys as StoredPasskey[] : [] };
      } catch {
        // fall through and create a new state file
      }
    }
    const state = { secret: crypto.randomUUID() + crypto.randomUUID(), sessionVersion: 1, passkeys: [] };
    this.saveState(state);
    return state;
  }

  private saveState(state = this.state) {
    writeFileSync(INTERNAL_AUTH_FILE, JSON.stringify(state, null, 2));
  }

  private issueChallenge(type: "register" | "login", accountId?: string) {
    const challenge = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    this.passkeyChallenges.set(challenge, { challenge, accountId, type, createdAt: Date.now() });
    return challenge;
  }

  private async sign(input: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.state.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  }

  private buildPayload(accounts: Account[]): InternalJwtPayload {
    const now = Math.floor(Date.now() / 1000);
    const primary = accounts[0];
    return {
      sub: primary?.id ?? "anonymous",
      email: primary?.email ?? "unknown",
      account_ids: accounts.map((account) => account.id),
      sv: this.state.sessionVersion,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    };
  }

  async issue(accounts: Account[]) {
    const payload = this.buildPayload(accounts);
    const header = { alg: "HS256", typ: "JWT" };
    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const token = `${unsigned}.${await this.sign(unsigned)}`;
    return {
      jwt: token,
      expires_at: payload.exp * 1000,
      accounts: accounts.map((account) => serializeAccount(account)),
    };
  }

  async issueCurrentAccount(account: Account, meta: CurrentAccountSessionMeta = {}) {
    const payload = this.buildPayload([account]);
    const header = { alg: "HS256", typ: "JWT" };
    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const token = `${unsigned}.${await this.sign(unsigned)}`;
    return {
      jwt: token,
      expires_at: payload.exp * 1000,
      account: { username: meta.username ?? account.email },
    };
  }

  beginPasskeyRegistration(account: Account, rpId: string, username = account.email) {
    const challenge = this.issueChallenge("register", account.id);
    const existing = this.state.passkeys ?? [];
    const displayName = username.trim() || account.email;
    return {
      challenge,
      rp: { name: "Codex Proxy", id: rpId },
      user: {
        id: base64Url(new TextEncoder().encode(account.id)),
        name: displayName,
        displayName,
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      timeout: 60_000,
      attestation: "none",
      excludeCredentials: existing.filter((key) => key.accountId === account.id).map((key) => ({ type: "public-key", id: key.id })),
    };
  }

  beginPasskeyLogin(rpId: string) {
    const challenge = this.issueChallenge("login");
    return {
      challenge,
      rpId,
      timeout: 60_000,
      userVerification: "preferred",
      allowCredentials: (this.state.passkeys ?? []).map((key) => ({ type: "public-key", id: key.id })),
    };
  }

  async finishPasskeyRegistration(payload: Record<string, unknown>, account: Account, expectedOrigin: string, expectedRpId: string) {
    const response = payload.response as Record<string, unknown> | undefined;
    const id = String(payload.id ?? "");
    const rawId = String(payload.rawId ?? id);
    if (!response || !id || !rawId) throw new Error("Invalid passkey registration response");
    const clientDataJSON = fromBase64Url(String(response.clientDataJSON ?? ""));
    const attestationObject = fromBase64Url(String(response.attestationObject ?? ""));
    const clientData = JSON.parse(Buffer.from(clientDataJSON).toString("utf8")) as Record<string, unknown>;
    this.consumeChallenge(String(clientData.challenge ?? ""), "register", account.id);
    if (clientData.type !== "webauthn.create") throw new Error("Invalid passkey registration type");
    if (clientData.origin !== expectedOrigin) throw new Error("Invalid passkey origin");
    const attestation = decodeCbor(attestationObject) as Map<unknown, unknown>;
    const authData = attestation.get("authData");
    if (!(authData instanceof Uint8Array)) throw new Error("Missing authenticator data");
    verifyRpIdHash(authData, expectedRpId);
    const { credentialId, publicKeySpki, signCount } = parseAttestedCredentialData(authData);
    const credentialKey = base64Url(credentialId);
    if (credentialKey !== rawId && credentialKey !== id) throw new Error("Passkey credential id mismatch");
    const passkeys = (this.state.passkeys ?? []).filter((key) => key.id !== credentialKey);
    const username = typeof payload.username === "string" && payload.username.trim() ? payload.username.trim() : account.email;
    passkeys.push({ id: credentialKey, accountId: account.id, email: account.email, username, publicKeySpki: base64Url(publicKeySpki), signCount });
    this.state.passkeys = passkeys;
    this.saveState();
    return { credential_id: credentialKey, username };
  }

  async finishPasskeyLogin(payload: Record<string, unknown>, accounts: Account[], expectedOrigin: string, expectedRpId: string): Promise<{ account: Account; passkey: StoredPasskey }> {
    const response = payload.response as Record<string, unknown> | undefined;
    const id = String(payload.id ?? "");
    if (!response || !id) throw new Error("Invalid passkey login response");
    const passkey = (this.state.passkeys ?? []).find((key) => key.id === id);
    if (!passkey) throw new Error("Unknown passkey");
    const clientDataJSON = fromBase64Url(String(response.clientDataJSON ?? ""));
    const authenticatorData = fromBase64Url(String(response.authenticatorData ?? ""));
    const signature = fromBase64Url(String(response.signature ?? ""));
    const clientData = JSON.parse(Buffer.from(clientDataJSON).toString("utf8")) as Record<string, unknown>;
    this.consumeChallenge(String(clientData.challenge ?? ""), "login");
    if (clientData.type !== "webauthn.get") throw new Error("Invalid passkey login type");
    if (clientData.origin !== expectedOrigin) throw new Error("Invalid passkey origin");
    verifyRpIdHash(authenticatorData, expectedRpId);
    const clientHash = await crypto.subtle.digest("SHA-256", asArrayBuffer(clientDataJSON));
    const signed = Buffer.concat([Buffer.from(authenticatorData), Buffer.from(clientHash)]);
    const key = await crypto.subtle.importKey("spki", asArrayBuffer(fromBase64Url(passkey.publicKeySpki)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, asArrayBuffer(derToRawEcdsa(signature)), asArrayBuffer(signed));
    if (!ok) throw new Error("Invalid passkey signature");
    const signCount = readSignCount(authenticatorData);
    if (signCount > 0 && passkey.signCount > 0 && signCount <= passkey.signCount) throw new Error("Passkey sign counter did not advance");
    passkey.signCount = Math.max(passkey.signCount, signCount);
    this.saveState();
    const account = accounts.find((a) => a.id === passkey.accountId);
    if (!account) throw new Error("Passkey account is no longer available");
    return { account, passkey };
  }

  hasPasskeys() {
    return (this.state.passkeys ?? []).length > 0;
  }

  private consumeChallenge(challenge: string, type: "register" | "login", accountId?: string) {
    const record = this.passkeyChallenges.get(challenge);
    this.passkeyChallenges.delete(challenge);
    if (!record || record.type !== type) throw new Error("Invalid or expired passkey challenge");
    if (Date.now() - record.createdAt > 5 * 60_000) throw new Error("Passkey challenge expired");
    if (accountId && record.accountId !== accountId) throw new Error("Passkey challenge account mismatch");
  }

  async issueRefreshToken(accounts: Account[], meta: CurrentAccountSessionMeta = {}) {
    const now = Math.floor(Date.now() / 1000);
    const primary = accounts[0];
    const payload: RefreshJwtPayload = {
      sub: primary?.id ?? "anonymous",
      account_ids: accounts.map((account) => account.id),
      sv: this.state.sessionVersion,
      type: "refresh",
      auth_provider: meta.auth_provider,
      passkey_username: meta.username,
      iat: now,
      exp: now + REFRESH_TTL_SECONDS,
    };
    const header = { alg: "HS256", typ: "JWT" };
    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const token = `${unsigned}.${await this.sign(unsigned)}`;
    return { token, expires_at: payload.exp * 1000, max_age: REFRESH_TTL_SECONDS };
  }

  async validateRefreshToken(token: string | null | undefined): Promise<
    | { ok: true; payload: RefreshJwtPayload }
    | { ok: false; status: number; error: string }
  > {
    if (!token) return { ok: false, status: 401, error: "Missing refresh token cookie" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, status: 401, error: "Malformed refresh token" };

    const [header, payload, signature] = parts;
    const expected = await this.sign(`${header}.${payload}`);
    if (!timingSafeEqualString(signature, expected)) return { ok: false, status: 401, error: "Invalid refresh token signature" };

    let claims: RefreshJwtPayload;
    try {
      claims = parseBase64UrlJson<RefreshJwtPayload>(payload);
    } catch {
      return { ok: false, status: 401, error: "Invalid refresh token payload" };
    }

    if (claims.type !== "refresh") return { ok: false, status: 401, error: "Not a refresh token" };
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) return { ok: false, status: 401, error: "Refresh token expired" };
    if (claims.sv !== this.state.sessionVersion) return { ok: false, status: 401, error: "Refresh token has been revoked" };
    return { ok: true, payload: claims };
  }

  async validate(token: string | null | undefined): Promise<
    | { ok: true; payload: InternalJwtPayload }
    | { ok: false; status: number; error: string }
  > {
    if (!token) return { ok: false, status: 401, error: "Missing internal Authorization Bearer token" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, status: 401, error: "Malformed internal JWT" };

    const [header, payload, signature] = parts;
    const expected = await this.sign(`${header}.${payload}`);
    if (!timingSafeEqualString(signature, expected)) return { ok: false, status: 401, error: "Invalid internal JWT signature" };

    let claims: InternalJwtPayload;
    try {
      claims = parseBase64UrlJson<InternalJwtPayload>(payload);
    } catch {
      return { ok: false, status: 401, error: "Invalid internal JWT payload" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) return { ok: false, status: 401, error: "Internal JWT expired" };
    if (claims.sv !== this.state.sessionVersion) return { ok: false, status: 401, error: "Internal session has been logged out" };
    return { ok: true, payload: claims };
  }

  logout() {
    this.state.sessionVersion += 1;
    this.saveState();
  }
}
