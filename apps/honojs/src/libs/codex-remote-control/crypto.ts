import type { DeviceKeyChallenge, RCEnrollment } from "./types";

/**
 * Convert a raw 64-byte ECDSA signature (r || s) to DER encoding.
 */
export function rawToDer(rawSig: Uint8Array): Uint8Array {
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

/**
 * Sign a device_key_challenge with the enrollment's private ECDSA P-256 key
 * and return a device_key_proof payload ready to send over the WebSocket.
 */
export async function signChallenge(
  challenge: DeviceKeyChallenge,
  enrollment: RCEnrollment
): Promise<Record<string, unknown>> {
  const sortedPayload = {
    accountUserId: challenge.accountUserId,
    audience: challenge.audience,
    clientId: challenge.clientId,
    nonce: challenge.nonce,
    scopes: challenge.scopes,
    sessionId: challenge.sessionId,
    targetOrigin: challenge.targetOrigin,
    targetPath: challenge.targetPath,
    tokenExpiresAt: challenge.tokenExpiresAt,
    tokenSha256Base64url: challenge.tokenSha256Base64url,
    type: "remoteControlClientConnection",
  };

  const payloadBytes = Buffer.from(
    JSON.stringify({ domain: "codex-device-key-sign-payload/v1", payload: sortedPayload }),
    "utf8"
  );

  const privKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(enrollment.privateKeyPkcs8Base64, "base64"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const rawSig = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privKey,
    payloadBytes
  );

  return {
    type: "device_key_proof",
    keyId: enrollment.keyId,
    signatureDerBase64: Buffer.from(rawToDer(new Uint8Array(rawSig))).toString("base64"),
    signedPayloadBase64: payloadBytes.toString("base64"),
    algorithm: "ecdsa_p256_sha256",
  };
}
