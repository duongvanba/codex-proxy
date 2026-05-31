/**
 * Remote Control Client Enrollment
 *
 * Flow:
 *  1. POST enroll/start → get challenge object + client_id (body: {})
 *  2. Start local callback server on port 1455 or 1457
 *  3. Build OAuth URL (prompt=login, scope=codex.remote_control.enroll)
 *     redirect_uri = http://localhost:{port}/auth/callback
 *  4. User logs in, browser redirects to localhost:{port}/auth/callback?code=...
 *  5. Local server exchanges code for step-up token, calls enroll/finish
 *  6. Local server serves success page with window.opener.postMessage
 */

import { ChatGPTClient, CHATGPT_BASE } from "../chatgpt";
import type { Account } from "../../schemas";
import type { AccountsService } from "../../services/accounts";

const HOME = process.env.HOME ?? "";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ISSUER = "https://auth.openai.com";
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_PORTS = [1455, 1457];

const ENROLLMENTS_FILE = `${HOME}/.codex/.codex-proxy-enrollments.json`;
const PENDING_FILE = `${HOME}/.codex/.codex-proxy-pending.json`;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EnrollmentEntry = {
  accountId: string;
  clientId: string;
  keyId: string;
  privateKeyPkcs8Base64: string;
  publicKeySpkiBase64: string;
  remoteControlToken: string;
  enrolledAt: number;
  tokenExpiresAt?: number; // Unix seconds; undefined for old enrollments without this field
};

type EnrollChallenge = {
  challenge_id: string;
  challenge_token: string;
  nonce: string;
  purpose: string;
  audience: string;
  account_user_id: string;
  client_id: string;
  target_origin: string;
  target_path: string;
  device_identity_hash: string | null;
  challenge_expires_at: string;
};

type PendingEnrollment = {
  accountId: string;
  clientId: string;
  keyId: string;
  privateKeyPkcs8: Uint8Array;
  publicKeySpkiBase64: string;
  challenge: EnrollChallenge;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
};

type SerializedPending = Omit<PendingEnrollment, "privateKeyPkcs8"> & { pendingId: string; privateKeyPkcs8Base64: string };

// ─── Class ────────────────────────────────────────────────────────────────────

export class EnrollmentService {
  constructor(private readonly accounts: AccountsService) {}

  private pendingEnrollments = new Map<string, PendingEnrollment>(); // pendingId → state
  private completedEnrollments = new Map<string, EnrollmentEntry>();  // accountId → entry
  private enrollmentsLoaded = false;
  private pendingLoaded = false;

  // Active local callback servers keyed by port
  private activeCallbackServers = new Map<number, ReturnType<typeof Bun.serve>>();

  // ─── Persistence ─────────────────────────────────────────────────────────────

  private async loadEnrollments(): Promise<void> {
    if (this.enrollmentsLoaded) return;
    this.enrollmentsLoaded = true;
    try {
      const f = Bun.file(ENROLLMENTS_FILE);
      if (await f.exists()) {
        const data = (await f.json()) as EnrollmentEntry[];
        for (const e of data) this.completedEnrollments.set(e.accountId, e);
      }
    } catch {}
  }

  private async saveEnrollments(): Promise<void> {
    const data = [...this.completedEnrollments.values()];
    await Bun.write(ENROLLMENTS_FILE, JSON.stringify(data, null, 2));
  }

  private async loadPending(): Promise<void> {
    if (this.pendingLoaded) return;
    this.pendingLoaded = true;
    try {
      const f = Bun.file(PENDING_FILE);
      if (await f.exists()) {
        const data = (await f.json()) as SerializedPending[];
        const cutoff = Date.now() - 15 * 60_000;
        for (const e of data) {
          if (e.createdAt < cutoff) continue;
          const { pendingId, privateKeyPkcs8Base64, ...rest } = e;
          this.pendingEnrollments.set(pendingId, {
            ...rest,
            privateKeyPkcs8: Buffer.from(privateKeyPkcs8Base64, "base64"),
          });
        }
      }
    } catch {}
  }

