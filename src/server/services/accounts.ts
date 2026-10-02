import { and, eq, gt, isNull } from "drizzle-orm";
import { USERNAME_PATTERN } from "@/lib/mentions";
import { dummyPasswordHash, generateToken, hashPassword, hashToken, verifyPassword } from "../auth/crypto";
import { createSession, invalidateSession, invalidateUserSessions, listUserSessions } from "../auth/session";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { authTokens, invitations, oauthAccounts, sessions, users } from "../db/schema";
import { appOrigin, env } from "../env";
import { AppError, conflict, forbidden, invalid, isUniqueViolation, notFound, rateLimited } from "../errors";
import { renderAvatar } from "../media/process";
import { enforceSharedRateLimit, sharedRateLimiter } from "../rate-limit";
import { avatarKey, storage } from "../storage";
import type { Actor } from "./context";
import { sendEmail } from "./email";
import { claimKey, findUsableKey, isPlatformAdminEmail } from "./platform";
import { avatarUrl } from "./users-lookup";

const AVATAR_COLORS = ["#7c6cf2", "#3b82f6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316"];
const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
const RESERVED_USERNAMES = new Set(["admin", "forge", "system", "support", "everyone", "here", "channel"]);

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function pickAvatarColor(seed: string) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export async function suggestUsername(base: string, ex: Executor = db): Promise<string> {
  const root = (base.toLowerCase().replace(/[^a-z0-9_]+/g, "").slice(0, 18) || "user").padEnd(2, "_");
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? root : `${root}${i + 1}`;
    if (RESERVED_USERNAMES.has(candidate)) continue;
    const rows = await ex.select({ id: users.id }).from(users).where(eq(users.username, candidate));
    if (!rows[0]) return candidate;
  }
  return `${root}${Date.now().toString(36).slice(-4)}`;
}

function assertUsername(username: string) {
  if (!USERNAME_PATTERN.test(username)) {
    throw invalid("Usernames are 2–24 characters: lowercase letters, numbers and underscores.");
  }
  if (RESERVED_USERNAMES.has(username)) throw invalid("That username is reserved.");
}

async function issueToken(ex: Executor, userId: string, email: string, purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET") {
  const token = generateToken();
  // Only the newest token of each kind stays valid.
  await ex
    .update(authTokens)
    .set({ usedAt: now() })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
  await ex.insert(authTokens).values({
    userId,
    email,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(now().getTime() + (purpose === "PASSWORD_RESET" ? RESET_TTL_MS : VERIFY_TTL_MS)),
  });
  return token;
}

/** `next`: a path to continue to once confirmed (e.g. the invitation they signed up from). */
async function sendVerification(ex: Executor, user: { id: string; email: string; displayName: string }, next?: string) {
  const token = await issueToken(ex, user.id, user.email, "EMAIL_VERIFICATION");
  const after = next ? `&next=${encodeURIComponent(next)}` : "";
  await sendEmail(ex, {
    to: user.email,
    template: "verify-email",
    subject: "Confirm your email for Forge",
    lines: [`Hi ${user.displayName}, confirm this address so your studio can reach you.`, "The link expires in 48 hours."],
    action: { label: "Confirm email", url: `${appOrigin()}/verify-email?token=${token}${after}` },
  });
}

// ── Sign up / sign in ───────────────────────────────────────────────────────

export async function signUp(
  input: { email: string; password: string; displayName: string; username?: string; inviteToken?: string; activationKey?: string },
  meta: RequestMeta,
) {
  // Per address when the client's IP is known (TRUSTED_PROXY_HOPS); otherwise one shared, larger budget.
  if (meta.ip) await enforceSharedRateLimit(`signup:${meta.ip}`, 20, 60 * 60 * 1000);
  else await enforceSharedRateLimit("signup:unknown-ip", 200, 60 * 60 * 1000);
  const email = normalizeEmail(input.email);
  const username = input.username?.trim().toLowerCase() || (await suggestUsername(input.displayName || email.split("@")[0]!));
  assertUsername(username);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing[0]) throw conflict("An account with this email already exists. Sign in instead.");

  // Forge is private: an account needs an invitation to this address, an activation key, or an
  // operator email. Either way the address still has to be confirmed before it unlocks anything.
  let key: Awaited<ReturnType<typeof findUsableKey>> | null = null;
  if (input.inviteToken) {
    const [invite] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, hashToken(input.inviteToken)), isNull(invitations.revokedAt), isNull(invitations.acceptedAt), gt(invitations.expiresAt, now())));
    if (!invite) throw invalid("This invitation is no longer valid. Ask a studio admin for a new one.");
    if (invite.email !== email) throw forbidden(`This invitation was sent to ${invite.email}. Create the account with that address.`);
  } else if (input.activationKey) {
    key = await findUsableKey(db, input.activationKey, email, null);
  } else if (!isPlatformAdminEmail(email)) {
    throw new AppError("FORBIDDEN", "You need an invitation or an activation key to create an account here.", { code: "INVITE_REQUIRED" });
  }

  const passwordHash = await hashPassword(input.password);
  try {
    const user = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          email,
          username,
          displayName: input.displayName.trim(),
          passwordHash,
          avatarColor: pickAvatarColor(email),
        })
        .returning();
      if (key) await claimKey(tx, key, row!.id);
      await sendVerification(tx, row!, input.inviteToken ? `/invite/${input.inviteToken}` : undefined);
      return row!;
    });
    const session = await createSession(user.id, meta);
    return { user, session };
  } catch (error) {
    if (isUniqueViolation(error, "users_username_uq")) throw conflict("That username is taken. Try another.");
    if (isUniqueViolation(error, "users_email_uq")) throw conflict("An account with this email already exists.");
    throw error;
  }
}

