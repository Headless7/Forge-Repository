/**
 * Video links copied from Discord. Discord's CDN serves attachments with a signed, expiring
 * address (`ex` = expiry, `is` = issued, `hm` = signature, all added by Discord), so a pasted
 * link can be played inline for about a day and then stops working until it's copied again.
 */
export const DISCORD_MEDIA_ORIGINS = ["https://cdn.discordapp.com", "https://media.discordapp.net"] as const;

const VIDEO_PATH = /^\/attachments\/\d+\/\d+\/[^/]+\.(mp4|webm|mov|m4v)$/i;

export interface DiscordVideoLink {
  url: string;
  filename: string;
  /** When Discord's signature stops working (ms since epoch), or null for an unsigned link. */
  expiresAt: number | null;
}

/** The Discord attachment video a URL points at, or null when it isn't one. */
export function discordVideoLink(url: string): DiscordVideoLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!(DISCORD_MEDIA_ORIGINS as readonly string[]).includes(parsed.origin)) return null;
  if (!VIDEO_PATH.test(parsed.pathname)) return null;
  const ex = parsed.searchParams.get("ex");
  const expiresAt = ex && /^[0-9a-f]{1,12}$/i.test(ex) ? parseInt(ex, 16) * 1000 : null;
  return { url: parsed.toString(), filename: decodeURIComponent(parsed.pathname.split("/").pop() ?? "video"), expiresAt };
}
