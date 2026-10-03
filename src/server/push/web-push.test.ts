import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { b64url, encryptPayload, fromB64url, generateVapidKeys, isAcceptableEndpoint, validateVapidKeys, vapidAuthorization } from "./web-push";

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** What a browser does with a push message (RFC 8291 from the receiving side). */
function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString("utf8");
}

describe("web push", () => {
  it("encrypts exactly like RFC 8291's example", () => {
    const body = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { asPrivateKey: fromB64url(RFC.asPrivate), salt: fromB64url(RFC.salt) });
    expect(b64url(body)).toBe(RFC.body);
  });

  it("produces messages the browser can decrypt (fresh keys and salt each time)", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const target = { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
    const a = encryptPayload(Buffer.from('{"title":"Hi"}'), target);
    const b = encryptPayload(Buffer.from('{"title":"Hi"}'), target);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, ua.getPrivateKey(), ua.getPublicKey(), auth)).toBe('{"title":"Hi"}');
    expect(() => encryptPayload(Buffer.from("x"), { p256dh: "AAAA", auth: target.auth })).toThrow();
  });

  it("signs VAPID tokens the push service can verify", () => {
    const keys = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
    validateVapidKeys(keys);
    const header = vapidAuthorization("https://push.example.net/send/abc", keys, 1_700_000_000);
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = token!.split(".");
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ aud: "https://push.example.net", exp: 1_700_000_000 + 43_200, sub: "mailto:ops@example.com" });
    const point = fromB64url(keys.publicKey);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"))).toBe(true);
    expect(() => validateVapidKeys({ ...keys, publicKey: generateVapidKeys().publicKey })).toThrow(/match/);
    expect(() => validateVapidKeys({ ...keys, subject: "ops@example.com" })).toThrow(/mailto/);
  });

  it("only accepts https push-service endpoints", () => {
    expect(isAcceptableEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAcceptableEndpoint("https://wns2-par02p.notify.windows.com/w/?token=abc")).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://user:pw@push.example.com/x", "javascript:alert(1)", "https://intranet/x"]) {
      expect(isAcceptableEndpoint(bad)).toBe(false);
    }
  });
});