const SIGNIN_FAILURES = { limit: 10, windowMs: 15 * 60 * 1000 };
/** Failures per account from any address: password guessing spread over many IPs still stops. */
const ACCOUNT_FAILURES = { limit: 30, windowMs: 15 * 60 * 1000 };

export async function signIn(input: { email: string; password: string }, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  // Broad per-IP cap on all attempts (when the IP is known); lockouts count only failures.
  if (meta.ip) await enforceSharedRateLimit(`signin:ip:${meta.ip}`, 300, 10 * 60 * 1000);
  const failureKey = `signin-fail:${meta.ip ?? "unknown"}:${email}`;
  const accountKey = `signin-fail:account:${email}`;
  for (const [key, limit] of [
    [failureKey, SIGNIN_FAILURES.limit],
    [accountKey, ACCOUNT_FAILURES.limit],
  ] as const) {
    const budget = await sharedRateLimiter.check(key, limit);
    if (!budget.ok) throw rateLimited(budget.retryAfterMs);
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  // Hash even for unknown accounts so response timing doesn't reveal which emails exist.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? (await dummyPasswordHash()));
  if (!user || !user.passwordHash || !valid) {
    await sharedRateLimiter.consume(failureKey, SIGNIN_FAILURES.limit, SIGNIN_FAILURES.windowMs);
    await sharedRateLimiter.consume(accountKey, ACCOUNT_FAILURES.limit, ACCOUNT_FAILURES.windowMs);
    throw new AppError("UNAUTHORIZED", "Incorrect email or password.");
  }
  if (env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
    throw new AppError("FORBIDDEN", "Please confirm your email address first. Check your inbox for the link.", { code: "EMAIL_NOT_VERIFIED" });
  }
  const session = await createSession(user.id, meta);
  return { user, session };
}

export async function signOut(sessionId: string) {
  await invalidateSession(sessionId);
}

// ── Email verification ──────────────────────────────────────────────────────

/** `next`: an invitation path to return to once confirmed. */
export async function resendVerification(actor: Actor, next?: string) {
  await enforceSharedRateLimit(`verify-resend:${actor.userId}`, 5, 60 * 60 * 1000);
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  await db.transaction((tx) => sendVerification(tx, user, next && /^\/invite\/[A-Za-z0-9_-]+$/.test(next) ? next : undefined));
  return { alreadyVerified: false };
}

/** Signed-out route to a new link (sign-in refuses unconfirmed accounts). Same answer whether or not the account exists. */
export async function resendVerificationByEmail(input: { email: string }, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  if (meta.ip) await enforceSharedRateLimit(`verify-resend:ip:${meta.ip}`, 10, 60 * 60 * 1000);
  await enforceSharedRateLimit(`verify-resend:email:${email}`, 5, 60 * 60 * 1000);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (user && !user.emailVerifiedAt) await db.transaction((tx) => sendVerification(tx, user));
  return { ok: true };
}

export async function verifyEmail(token: string) {
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.purpose, "EMAIL_VERIFICATION")));
  if (!row || row.usedAt || row.expiresAt.getTime() < now().getTime()) {
    throw invalid("This confirmation link is invalid or has expired. Sign in to get a new one.");
  }
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(authTokens)
      .set({ usedAt: now() })
      .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt)))
      .returning({ id: authTokens.id });
    if (!claimed.length) return; // a concurrent request already used it (same outcome)
    await tx
      .update(users)
      .set({ emailVerifiedAt: now() })
      .where(and(eq(users.id, row.userId), eq(users.email, row.email)));
  });
  return { ok: true };
}

// ── Password reset ──────────────────────────────────────────────────────────

/** Always succeeds from the caller's point of view so accounts can't be enumerated. */
export async function requestPasswordReset(input: { email: string }, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  if (meta.ip) await enforceSharedRateLimit(`reset:${meta.ip}`, 10, 60 * 60 * 1000);
  await enforceSharedRateLimit(`reset:${email}`, 5, 60 * 60 * 1000);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (user) {
    await db.transaction(async (tx) => {
      const token = await issueToken(tx, user.id, user.email, "PASSWORD_RESET");
      await sendEmail(tx, {
        to: user.email,
        template: "password-reset",
        subject: "Reset your Forge password",
        lines: [
          `Hi ${user.displayName}, we received a request to reset your password.`,
          "The link expires in 1 hour. If you didn't ask for this, you can ignore this email.",
        ],
        action: { label: "Choose a new password", url: `${appOrigin()}/reset-password?token=${token}` },
      });
    });
  }
  return { ok: true };
}

