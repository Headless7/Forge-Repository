import { NextResponse } from "next/server";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { OAUTH_COOKIE } from "@/server/auth/constants";
import { completeOAuth, decodeState, exchangeCode, oauthProvider } from "@/server/auth/oauth";
import { sessionTokenFrom } from "@/server/auth/route-session";
import { sessionCookie, validateSessionToken } from "@/server/auth/session";
import { safeEqual } from "@/server/auth/crypto";
import { appOrigin, env } from "@/server/env";
import { AppError } from "@/server/errors";
import { clientIp, userAgent } from "@/server/http";
import { withNotice } from "@/notice-signature";

export const dynamic = "force-dynamic";

async function fail(message: string) {
  const res = NextResponse.redirect(`${appOrigin()}${await withNotice("/sign-in", "error", message, env.AUTH_SECRET)}`);
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

  // Someone already signed in is connecting an account (Account → Security): the outcome is shown
  // where they started, not on the sign-in page.
  let connecting = false;
  try {
    const tokens = await exchangeCode(provider, code, state.verifier);
    const profile = await provider.fetchProfile(tokens.accessToken);
    const token = sessionTokenFrom(req);
    const current = token ? await validateSessionToken(token) : null;
    connecting = Boolean(current);
    // Discord's tokens are kept (encrypted) to refresh the profile later; Google's aren't needed.
    const { session, isNew } = await completeOAuth(provider.id, profile, current?.user.id ?? null, { ip: clientIp(req), userAgent: userAgent(req) }, provider.storeTokens ? tokens : null);
    const res = NextResponse.redirect(`${appOrigin()}${isNew ? "/onboarding" : connecting ? withParam(state.next, "connected", provider.id) : safeRedirectPath(state.next)}`);
    const cookie = sessionCookie(session.token, session.expiresAt);
    res.cookies.set(cookie.name, cookie.value, cookie.options);
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/oauth" });
    return res;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Sign-in failed. Please try again.";
    if (!connecting) return fail(message);
    const res = NextResponse.redirect(`${appOrigin()}${await withNotice(safeRedirectPath(state.next), "oauthError", message, env.AUTH_SECRET)}`);
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/auth/oauth" });
    return res;
  }
}

/** `next` is an app path (checked when the flow started); adds one query parameter to it. */
function withParam(next: string, key: string, value: string) {
  const url = new URL(safeRedirectPath(next), appOrigin());
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}
