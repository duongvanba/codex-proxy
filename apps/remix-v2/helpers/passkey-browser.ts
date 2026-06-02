export type PasskeyCredentialJSON = Record<string, unknown>;

export type PasskeyRegistrationOptions = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};

export type PasskeyLoginOptions = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};

function bytesFromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function arrayBufferFromBase64Url(value: string): ArrayBuffer {
  const bytes = bytesFromBase64Url(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlFromBuffer(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function assertPasskeySupported() {
  if (!("credentials" in navigator) || typeof PublicKeyCredential === "undefined") {
    throw new Error("Trình duyệt không hỗ trợ passkey");
  }
}

function credentialToJSON(credential: PublicKeyCredential): PasskeyCredentialJSON {
  const response = credential.response as AuthenticatorAttestationResponse | AuthenticatorAssertionResponse;
  const json: PasskeyCredentialJSON = {
    id: credential.id,
    rawId: base64UrlFromBuffer(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: base64UrlFromBuffer(response.clientDataJSON),
    },
  };
  if ("attestationObject" in response) {
    (json.response as Record<string, unknown>).attestationObject = base64UrlFromBuffer(response.attestationObject);
  }
  if ("authenticatorData" in response) {
    (json.response as Record<string, unknown>).authenticatorData = base64UrlFromBuffer(response.authenticatorData);
    (json.response as Record<string, unknown>).signature = base64UrlFromBuffer(response.signature);
    if (response.userHandle) (json.response as Record<string, unknown>).userHandle = base64UrlFromBuffer(response.userHandle);
  }
  return json;
}

export async function createPasskeyCredential(options: PasskeyRegistrationOptions): Promise<PasskeyCredentialJSON> {
  assertPasskeySupported();
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: arrayBufferFromBase64Url(String(options.challenge)),
      user: { ...options.user, id: arrayBufferFromBase64Url(String(options.user.id)) },
      excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: arrayBufferFromBase64Url(String(item.id)) })),
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey registration was cancelled");
  return credentialToJSON(credential);
}

export async function getPasskeyCredential(options: PasskeyLoginOptions): Promise<PasskeyCredentialJSON> {
  assertPasskeySupported();
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: arrayBufferFromBase64Url(String(options.challenge)),
      allowCredentials: options.allowCredentials?.map((item) => ({ ...item, id: arrayBufferFromBase64Url(String(item.id)) })),
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey login was cancelled");
  return credentialToJSON(credential);
}