export async function resetPassword(input: { token: string; password: string }, meta: RequestMeta) {
  await enforceSharedRateLimit(meta.ip ? `reset-apply:${meta.ip}` : "reset-apply:unknown-ip", meta.ip ? 20 : 200, 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.tokenHash, hashToken(input.token)), eq(authTokens.purpose, "PASSWORD_RESET")));
  if (!row || row.usedAt || row.expiresAt.getTime() < now().getTime()) {
    throw invalid("This reset link is invalid or has expired. Request a new one.");
  }
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    // Claim the token atomically: two requests racing with the same link can't both use it.
    const claimed = await tx
      .update(authTokens)
      .set({ usedAt: now() })
      .where(and(eq(authTokens.id, row.id), isNull(authTokens.usedAt)))
      .returning({ id: authTokens.id });
    if (!claimed.length) throw invalid("This reset link has already been used. Request a new one.");
    await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
    // Resetting via email also proves the address — but only the address the link was sent to
    // (the account's email may have changed since, and confirmed email is what grants access).
    await tx.update(users).set({ emailVerifiedAt: now() }).where(and(eq(users.id, row.userId), eq(users.email, row.email), isNull(users.emailVerifiedAt)));
  });
  await invalidateUserSessions(row.userId);
  const session = await createSession(row.userId, meta);
  return { session };
}

// ── Profile & security ──────────────────────────────────────────────────────

export async function getProfile(actor: Actor) {
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  const linked = await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, user.id));
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    username: user.username,
    displayName: user.displayName,
    avatarUrl: await avatarUrl(user.avatarKey),
    avatarColor: user.avatarColor,
    theme: user.themePreference,
    hasPassword: Boolean(user.passwordHash),
    oauth: linked.map((a) => ({ provider: a.provider, username: a.providerUsername })),
    oauthProviders: {
      discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
  };
}

export async function updateProfile(
  actor: Actor,
  input: { displayName?: string; username?: string; theme?: "dark" | "light" | "system" },
) {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.displayName !== undefined) {
    if (!input.displayName.trim()) throw invalid("Display name can't be empty.");
    patch.displayName = input.displayName.trim();
  }
  if (input.username !== undefined) {
    const username = input.username.trim().toLowerCase();
    assertUsername(username);
    patch.username = username;
  }
  if (input.theme !== undefined) patch.themePreference = input.theme;
  try {
    await db.update(users).set(patch).where(eq(users.id, actor.userId));
  } catch (error) {
    if (isUniqueViolation(error, "users_username_uq")) throw conflict("That username is taken.");
    throw error;
  }
  return getProfile(actor);
}

export async function changeEmail(actor: Actor, input: { email: string; password?: string }) {
  await enforceSharedRateLimit(`email-change:${actor.userId}`, 5, 60 * 60 * 1000);
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  if (user.passwordHash && !(await verifyPassword(input.password ?? "", user.passwordHash))) {
    throw invalid("Your current password is incorrect.");
  }
  const email = normalizeEmail(input.email);
  if (email === user.email) return getProfile(actor);
  try {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ email, emailVerifiedAt: null }).where(eq(users.id, user.id));
      // Reset links mailed to the old address stop working.
      await tx
        .update(authTokens)
        .set({ usedAt: now() })
        .where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, "PASSWORD_RESET"), isNull(authTokens.usedAt)));
      await sendVerification(tx, { ...user, email });
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_uq")) throw conflict("That email is already used by another account.");
    throw error;
  }
  return getProfile(actor);
}

export async function changePassword(actor: Actor, input: { currentPassword?: string; newPassword: string }) {
  await enforceSharedRateLimit(`password-change:${actor.userId}`, 10, 60 * 60 * 1000);
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  if (user.passwordHash && !(await verifyPassword(input.currentPassword ?? "", user.passwordHash))) {
    throw invalid("Your current password is incorrect.");
  }
  await db.update(users).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(users.id, user.id));
  // Sign out every other device.
  await invalidateUserSessions(user.id, actor.sessionId ?? undefined);
  return { ok: true };
}

export async function setAvatar(actor: Actor, buffer: Buffer | null) {
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  let key: string | null = null;
  if (buffer) {
    const image = await renderAvatar(buffer);
    key = avatarKey(user.id, Date.now().toString(36));
    await storage().put(key, image, "image/webp");
  }
  await db.update(users).set({ avatarKey: key }).where(eq(users.id, user.id));
  if (user.avatarKey) await storage().delete(user.avatarKey).catch(() => {});
  return getProfile(actor);
}

export async function listSessions(actor: Actor) {
  const rows = await listUserSessions(actor.userId);
  return rows
    .map((s) => ({
      id: s.id,
      current: s.id === actor.sessionId,
      createdAt: s.createdAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    }))
    .reverse();
}

export async function revokeSession(actor: Actor, input: { sessionId?: string; allOthers?: boolean }) {
  if (input.allOthers) {
    await invalidateUserSessions(actor.userId, actor.sessionId ?? undefined);
  } else if (input.sessionId) {
    await db.delete(sessions).where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, actor.userId)));
  }
  return listSessions(actor);
}
