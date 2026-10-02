import type { NextResponse } from "next/server";
import { unauthorized } from "../errors";
import { clientIp, userAgent } from "../http";
import type { Actor } from "../services/context";
import { SESSION_COOKIE, sessionCookie, validateSessionToken, type ValidatedSession } from "./session";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionTokenFrom(req: Request): string | null {
  return readCookie(req, SESSION_COOKIE);
}

/** Validates the session cookie for API routes; throws UNAUTHORIZED when missing/expired. */
export async function requireRouteSession(req: Request): Promise<{ session: ValidatedSession; actor: Actor; token: string }> {
  const token = sessionTokenFrom(req);
  const session = token ? await validateSessionToken(token) : null;
  if (!session || !token) throw unauthorized();
  return {
    session,
    token,
    actor: {
      userId: session.user.id,
      sessionId: session.session.id,
      ip: clientIp(req),
      userAgent: userAgent(req),
      clientId: req.headers.get("x-client-id")?.slice(0, 64) ?? null,
    },
  };
}

/** Re-issues the cookie when the session's sliding expiry was extended. */
export function applySessionRenewal(res: NextResponse, session: ValidatedSession, token: string) {
  if (!session.renewed) return;
  const cookie = sessionCookie(token, session.session.expiresAt);
  res.cookies.set(cookie.name, cookie.value, cookie.options);
}
