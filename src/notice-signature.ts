/**
 * Messages that come back in a URL after a redirect (?error= on sign-in, ?oauthError=,
 * ?discordError=) are signed by the server, and the request proxy (src/proxy.ts) drops any that
 * aren't, so a crafted link can't put someone else's words on a Forge page. Web Crypto only, so
 * the proxy and route handlers share it.
 */
export const NOTICE_PARAMS = ["error", "oauthError", "discordError"] as const;
export type NoticeParam = (typeof NOTICE_PARAMS)[number];
export const NOTICE_SIGNATURE_PARAM = "ns";

const encoder = new TextEncoder();

function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function payload(name: string, value: string) {
  return encoder.encode(`notice:${name}:${value}`);
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Adds a signed notice to an app URL (a path, or an absolute URL on this site). */
export async function withNotice(url: string, name: NoticeParam, value: string, secret: string): Promise<string> {
  const parsed = new URL(url, "https://forge.invalid");
  const text = value.slice(0, 300);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), payload(name, text)));
  parsed.searchParams.set(name, text);
  parsed.searchParams.set(NOTICE_SIGNATURE_PARAM, toBase64Url(signature));
  return parsed.origin === "https://forge.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}

/** Whether a URL's notice (if any) was signed by this server. One notice per URL. */
export async function noticeIsAuthentic(params: URLSearchParams, secret: string): Promise<boolean> {
  const present = NOTICE_PARAMS.filter((name) => params.has(name));
  if (present.length === 0) return true;
  const signature = fromBase64Url(params.get(NOTICE_SIGNATURE_PARAM) ?? "");
  if (present.length > 1 || params.getAll(present[0]!).length > 1 || !signature || !secret) return false;
  const name = present[0]!;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), signature, payload(name, params.get(name)!));
}
