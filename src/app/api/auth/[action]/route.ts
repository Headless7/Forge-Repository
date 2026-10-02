import { NextResponse } from "next/server";
import { forgotPasswordSchema, resetPasswordSchema, signInSchema, signUpSchema } from "@/lib/validation";
import { sessionTokenFrom } from "@/server/auth/route-session";
import { clearedSessionCookie, sessionCookie, validateSessionToken } from "@/server/auth/session";
import { AppError, forbidden, notFound } from "@/server/errors";
import { clientIp, errorResponse, isTrustedOrigin, readJsonBody, userAgent } from "@/server/http";
import * as accounts from "@/server/services/accounts";
import { z } from "zod";

export const dynamic = "force-dynamic";

function withSession(body: unknown, session: { token: string; expiresAt: Date }) {
  const res = NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  const cookie = sessionCookie(session.token, session.expiresAt);
  res.cookies.set(cookie.name, cookie.value, cookie.options);
  return res;
}

export async function POST(req: Request, context: { params: Promise<{ action: string }> }) {
  try {
    if (!isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    const { action } = await context.params;
    const meta = { ip: clientIp(req), userAgent: userAgent(req) };
    // Unauthenticated: never buffer more than a small form needs.
    const body = await readJsonBody(req, 64 * 1024).catch((error: unknown) => {
      if (error instanceof AppError && error.code === "PAYLOAD_TOO_LARGE") throw error;
      return {};
    });

    switch (action) {
      case "sign-in": {
        const input = signInSchema.parse(body);
        const { session } = await accounts.signIn(input, meta);
        return withSession({ ok: true }, session);
      }
      case "sign-up": {
        const input = signUpSchema.parse(body);
        const { session } = await accounts.signUp(input, meta);
        return withSession({ ok: true }, session);
      }
      case "sign-out": {
        const token = sessionTokenFrom(req);
        if (token) {
          const current = await validateSessionToken(token);
          if (current) await accounts.signOut(current.session.id);
        }
        const res = NextResponse.json({ ok: true });
        const cleared = clearedSessionCookie();
        res.cookies.set(cleared.name, cleared.value, cleared.options);
        return res;
      }
      case "forgot-password": {
        const input = forgotPasswordSchema.parse(body);
        return NextResponse.json(await accounts.requestPasswordReset(input, meta));
      }
      case "resend-verification": {
        const input = forgotPasswordSchema.parse(body);
        return NextResponse.json(await accounts.resendVerificationByEmail(input, meta));
      }
      case "reset-password": {
        const input = resetPasswordSchema.parse(body);
        const { session } = await accounts.resetPassword(input, meta);
        return withSession({ ok: true }, session);
      }
      case "verify-email": {
        const input = z.object({ token: z.string().min(10).max(200) }).parse(body);
        return NextResponse.json(await accounts.verifyEmail(input.token));
      }
      default:
        throw notFound("Endpoint");
    }
  } catch (error) {
    return errorResponse(error);
  }
}
