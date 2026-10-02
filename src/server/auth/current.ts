import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { Actor } from "../services/context";
import { SESSION_COOKIE, validateSessionToken, type ValidatedSession } from "./session";

/** Session for the current request (memoised per render). */
export const getSession = cache(async (): Promise<ValidatedSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(token);
});

/** For server components/pages: redirects to sign-in when there's no valid session. */
export async function requireSession(): Promise<ValidatedSession> {
  const session = await getSession();
  if (!session) {
    const path = (await headers()).get("x-forge-path") ?? "/";
    redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  }
  return session;
}

export function actorFor(session: ValidatedSession): Actor {
  return { userId: session.user.id, sessionId: session.session.id };
}
