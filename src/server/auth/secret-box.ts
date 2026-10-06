import crypto from "node:crypto";
import { env } from "../env";

/**
 * Encrypts secrets kept in the database (OAuth tokens) with AES-256-GCM, under a key derived from
 * AUTH_SECRET. A database leak alone doesn't reveal them. If AUTH_SECRET changes, stored values
 * can't be opened any more: callers treat them as missing (people are asked to reconnect).
 */
function key(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", env.AUTH_SECRET, "forge", "secret-box:v1", 32));
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** The plain value, or null when there's none or it can't be opened (tampered, or another key). */
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
