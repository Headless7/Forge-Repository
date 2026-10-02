import { NextResponse } from "next/server";
import { OAUTH_COOKIE } from "@/server/auth/constants";
import { oauthProvider, startAuthorization } from "@/server/auth/oauth";
import { appOrigin, env } from "@/server/env";

export const dynamic = "force-dynamic";

function safeNext(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: id } = await context.params;
  const provider = oauthProvider(id);
  const url = new URL(req.url);
  if (!provider) {
    return NextResponse.redirect(`${appOrigin()}/sign-in?error=${encodeURIComponent("That sign-in method isn't configured.")}`);
  }
  const { url: authorizeUrl, cookie } = startAuthorization(provider, safeNext(url.searchParams.get("next")));
  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https://"),
    path: "/api/auth/oauth",
    maxAge: 10 * 60,
  });
  return res;
}