  private async savePending(): Promise<void> {
    const cutoff = Date.now() - 15 * 60_000;
    const data: SerializedPending[] = [];
    for (const [pendingId, p] of this.pendingEnrollments) {
      if (p.createdAt < cutoff) continue;
      const { privateKeyPkcs8, ...rest } = p;
      data.push({ ...rest, pendingId, privateKeyPkcs8Base64: Buffer.from(privateKeyPkcs8).toString("base64") });
    }
    await Bun.write(PENDING_FILE, JSON.stringify(data, null, 2));
  }

  // ─── Local callback server ────────────────────────────────────────────────────

  private startCallbackServer(): { port: number; close: () => void } {
    for (const port of CALLBACK_PORTS) {
      if (this.activeCallbackServers.has(port)) {
        // Already running, reuse it
        return { port, close: () => {} };
      }
      try {
        const server = Bun.serve({
          port,
          fetch: async (req) => {
            const url = new URL(req.url);
            if (url.pathname !== CALLBACK_PATH) {
              return new Response("Not Found", { status: 404 });
            }

            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state"); // pendingId
            const oauthError = url.searchParams.get("error");

            if (oauthError) {
              const desc = url.searchParams.get("error_description") ?? "";
              return new Response(
                `<html><body><h2>Enrollment failed: ${oauthError}</h2><p>${desc}</p><script>window.close();</script></body></html>`,
                { headers: { "Content-Type": "text/html" } }
              );
            }

            if (!code || !state) {
              return new Response(
                `<html><body><h2>Missing code or state</h2></body></html>`,
                { status: 400, headers: { "Content-Type": "text/html" } }
              );
            }

            try {
              await this.completeEnrollmentWithCode(state, code);
              // Stop server after successful enrollment
              setTimeout(() => {
                this.activeCallbackServers.delete(port);
                try { server.stop(true); } catch {}
              }, 3000);
              return new Response(
                `<html><body>
                  <h2>Remote Control enrollment successful!</h2>
                  <p>You can close this tab.</p>
                  <script>
                    window.opener?.postMessage({ type: "enroll-success", pendingId: "${state}" }, "*");
                    setTimeout(() => window.close(), 1500);
                  </script>
                </body></html>`,
                { headers: { "Content-Type": "text/html" } }
              );
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[enroll] callback error: ${msg}`);
              return new Response(
                `<html><body><h2>Enrollment failed</h2><pre>${msg}</pre></body></html>`,
                { status: 500, headers: { "Content-Type": "text/html" } }
              );
            }
          },
        });
        this.activeCallbackServers.set(port, server);
        console.log(`[enroll] callback server listening on port ${port}`);
        return { port, close: () => { this.activeCallbackServers.delete(port); try { server.stop(true); } catch {} } };
      } catch {
        // Port in use, try next
      }
    }
    throw new Error(`Could not bind callback server (tried ports: ${CALLBACK_PORTS.join(", ")})`);
  }

  // ─── Crypto helpers ───────────────────────────────────────────────────────────

  private rawToDer(rawSig: Uint8Array): Uint8Array {
    const r = rawSig.slice(0, 32);
    const s = rawSig.slice(32, 64);
    const rPad = r[0] & 0x80 ? new Uint8Array([0, ...r]) : r;
    const sPad = s[0] & 0x80 ? new Uint8Array([0, ...s]) : s;
    const seqLen = 2 + rPad.length + 2 + sPad.length;
    const der = new Uint8Array(2 + seqLen);
    let i = 0;
    der[i++] = 0x30; der[i++] = seqLen;
    der[i++] = 0x02; der[i++] = rPad.length; der.set(rPad, i); i += rPad.length;
    der[i++] = 0x02; der[i++] = sPad.length; der.set(sPad, i);
    return der;
  }

  private base64urlEncode(buf: Uint8Array | ArrayBuffer): string {
    return Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString("base64url");
  }

  private async pkceChallenge(): Promise<{ verifier: string; challenge: string }> {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const verifier = this.base64urlEncode(arr);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = this.base64urlEncode(new Uint8Array(hash));
    return { verifier, challenge };
  }

  private async computeDeviceIdentityHash(keyId: string, publicKeySpkiBase64: string): Promise<string> {
    const json = JSON.stringify({
      algorithm: "ecdsa_p256_sha256",
      keyId,
      protectionClass: "os_protected_nonextractable",
      publicKeySpkiDerBase64: publicKeySpkiBase64,
    });
    const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    return Buffer.from(hashBytes).toString("base64url");
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  async restartPendingCallbackListeners(): Promise<void> {
    await this.loadPending();
    if (this.pendingEnrollments.size === 0) return;
    try {
      this.startCallbackServer();
    } catch (e) {
      console.warn(`[enroll] Could not restart callback listener: ${e}`);
    }
  }

  async getEnrollment(accountId: string): Promise<EnrollmentEntry | undefined> {
    await this.loadEnrollments();
    return this.completedEnrollments.get(accountId);
  }

  async startEnrollment(account: Account, _originHint: string): Promise<{
    enrollUrl: string;
    pendingId: string;
    clientId: string;
  }> {
    const headers = ChatGPTClient.buildCodexHttpHeaders(account, "application/json");

    // Generate ECDSA key pair
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
    );
    const keyId = crypto.randomUUID();
    const spkiDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const pkcs8Der = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const publicKeySpkiBase64 = Buffer.from(spkiDer).toString("base64");
    const privateKeyPkcs8 = new Uint8Array(pkcs8Der);

    // enroll/start — body must be empty {}
    const startRes = await fetch(`${CHATGPT_BASE}/backend-api/codex/remote/control/client/enroll/start`, {
      method: "POST", headers, body: JSON.stringify({}),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "");
      throw new Error(`enroll/start ${startRes.status}: ${text.slice(0, 200)}`);
    }
    const startData = (await startRes.json()) as {
      client_id: string;
      account_user_id?: string;
      device_key_challenge: EnrollChallenge;
    };
    const { client_id, device_key_challenge: challenge } = startData;

    // Start local callback server on port 1455 or 1457 (same ports Codex desktop uses)
    const { port } = this.startCallbackServer();
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    // PKCE
    const { verifier: codeVerifier, challenge: codeChallenge } = await this.pkceChallenge();

    // Load and clean up stale pending entries
    await this.loadPending();
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, p] of this.pendingEnrollments) {
      if (p.createdAt < cutoff) this.pendingEnrollments.delete(id);
    }

    const pendingId = crypto.randomUUID();
    this.pendingEnrollments.set(pendingId, {
      accountId: account.id,
      clientId: client_id,
      keyId,
      privateKeyPkcs8,
      publicKeySpkiBase64,
      challenge,
      codeVerifier,
      redirectUri,
      createdAt: Date.now(),
    });

    await this.savePending();

    // Build OAuth URL — scope must be exactly "codex.remote_control.enroll"
    const params = new URLSearchParams({
      response_type: "code",
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "codex.remote_control.enroll",
      prompt: "login",
      reauth: "remote_control",
      max_age: "0",
      codex_cli_simplified_flow: "true",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: pendingId,
    });
    const enrollUrl = `${AUTH_ISSUER}/oauth/authorize?${params}`;

    console.log(`[enroll] started for ${account.email}, client_id=${client_id}, pendingId=${pendingId}, callback=port:${port}`);
    return { enrollUrl, pendingId, clientId: client_id };
  }

  async completeEnrollmentWithCode(
    pendingId: string,
    authCode: string
  ): Promise<void> {
    await this.loadPending();
    const pending = this.pendingEnrollments.get(pendingId);
    if (!pending) throw new Error("Pending enrollment not found or expired");

    // Exchange code for step-up token via auth.openai.com/oauth/token
    const tokenRes = await fetch(`${AUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      throw new Error(`Token exchange failed ${tokenRes.status}: ${text.slice(0, 200)}`);
    }
    const tokenData = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
    const stepUpToken = tokenData.access_token;

    await this.completeEnrollmentWithToken(pendingId, stepUpToken);
  }

  async completeEnrollmentWithToken(
    pendingId: string,
    stepUpToken: string
  ): Promise<EnrollmentEntry> {
    await this.loadPending();
    const pending = this.pendingEnrollments.get(pendingId);
    if (!pending) throw new Error("Pending enrollment not found or expired");

    const { challenge, keyId, publicKeySpkiBase64, clientId, accountId } = pending;

    // Import private key
    const cryptoPrivKey = await crypto.subtle.importKey(
      "pkcs8", pending.privateKeyPkcs8 as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );

    // Device identity hash — SHA-256 of JSON of key metadata (base64url)
    const deviceIdentitySha256Base64url = challenge.device_identity_hash
      ?? await this.computeDeviceIdentityHash(keyId, publicKeySpkiBase64);

    // Build signed payload matching Codex desktop native module exactly:
    const sortedPayload = {
      accountUserId: challenge.account_user_id,
      audience: "remote_control_client_enrollment",
      challengeExpiresAt: challenge.challenge_expires_at,
      challengeId: challenge.challenge_id,
      clientId: challenge.client_id,
      deviceIdentitySha256Base64url,
      nonce: challenge.nonce,
      targetOrigin: challenge.target_origin,
      targetPath: challenge.target_path,
      type: "remoteControlClientEnrollment",
    };
    const signedPayloadBytes = Buffer.from(
      JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: sortedPayload }),
      "utf8"
    );
    const signedPayloadBase64 = signedPayloadBytes.toString("base64");

    const rawSig = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } }, cryptoPrivKey, signedPayloadBytes
    );
    const signatureDerBase64 = Buffer.from(this.rawToDer(new Uint8Array(rawSig))).toString("base64");

    // Regular account auth headers (step_up_token goes in body, NOT in Authorization)
    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) throw new Error(`Account not found for pending enrollment ${pendingId}`);
    const headers = ChatGPTClient.buildCodexHttpHeaders(account, "application/json");

    const finishBody = {
      client_id: clientId,
      step_up_token: stepUpToken,
      device_identity: {
        key_id: keyId,
        public_key_spki_der_base64: publicKeySpkiBase64,
        algorithm: "ecdsa_p256_sha256",
        protection_class: "os_protected_nonextractable",
      },
      device_key_proof: {
        challenge_token: challenge.challenge_token,
        key_id: keyId,
        signature_der_base64: signatureDerBase64,
        signed_payload_base64: signedPayloadBase64,
        algorithm: "ecdsa_p256_sha256",
      },
    };

    const finishRes = await fetch(`${CHATGPT_BASE}/backend-api/codex/remote/control/client/enroll/finish`, {
      method: "POST", headers, body: JSON.stringify(finishBody),
    });
    if (!finishRes.ok) {
      const text = await finishRes.text().catch(() => "");
      throw new Error(`enroll/finish ${finishRes.status}: ${text.slice(0, 300)}`);
    }
    const finishData = (await finishRes.json()) as {
      client_id: string;
      remote_control_token: string;
      expires_at?: string;
    };
    const tokenExpiresAt = finishData.expires_at ? Math.floor(Date.parse(finishData.expires_at) / 1000) : undefined;

    const entry: EnrollmentEntry = {
      accountId,
      clientId: finishData.client_id ?? clientId,
      keyId,
      privateKeyPkcs8Base64: Buffer.from(pending.privateKeyPkcs8).toString("base64"),
      publicKeySpkiBase64,
      remoteControlToken: finishData.remote_control_token,
      enrolledAt: Date.now(),
      tokenExpiresAt,
    };

    this.pendingEnrollments.delete(pendingId);
    this.completedEnrollments.set(accountId, entry);
    await this.saveEnrollments();
    await this.savePending();

    console.log(`[enroll] completed for accountId=${accountId}, clientId=${entry.clientId}`);
    return entry;
  }

