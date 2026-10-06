/**
 * Discord calls Forge for slash commands and button clicks (POST /api/discord/interactions).
 * Every request is signed with the application's Ed25519 key; anything that isn't — or is older
 * than a few minutes, or was already answered — is refused before it's read.
 */
import "server-only";
import crypto from "node:crypto";
import { env } from "../env";
import { discordApi } from "./discord";

/** How far a request's timestamp may be from now (Discord answers within seconds). */
export const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

/** Whether `body` was signed by the application's key at `timestamp` (Discord's X-Signature-* headers). */
export function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: Buffer, nowMs = Date.now()): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") }, format: "jwk" });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp, "utf8"), body]), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

const g = globalThis as unknown as { __forgeDiscordPublicKey?: { key: string; at: number } };
const KEY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The application's public key: DISCORD_PUBLIC_KEY when set, otherwise read from Discord with the
 * bot token (and remembered for a few hours). Null when Discord isn't set up.
 */
export async function discordPublicKey(): Promise<string | null> {
  if (env.DISCORD_PUBLIC_KEY) return env.DISCORD_PUBLIC_KEY;
  const cached = g.__forgeDiscordPublicKey;
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.key;
  if (!env.DISCORD_BOT_TOKEN) return null;
  const res = await discordApi<{ verify_key?: string }>("/applications/@me");
  const key = res.data?.verify_key;
  if (!res.ok || !key || !/^[0-9a-f]{64}$/i.test(key)) return cached?.key ?? null;
  g.__forgeDiscordPublicKey = { key, at: Date.now() };
  return key;
}
