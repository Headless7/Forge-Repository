import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { readBodyLimited } from "@/server/http";
import { sharedRateLimiter } from "@/server/rate-limit";
import { handleInteraction, type Interaction } from "@/server/services/discord-commands";
import { discordPublicKey, SIGNATURE_MAX_AGE_SECONDS, verifyDiscordSignature } from "@/server/services/discord-interactions";

export const dynamic = "force-dynamic";

const refuse = (status: number, message: string) => new Response(message, { status, headers: { "cache-control": "no-store" } });

/**
 * Discord's Interactions Endpoint URL: slash commands, button clicks, forms and autocomplete.
 * Signed by Discord (Ed25519); unsigned, stale, replayed or other applications' requests are refused.
 */
export async function POST(req: Request) {
  let body: Buffer;
  try {
    body = await readBodyLimited(req, 256 * 1024);
  } catch (error) {
    return refuse(error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, "Bad request");
  }
  const key = await discordPublicKey();
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";
  if (!key || !verifyDiscordSignature(key, signature, timestamp, body)) return refuse(401, "Invalid request signature");

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body.toString("utf8")) as Interaction;
  } catch {
    return refuse(400, "Bad request");
  }
  if (!interaction || typeof interaction.id !== "string" || typeof interaction.type !== "number") return refuse(400, "Bad request");
  if (env.DISCORD_APPLICATION_ID && interaction.application_id !== env.DISCORD_APPLICATION_ID) return refuse(401, "Wrong application");
  // Each interaction is answered once: the same signed request sent again is refused.
  if (interaction.type !== 1) {
    const first = await sharedRateLimiter.consume(`discord-interaction:${interaction.id.slice(0, 40)}`, 1, SIGNATURE_MAX_AGE_SECONDS * 2 * 1000);
    if (!first.ok) return refuse(401, "Already answered");
  }
  return Response.json(await handleInteraction(interaction), { headers: { "cache-control": "no-store" } });
}
