/**
 * Who may create studios. Forge is private: only the site operators (PLATFORM_ADMIN_EMAILS, with
 * a confirmed email) create studios freely; anyone else needs a one-time activation key an
 * operator issued. Joining an existing studio always goes through an Owner/Admin invitation.
 */
import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { hashToken } from "../auth/crypto";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { activationKeys, invitations, studios, users } from "../db/schema";
import { env } from "../env";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { enforceSharedRateLimit } from "../rate-limit";
import type { Actor } from "./context";

type UserRow = typeof users.$inferSelect;
type KeyRow = typeof activationKeys.$inferSelect;

export function isPlatformAdmin(user: Pick<UserRow, "email" | "emailVerifiedAt">): boolean {
  return Boolean(user.emailVerifiedAt) && env.PLATFORM_ADMIN_EMAILS.includes(user.email.toLowerCase());
}

/** Whether `email` is an operator's address (sign-up is open to it; powers still need the confirmed email). */
export function isPlatformAdminEmail(email: string): boolean {
  return env.PLATFORM_ADMIN_EMAILS.includes(email.toLowerCase());
}

/** Whether someone invited `email` to a studio and the invitation is still open. */
export async function hasPendingInvitation(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.email, email.toLowerCase()), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now())))
    .limit(1);
  return Boolean(row);
}

async function loadUser(userId: string, ex: Executor = db): Promise<UserRow> {
  const [user] = await ex.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("User");
  return user;
}

export async function requirePlatformAdmin(actor: Actor): Promise<UserRow> {
  const user = await loadUser(actor.userId);
  if (!isPlatformAdmin(user)) throw forbidden("Only the site operator can manage activation keys.");
  return user;
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** No 0/O, 1/I/L or U: keys are read aloud and retyped. 20 characters ≈ 98 bits. */
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const KEY_LENGTH = 20;
const DEFAULT_KEY_DAYS = 14;

function generateKey(): string {
  const chars = Array.from({ length: KEY_LENGTH }, () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]!);
  const groups = [];
  for (let i = 0; i < KEY_LENGTH; i += 5) groups.push(chars.slice(i, i + 5).join(""));
  return `FORGE-${groups.join("-")}`;
}

/** Case, spaces, dashes and the FORGE- prefix don't matter when a key is typed back in. */
export function normalizeKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^FORGE/, "");
}

const keyHash = (input: string) => hashToken(`activation:${normalizeKey(input)}`);

export type KeyStatus = "pending" | "claimed" | "redeemed" | "expired" | "revoked";

function keyStatus(row: KeyRow, at = now()): KeyStatus {
  if (row.revokedAt) return "revoked";
  if (row.redeemedAt) return "redeemed";
  if (row.expiresAt.getTime() <= at.getTime()) return "expired";
  return row.claimedById ? "claimed" : "pending";
}

export async function issueActivationKey(actor: Actor, input: { label: string; email?: string | null; expiresInDays?: number }) {
  await requirePlatformAdmin(actor);
  await enforceSharedRateLimit(`activation-issue:${actor.userId}`, 50, 60 * 60 * 1000);
  const key = generateKey();
  const days = input.expiresInDays ?? DEFAULT_KEY_DAYS;
  const [row] = await db
    .insert(activationKeys)
    .values({
      keyHash: keyHash(key),
      hint: key.slice(-4),
      label: input.label.trim(),
      email: input.email?.trim().toLowerCase() || null,
      createdById: actor.userId,
      expiresAt: new Date(now().getTime() + days * 24 * 60 * 60 * 1000),
    })
    .returning();
  // The key itself is shown once; only its hash is stored.
  return { key, id: row!.id, expiresAt: row!.expiresAt.toISOString() };
}

export async function listActivationKeys(actor: Actor) {
  await requirePlatformAdmin(actor);
  const rows = await db
    .select({ key: activationKeys, claimedEmail: users.email, studioName: studios.name, studioSlug: studios.slug })
    .from(activationKeys)
    .leftJoin(users, eq(users.id, activationKeys.claimedById))
    .leftJoin(studios, eq(studios.id, activationKeys.studioId))
    .orderBy(desc(activationKeys.createdAt))
    .limit(200);
  const at = now();
  return rows.map((r) => ({
    id: r.key.id,
    hint: r.key.hint,
    label: r.key.label,
    email: r.key.email,
    status: keyStatus(r.key, at),
    claimedBy: r.claimedEmail,
    studio: r.studioName ? { name: r.studioName, slug: r.studioSlug! } : null,
    createdAt: r.key.createdAt.toISOString(),
    expiresAt: r.key.expiresAt.toISOString(),
  }));
}