  async deleteEnrollment(accountId: string): Promise<void> {
    await this.loadEnrollments();
    this.completedEnrollments.delete(accountId);
    await this.saveEnrollments();
  }

  async getPendingEnrollment(pendingId: string): Promise<PendingEnrollment | undefined> {
    await this.loadPending();
    return this.pendingEnrollments.get(pendingId);
  }

  async refreshEnrollment(accountId: string): Promise<EnrollmentEntry> {
    await this.loadEnrollments();
    const existing = this.completedEnrollments.get(accountId);
    if (!existing) throw new Error(`No enrollment found for account ${accountId}`);

    const account = this.accounts.getAccounts().find((a) => a.id === accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);

    const headers = ChatGPTClient.buildCodexHttpHeaders(account, "application/json");

    const startRes = await fetch(`${CHATGPT_BASE}/backend-api/codex/remote/control/client/refresh/start`, {
      method: "POST", headers, body: JSON.stringify({ client_id: existing.clientId }),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => "");
      throw new Error(`refresh/start ${startRes.status}: ${text.slice(0, 200)}`);
    }
    const startData = (await startRes.json()) as {
      client_id: string;
      account_user_id: string;
      device_key_challenge: EnrollChallenge;
    };
    const { device_key_challenge: challenge } = startData;

    const cryptoPrivKey = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(existing.privateKeyPkcs8Base64, "base64"),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );

