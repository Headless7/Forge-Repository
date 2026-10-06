/**
 * Web Push protocol, implemented with Node's crypto (no third-party library):
 *  - RFC 8291 message encryption (ECDH P-256 + HKDF + AES-128-GCM, "aes128gcm" content coding,
 *    RFC 8188), so only the subscribed browser can read a notification;
 *  - RFC 8292 VAPID, so push services know which server sends (ES256-signed JWT).
 * Verified against RFC 8291's worked example in web-push.test.ts.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/\s+/g, ""), "base64url");
}

export interface PushTarget {
  endpoint: string;
  /** The browser's P-256 public key (uncompressed point, base64url). */
  p256dh: string;
  /** The browser's 16-byte authentication secret (base64url). */
  auth: string;
}

/** Fixed inputs for tests (RFC 8291 example); production always uses fresh random values. */
export interface EncryptOverrides {
  asPrivateKey?: Buffer;
  salt?: Buffer;
}

/** Encrypts a payload for one subscription (single record, RFC 8291 §3–4). */
export function encryptPayload(plaintext: Uint8Array, target: Pick<PushTarget, "p256dh" | "auth">, overrides: EncryptOverrides = {}): Buffer {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Invalid subscription key.");
  if (authSecret.length !== 16) throw new Error("Invalid subscription secret.");

  const ecdh = createECDH("prime256v1");
  if (overrides.asPrivateKey) ecdh.setPrivateKey(overrides.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const salt = overrides.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));

  // One record: plaintext followed by the last-record padding delimiter (0x02).
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what browsers receive as applicationServerKey). */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
  /** mailto: or https: contact for push services. */
  subject: string;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), fromB64url(pub.x!), fromB64url(pub.y!)]);
  return { publicKey: b64url(point), privateKey: jwk.d! };
}

function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const point = fromB64url(keys.publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 key (base64url).");
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) },
    format: "jwk",
  });
}

/** Checks that the configured keys are a matching P-256 pair. */
export function validateVapidKeys(keys: VapidKeys) {
  // Derive the public point from the private scalar (a JWK import would just trust the x/y given).
  let derived: Buffer;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(fromB64url(keys.privateKey));
    derived = ecdh.getPublicKey();
    vapidPrivateKey(keys);
  } catch (error) {
    throw new Error(`Invalid VAPID keys: ${error instanceof Error ? error.message : error}`);
  }
  if (!derived.equals(fromB64url(keys.publicKey))) throw new Error("VAPID_PUBLIC_KEY doesn't match VAPID_PRIVATE_KEY.");
  if (!/^(mailto:|https:\/\/)/.test(keys.subject)) throw new Error("VAPID_SUBJECT must start with mailto: or https://");
}

/** The VAPID Authorization header for a push service (RFC 8292), valid for 12 hours. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const audience = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: keys.subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: vapidPrivateKey(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

export type PushResult =
  | { ok: true; status: number }
  /** gone: the subscription no longer exists (expired, unsubscribed) — forget it. */
  | { ok: false; status: number; gone: boolean; retryable: boolean; error: string };

/**
 * The push services browsers subscribe with: Google's FCM (Chrome, Opera, Samsung Internet, Brave),
 * Windows Notification Services (Edge on Windows), Mozilla's autopush (Firefox) and Apple (Safari).
 * Only these are sent to, so a subscription can't point the server at any other host — say, a
 * name that resolves to a private address.
 */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
];

/** An https endpoint on a known push service (default port, no credentials); anything else is refused before sending. */
export function isAcceptableEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((pattern) => pattern.test(host));
}

/**
 * Sends one encrypted push message. TTL keeps it queued at the push service while the device is
 * offline (up to a day); `topic` lets a newer message replace an undelivered older one.
 */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  options: { ttlSeconds?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  // Also checked here for subscriptions saved before the allow-list: they're forgotten, not sent to.
  if (!isAcceptableEndpoint(target.endpoint)) return { ok: false, status: 0, gone: true, retryable: false, error: "Not a known push service." };
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), "utf8"), target);
  const headers: Record<string, string> = {
    TTL: String(options.ttlSeconds ?? 24 * 60 * 60),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Urgency: options.urgency ?? "normal",
    Authorization: vapidAuthorization(target.endpoint, keys),
  };
  if (options.topic) headers.Topic = options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(target.endpoint, { method: "POST", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(15_000), redirect: "error" });
  } catch (error) {
    return { ok: false, status: 0, gone: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  const text = (await res.text().catch(() => "")).slice(0, 300);
  const gone = res.status === 404 || res.status === 410;
  // 413 (too large), 400 (malformed) and 401/403 (bad VAPID) won't succeed by retrying the same message.
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, status: res.status, gone, retryable, error: `${res.status} ${text}`.trim() };
}
