import { eq } from "drizzle-orm";
import { API_TOKEN_PREFIX } from "@/lib/api-tokens";
import { getProjectAccess } from "../access";
import { now } from "../clock";
import { db } from "../db";
import { apiTokens, forumItems, forums, users } from "../db/schema";
import { forbidden, notFound } from "../errors";
import { rateLimiter } from "../rate-limit";
import type { ScopeRef } from "../rpc/procedure";
import { audit } from "../services/activity";
import { generateToken, hashToken } from "./crypto";
import type { SessionUser } from "./session";

export type ApiTokenRow = typeof apiTokens.$inferSelect;

/** How often "last used" is written back (the bot calls every few hours; a tight loop would hammer the row). */
const LAST_USED_THROTTLE_MS = 60 * 1000;
/** A revoked or expired token presented repeatedly leaves one audit entry per token per window. */
const REJECTED_AUDIT_WINDOW_MS = 10 * 60 * 1000;

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + generateToken(32);
}

export function apiTokenHint(raw: string): string {
  return raw.slice(-4);
}

export function isApiTokenShaped(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX) && value.length >= API_TOKEN_PREFIX.length + 32 && value.length <= 200;
}

export type ApiTokenRejection = "unknown" | "revoked" | "expired";

export type ApiTokenValidation = { ok: true; token: ApiTokenRow; user: SessionUser } | { ok: false; reason: ApiTokenRejection };

/**
 * Looks a raw token up by its hash. A revoked or expired token is refused and (throttled) recorded in
 * the studio's audit log, so admins see a client still trying to use it.
 */
export async function validateApiToken(raw: string, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<ApiTokenValidation> {
  if (!isApiTokenShaped(raw)) return { ok: false, reason: "unknown" };
  const rows = await db
    .select({
      token: apiTokens,
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
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hashToken(raw)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "unknown" };

  const current = now();
  const reason: ApiTokenRejection | null = row.token.revokedAt ? "revoked" : row.token.expiresAt.getTime() <= current.getTime() ? "expired" : null;
  if (reason) {
    if (rateLimiter.consume(`api-token-rejected:${row.token.id}`, 1, REJECTED_AUDIT_WINDOW_MS).ok) {
      await audit(db, { userId: row.token.userId, ip: meta.ip, userAgent: meta.userAgent }, {
        studioId: row.token.studioId,
        action: "api_token.rejected",
        targetType: "api_token",
        targetId: row.token.id,
        data: { name: row.token.name, hint: row.token.hint, reason },
      });
    }
    return { ok: false, reason };
  }
  return { ok: true, token: row.token, user: row.user };
}

/** Records that the token was used, at most once a minute. */
export async function touchApiToken(token: ApiTokenRow) {
  const current = now();
  if (token.lastUsedAt && current.getTime() - token.lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
  await db.update(apiTokens).set({ lastUsedAt: current }).where(eq(apiTokens.id, token.id));
}

/**
 * Resolves what a call is about to a project and refuses it outside the token's scope. Ids the bot
 * member can't see fail with NOT_FOUND, as everywhere else, so a token can't probe other studios.
 */
export async function assertApiTokenScope(token: ApiTokenRow, ref: ScopeRef): Promise<void> {
  let projectId: string;
  if ("projectId" in ref) {
    projectId = ref.projectId;
  } else if ("forumId" in ref) {
    const [forum] = await db.select({ projectId: forums.projectId }).from(forums).where(eq(forums.id, ref.forumId)).limit(1);
    if (!forum) throw notFound("Forum");
    projectId = forum.projectId;
  } else {
    const [item] = await db.select({ projectId: forumItems.projectId }).from(forumItems).where(eq(forumItems.id, ref.itemId)).limit(1);
    if (!item) throw notFound("Item");
    projectId = item.projectId;
  }
  const access = await getProjectAccess(token.userId, projectId);
  if (!access) throw notFound("Project");
  if (access.studioId !== token.studioId || !token.projectIds.includes(projectId)) {
    throw forbidden("This token isn't allowed to touch that project.");
  }
}