    const deviceIdentitySha256Base64url = challenge.device_identity_hash
      ?? await this.computeDeviceIdentityHash(existing.keyId, existing.publicKeySpkiBase64);

    const sortedPayload = {
      accountUserId: challenge.account_user_id,
      audience: "remote_control_client_enrollment",
      challengeExpiresAt: challenge.challenge_expires_at,
      challengeId: challenge.challenge_id,
      clientId: challenge.client_id,
      deviceIdentitySha256Base64url,
      nonce: challenge.nonce,
      targetOrigin: challenge.target_origin,
      targetPath: challenge.target_path,
      type: "remoteControlClientEnrollment",
    };
    const signedPayloadBytes = Buffer.from(
      JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: sortedPayload }),
      "utf8"
    );
    const signedPayloadBase64 = signedPayloadBytes.toString("base64");
    const rawSig = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } }, cryptoPrivKey, signedPayloadBytes
    );
    const signatureDerBase64 = Buffer.from(this.rawToDer(new Uint8Array(rawSig))).toString("base64");

    const finishRes = await fetch(`${CHATGPT_BASE}/backend-api/codex/remote/control/client/refresh/finish`, {
      method: "POST", headers,
      body: JSON.stringify({
        client_id: existing.clientId,
        device_key_proof: {
          challenge_token: challenge.challenge_token,
          key_id: existing.keyId,
          signature_der_base64: signatureDerBase64,
          signed_payload_base64: signedPayloadBase64,
          algorithm: "ecdsa_p256_sha256",
        },
      }),
    });
    if (!finishRes.ok) {
      const text = await finishRes.text().catch(() => "");
      throw new Error(`refresh/finish ${finishRes.status}: ${text.slice(0, 300)}`);
    }
    const finishData = (await finishRes.json()) as {
      client_id: string;
      remote_control_token: string;
      expires_at?: string;
    };
    const tokenExpiresAt = finishData.expires_at ? Math.floor(Date.parse(finishData.expires_at) / 1000) : undefined;

    const updated: EnrollmentEntry = {
      ...existing,
      remoteControlToken: finishData.remote_control_token,
      enrolledAt: Date.now(),
      tokenExpiresAt,
    };

    this.completedEnrollments.set(accountId, updated);
    await this.saveEnrollments();
    console.log(`[enroll] token refreshed for accountId=${accountId}, clientId=${updated.clientId}, expiresAt=${tokenExpiresAt ? new Date(tokenExpiresAt * 1000).toISOString() : 'unknown'}`);
    return updated;
  }
}
