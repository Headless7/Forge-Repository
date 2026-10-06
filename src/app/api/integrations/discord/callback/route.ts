import { NextResponse } from "next/server";
import { sessionTokenFrom } from "@/server/auth/route-session";
import { validateSessionToken } from "@/server/auth/session";
import { appOrigin, env } from "@/server/env";
import { AppError } from "@/server/errors";
import { clientIp, userAgent } from "@/server/http";
import { completeDiscordConnect, DISCORD_STATE_COOKIE, studioSlugForConnectState } from "@/server/services/discord";
import { withNotice } from "@/notice-signature";

export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string) {
  const raw = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return raw ? decodeURIComponent(raw) : null;
}

/** Discord sends people back here after "Add to server" (or cancelling it). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cookie = readCookie(req, DISCORD_STATE_COOKIE);
  const slug = await studioSlugForConnectState(cookie);
  const settings = slug ? `/${slug}/settings` : "/";
  // Success is a fixed word; an error message is signed so the page can trust it.
  const done = async (outcome: { error: string } | "connected") => {
    const target = outcome === "connected" ? `${settings}?discord=connected#discord` : await withNotice(`${settings}#discord`, "discordError", outcome.error, env.AUTH_SECRET);
    const res = NextResponse.redirect(`${appOrigin()}${target}`);
    res.cookies.delete({ name: DISCORD_STATE_COOKIE, path: "/api/integrations/discord" });
    return res;
  };
  if (url.searchParams.get("error")) return done({ error: "Connecting Discord was cancelled." });
  try {
    const token = sessionTokenFrom(req);
    const current = token ? await validateSessionToken(token) : null;
    await completeDiscordConnect(
      { userId: current?.user.id ?? null, cookie, state: url.searchParams.get("state"), code: url.searchParams.get("code") },
      { ip: clientIp(req), userAgent: userAgent(req) },
    );
    return done("connected");
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Couldn't connect Discord. Please try again.";
    return done({ error: message });
  }
}