export async function revokeActivationKey(actor: Actor, input: { keyId: string }) {
  await requirePlatformAdmin(actor);
  const [row] = await db
    .update(activationKeys)
    .set({ revokedAt: now() })
    .where(and(eq(activationKeys.id, input.keyId), isNull(activationKeys.redeemedAt), isNull(activationKeys.revokedAt)))
    .returning();
  if (!row) throw conflict("That key was already used or revoked.");
  return { ok: true };
}

/**
 * Finds a key `email`'s account may still use, explaining clearly when it can't.
 * `userId` is the account checking (null while signing up).
 */
export async function findUsableKey(ex: Executor, input: string, email: string, userId: string | null): Promise<KeyRow> {
  if (!normalizeKey(input)) throw invalid("Enter your activation key.");
  const [row] = await ex.select().from(activationKeys).where(eq(activationKeys.keyHash, keyHash(input)));
  if (!row) throw invalid("That activation key isn't valid. Check it and try again.");
  const status = keyStatus(row);
  if (status === "revoked") throw invalid("That activation key was revoked.");
  if (status === "redeemed") throw invalid("That activation key has already been used.");
  if (status === "expired") throw invalid("That activation key has expired. Ask for a new one.");
  if (row.claimedById && row.claimedById !== userId) throw invalid("That activation key has already been used.");
  if (row.email && row.email !== email.toLowerCase()) throw invalid("That activation key was issued for a different email address.");
  return row;
}

/** The key an account registered with and hasn't redeemed yet (it creates their studio). */
export async function pendingKeyFor(userId: string, ex: Executor = db) {
  const [row] = await ex
    .select()
    .from(activationKeys)
    .where(
      and(
        eq(activationKeys.claimedById, userId),
        isNull(activationKeys.redeemedAt),
        isNull(activationKeys.revokedAt),
        gt(activationKeys.expiresAt, now()),
      ),
    )
    .orderBy(desc(activationKeys.claimedAt))
    .limit(1);
  return row ?? null;
}

/** Ties a key to a new account at sign-up, atomically: two sign-ups can't both take it. */
export async function claimKey(tx: Executor, key: KeyRow, userId: string) {
  const [claimed] = await tx
    .update(activationKeys)
    .set({ claimedById: userId, claimedAt: now() })
    .where(
      and(
        eq(activationKeys.id, key.id),
        isNull(activationKeys.claimedById),
        isNull(activationKeys.redeemedAt),
        isNull(activationKeys.revokedAt),
        gt(activationKeys.expiresAt, now()),
      ),
    )
    .returning();
  if (!claimed) throw conflict("That activation key has already been used.");
}

/** Marks a key used for `studioId`, atomically (a key creates exactly one studio). */
export async function redeemKey(tx: Executor, key: KeyRow, user: Pick<UserRow, "id" | "email">, studioId: string) {
  const [redeemed] = await tx
    .update(activationKeys)
    .set({ redeemedAt: now(), studioId, claimedById: user.id, claimedAt: key.claimedAt ?? now() })
    .where(
      and(
        eq(activationKeys.id, key.id),
        isNull(activationKeys.redeemedAt),
        isNull(activationKeys.revokedAt),
        gt(activationKeys.expiresAt, now()),
        or(isNull(activationKeys.claimedById), eq(activationKeys.claimedById, user.id)),
        or(isNull(activationKeys.email), eq(activationKeys.email, user.email.toLowerCase())),
      ),
    )
    .returning();
  if (!redeemed) throw conflict("That activation key has already been used.");
}

/** What the "no studio yet" screen offers this account. */
export async function accessStatus(userId: string) {
  const user = await loadUser(userId);
  const pending = await pendingKeyFor(userId);
  return {
    email: user.email,
    emailVerified: Boolean(user.emailVerifiedAt),
    platformAdmin: isPlatformAdmin(user),
    /** Studio creation needs no further key: operator, or a key claimed at sign-up. */
    canCreateStudio: isPlatformAdmin(user) || Boolean(pending && user.emailVerifiedAt),
    pendingKey: pending ? { hint: pending.hint, expiresAt: pending.expiresAt.toISOString() } : null,
  };
}

export { loadUser as loadPlatformUser };
