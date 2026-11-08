import type { NextResponse } from "next/server";
import { AppError, unauthorized } from "../errors";
import { clientIp, userAgent } from "../http";
import type { Actor } from "../services/context";
import { validateApiToken, type ApiTokenRejection, type ApiTokenRow } from "./api-tokens";
import { SESSION_COOKIE, sessionCookie, validateSessionToken, type SessionUser, type ValidatedSession } from "./session";

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

/** The token from `Authorization: Bearer …`, when the request carries one (other schemes are ignored). */
export function bearerTokenFrom(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join("");
  return token || null;
}

const TOKEN_REFUSALS: Record<ApiTokenRejection, string> = {
  unknown: "Invalid API token.",
  revoked: "This API token was revoked.",
  expired: "This API token has expired.",
};

/**
 * Validates an API token for API routes; throws UNAUTHORIZED when unknown, revoked or expired.
 * The actor is the member the token acts as, marked with the token id for auditing.
 */
export async function requireRouteToken(req: Request, raw: string): Promise<{ token: ApiTokenRow; user: SessionUser; actor: Actor }> {
  const ip = clientIp(req);
  const agent = userAgent(req);
  const result = await validateApiToken(raw, { ip, userAgent: agent });
  if (!result.ok) throw new AppError("UNAUTHORIZED", TOKEN_REFUSALS[result.reason]);
  return {
    token: result.token,
    user: result.user,
    actor: { userId: result.user.id, tokenId: result.token.id, ip, userAgent: agent, clientId: null },
  };
}

/** Re-issues the cookie when the session's sliding expiry was extended. */
export function applySessionRenewal(res: NextResponse, session: ValidatedSession, token: string) {
  if (!session.renewed) return;
  const cookie = sessionCookie(token, session.session.expiresAt);
  res.cookies.set(cookie.name, cookie.value, cookie.options);
}
