import { NextResponse } from "next/server";
import { OAUTH_COOKIE } from "@/server/auth/constants";
import { oauthProvider, startAuthorization } from "@/server/auth/oauth";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { withNotice } from "@/notice-signature";
import { appOrigin, env } from "@/server/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: id } = await context.params;
  const provider = oauthProvider(id);
  const url = new URL(req.url);
  if (!provider) {
    return NextResponse.redirect(`${appOrigin()}${await withNotice("/sign-in", "error", "That sign-in method isn't configured.", env.AUTH_SECRET)}`);
  }
  const { url: authorizeUrl, cookie } = startAuthorization(provider, safeRedirectPath(url.searchParams.get("next")));
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
