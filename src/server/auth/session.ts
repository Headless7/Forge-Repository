import { and, eq, gt, ne, sql } from "drizzle-orm";
import { now } from "../clock";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import { env } from "../env";
import { SESSION_COOKIE } from "./constants";
import { generateToken, hashToken } from "./crypto";

export { SESSION_COOKIE };
const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY;
/** Sessions are extended (sliding expiry) once less than this much time remains. */
const RENEW_WHEN_REMAINING_MS = 15 * DAY;
const SEEN_THROTTLE_MS = 60 * 1000;

export type SessionUser = Pick<
  typeof users.$inferSelect,
  | "id"
  | "email"
  | "username"
  | "displayName"
  | "avatarKey"
  | "avatarColor"
  | "emailVerifiedAt"
  | "themePreference"
  | "lastStudioId"
  | "passwordHash"
>;

export interface ValidatedSession {
  session: { id: string; userId: string; expiresAt: Date };
  user: SessionUser;
  /** True when expiry was extended and the cookie should be re-issued. */
  renewed: boolean;
}

export async function createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  const token = generateToken();
  const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 400) ?? null,
  });
  return { token, expiresAt };
}

export async function validateSessionToken(token: string): Promise<ValidatedSession | null> {
  if (!token || token.length > 200) return null;
  const id = hashToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastActiveAt: sessions.lastActiveAt,
      user: {
        id: users.id,
        email: users.email,
        username: users.username,
        displayName: users.displayName,
        avatarKey: users.avatarKey,
        avatarColor: users.avatarColor,
        emailVerifiedAt: users.emailVerifiedAt,
        themePreference: users.themePreference,
        lastStudioId: users.lastStudioId,
        passwordHash: users.passwordHash,
      },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const current = now();
  if (row.expiresAt.getTime() <= current.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  let expiresAt = row.expiresAt;
  let renewed = false;
  if (expiresAt.getTime() - current.getTime() < RENEW_WHEN_REMAINING_MS) {
    expiresAt = new Date(current.getTime() + SESSION_TTL_MS);
    renewed = true;
    await db.update(sessions).set({ expiresAt, lastActiveAt: current }).where(eq(sessions.id, id));
  } else if (current.getTime() - row.lastActiveAt.getTime() > SEEN_THROTTLE_MS) {
    // Presence: cheap, throttled "last seen" bookkeeping.
    await Promise.all([
      db.update(sessions).set({ lastActiveAt: current }).where(eq(sessions.id, id)),
      db.update(users).set({ lastSeenAt: current }).where(eq(users.id, row.user.id)),
    ]);
  }

  return { session: { id, userId: row.user.id, expiresAt }, user: row.user, renewed };
}

export async function invalidateSession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function invalidateUserSessions(userId: string, exceptSessionId?: string) {
  await db
    .delete(sessions)
    .where(exceptSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)) : eq(sessions.userId, userId));
}

export async function listUserSessions(userId: string) {
  return db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastActiveAt: sessions.lastActiveAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, sql`now()`)))
    .orderBy(sessions.lastActiveAt);
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: env.APP_URL.startsWith("https://"),
      path: "/",
      expires: expiresAt,
    },
  };
}

export function clearedSessionCookie() {
  return {
    name: SESSION_COOKIE,
    value: "",
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: env.APP_URL.startsWith("https://"),
      path: "/",
      maxAge: 0,
    },
  };
}
