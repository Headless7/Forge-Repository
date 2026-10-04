import { NextResponse } from "next/server";
import { sessionTokenFrom } from "@/server/auth/route-session";
import { validateSessionToken } from "@/server/auth/session";
import { appOrigin, env } from "@/server/env";
import { AppError } from "@/server/errors";
import { beginDiscordConnect, DISCORD_STATE_COOKIE } from "@/server/services/discord";

export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "Connect Discord" in studio settings: sends an Admin or the Owner to Discord's "Add to server" screen. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const studioId = url.searchParams.get("studioId") ?? "";
  const studioSlug = url.searchParams.get("studio") ?? "";
  const back = SLUG.test(studioSlug) ? `/${studioSlug}/settings` : "/";
  const token = sessionTokenFrom(req);
  const current = token ? await validateSessionToken(token) : null;
  if (!current) return NextResponse.redirect(`${appOrigin()}/sign-in?next=${encodeURIComponent(back)}`);
  try {
    const { url: authorizeUrl, cookie } = await beginDiscordConnect(current.user.id, studioId);
    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(DISCORD_STATE_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.APP_URL.startsWith("https://"),
      path: "/api/integrations/discord",
      maxAge: 10 * 60,
    });
    return res;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Couldn't start connecting Discord. Please try again.";
    return NextResponse.redirect(`${appOrigin()}${back}?discordError=${encodeURIComponent(message)}#discord`);
  }
}
