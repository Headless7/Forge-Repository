import { NextResponse } from "next/server";
import { OAUTH_COOKIE } from "@/server/auth/constants";
import { completeOAuth, decodeState, exchangeCode, oauthProvider } from "@/server/auth/oauth";
import { sessionTokenFrom } from "@/server/auth/route-session";
import { sessionCookie, validateSessionToken } from "@/server/auth/session";
import { safeEqual } from "@/server/auth/crypto";
import { appOrigin } from "@/server/env";
import { AppError } from "@/server/errors";
import { clientIp, userAgent } from "@/server/http";

export const dynamic = "force-dynamic";

function fail(message: string) {
  const res = NextResponse.redirect(`${appOrigin()}/sign-in?error=${encodeURIComponent(message)}`);
  res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/oauth" });
  return res;
}

export async function GET(req: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: id } = await context.params;
  const provider = oauthProvider(id);
  if (!provider) return fail("That sign-in method isn't configured.");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const cookieHeader = req.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${OAUTH_COOKIE}=`))
    ?.slice(OAUTH_COOKIE.length + 1);
  const state = decodeState(raw ? decodeURIComponent(raw) : null);

  if (!code || !returnedState || !state || state.provider !== provider.id || !safeEqual(state.state, returnedState)) {
    return fail("Sign-in expired or was tampered with. Please try again.");
  }

  try {
    const accessToken = await exchangeCode(provider, code, state.verifier);
    const profile = await provider.fetchProfile(accessToken);
    const token = sessionTokenFrom(req);
    const current = token ? await validateSessionToken(token) : null;
    const { session, isNew } = await completeOAuth(provider.id, profile, current?.user.id ?? null, {
      ip: clientIp(req),
      userAgent: userAgent(req),
    });
    const res = NextResponse.redirect(`${appOrigin()}${isNew ? "/onboarding" : state.next}`);
    const cookie = sessionCookie(session.token, session.expiresAt);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/oauth" });
    return res;
  } catch (error) {
    return fail(error instanceof AppError ? error.message : "Sign-in failed. Please try again.");
  }
}
