/**
 * Scoped API tokens for headless clients (see lib/api-tokens). Managed by studio admins
 * (`tokens.manage`); a token acts as the bot member it was issued for and never widens what that
 * member could already do. Only the hash is stored; the raw token is returned once.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { API_TOKEN_MAX_DAYS, apiTokenStatus, isApiTokenProcedure, type ApiTokenProcedure, type ApiTokenStatus } from "@/lib/api-tokens";
import { roleHas } from "@/lib/permissions";
import type { UserDTO } from "@/lib/types";
import { getProjectAccess, getStudioAccess, requireStudio } from "../access";
import { apiTokenHint, generateApiToken, type ApiTokenRow } from "../auth/api-tokens";
import { hashToken } from "../auth/crypto";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { apiTokens, projects } from "../db/schema";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { enforceSharedRateLimit } from "../rate-limit";
import { audit } from "./activity";
import type { Actor } from "./context";
import { loadUsers, toUserDTO } from "./users-lookup";

const DAY = 24 * 60 * 60 * 1000;

export interface ApiTokenDTO {
  id: string;
  name: string;
  /** Last characters of the token, never the token itself. */
  hint: string;
  /** The member the token acts as. */
  user: UserDTO | null;
  procedures: ApiTokenProcedure[];
  projects: Array<{ id: string; name: string; icon: string }>;
  createdBy: UserDTO | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: ApiTokenStatus;
}

export interface CreateApiTokenInput {
  studioId: string;
  userId: string;
  name: string;
  procedures: ApiTokenProcedure[];
  projectIds: string[];
  expiresInDays: number;
}

/** What the admin gets back exactly once. */
export interface IssuedApiToken {
  id: string;
  token: string;
  expiresAt: string;
}

type ProjectRef = { id: string; name: string; icon: string };

async function toDTOs(rows: ApiTokenRow[]): Promise<ApiTokenDTO[]> {
  const userIds = rows.flatMap((r) => [r.userId, ...(r.createdById ? [r.createdById] : [])]);
  const projectIds = [...new Set(rows.flatMap((r) => r.projectIds))];
  const [userMap, projectRows] = await Promise.all([
    loadUsers(userIds),
    projectIds.length ? db.select({ id: projects.id, name: projects.name, icon: projects.icon }).from(projects).where(inArray(projects.id, projectIds)) : Promise.resolve([]),
  ]);
  const projectMap = new Map(projectRows.map((p) => [p.id, p]));
  const at = now();
  return Promise.all(
    rows.map(async (r) => {
      const user = userMap.get(r.userId);
      const creator = r.createdById ? userMap.get(r.createdById) : undefined;
      return {
        id: r.id,
        name: r.name,
        hint: r.hint,
        user: user ? await toUserDTO(user) : null,
        procedures: r.procedures.filter(isApiTokenProcedure),
        projects: r.projectIds.map((id) => projectMap.get(id)).filter((p): p is ProjectRef => Boolean(p)),
        createdBy: creator ? await toUserDTO(creator) : null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        status: apiTokenStatus(r, at),
      };
    }),
  );
}

export async function listApiTokens(actor: Actor, studioId: string): Promise<ApiTokenDTO[]> {
  await requireStudio(actor.userId, studioId, "tokens.manage");
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.studioId, studioId)).orderBy(desc(apiTokens.createdAt)).limit(200);
  return toDTOs(rows);
}

/** The token, once the caller is an admin of its studio (NOT_FOUND outside the caller's studios). */
async function requireToken(actor: Actor, tokenId: string): Promise<ApiTokenRow> {
  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1);
  if (!row) throw notFound("Token");
  const access = await getStudioAccess(actor.userId, row.studioId);
  if (!access) throw notFound("Token");
  if (!roleHas(access.role, "tokens.manage")) throw forbidden();
  return row;
}

async function validateScope(studioId: string, userId: string, projectIds: string[]): Promise<string[]> {
  const unique = [...new Set(projectIds)];
  if (!unique.length) throw invalid("Choose at least one project.");
  const bot = await getStudioAccess(userId, studioId);
  if (!bot) throw invalid("Choose a member of this studio for the token to act as.");
  for (const projectId of unique) {
    // The token only narrows what the member already has: every scoped project must be one they can open.
    const access = await getProjectAccess(userId, projectId);
    if (!access || access.studioId !== studioId) throw invalid("The member this token acts as can't open one of those projects. Add them to it first.");
  }
  return unique;
}

export async function createApiToken(actor: Actor, input: CreateApiTokenInput): Promise<IssuedApiToken> {
  await requireStudio(actor.userId, input.studioId, "tokens.manage");
  await enforceSharedRateLimit(`api-token-create:${actor.userId}`, 20, 60 * 60 * 1000);
  const name = input.name.trim();
  if (!name) throw invalid("Name the token.");
  const procedures = [...new Set(input.procedures)].filter(isApiTokenProcedure);
  if (!procedures.length) throw invalid("Choose at least one procedure.");
  const days = Math.min(Math.max(1, Math.floor(input.expiresInDays)), API_TOKEN_MAX_DAYS);
  const projectIds = await validateScope(input.studioId, input.userId, input.projectIds);

  const raw = generateApiToken();
  const expiresAt = new Date(now().getTime() + days * DAY);
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(apiTokens)
      .values({
        studioId: input.studioId,
        userId: input.userId,
        name,
        tokenHash: hashToken(raw),
        hint: apiTokenHint(raw),
        procedures,
        projectIds,
        createdById: actor.userId,
        expiresAt,
      })
      .returning();
    await audit(tx, actor, {
      studioId: input.studioId,
      action: "api_token.created",
      targetType: "api_token",
      targetId: inserted!.id,
      data: { name, hint: inserted!.hint, userId: input.userId, procedures, projectCount: projectIds.length, expiresAt: expiresAt.toISOString() },
    });
    return inserted!;
  });
  // The token itself is shown once; only its hash is stored.
  return { id: row.id, token: raw, expiresAt: row.expiresAt.toISOString() };
}

/** Replaces the token's secret: the old one stops working now, the new one keeps the same settings and expiry. */
export async function rotateApiToken(actor: Actor, input: { tokenId: string }): Promise<IssuedApiToken> {
  const old = await requireToken(actor, input.tokenId);
  const current = now();
  if (old.revokedAt) throw conflict("That token was revoked. Create a new one instead.");
  if (old.expiresAt.getTime() <= current.getTime()) throw conflict("That token has expired. Create a new one instead.");
  // The member may have lost a project since the token was made; the new token is only as wide as they still are.
  const projectIds = await validateScope(old.studioId, old.userId, old.projectIds);
  const raw = generateApiToken();
  const row = await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiTokens)
      .set({ revokedAt: current, revokedById: actor.userId })
      .where(and(eq(apiTokens.id, old.id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (!revoked) throw conflict("That token was revoked. Create a new one instead.");
    const [inserted] = await tx
      .insert(apiTokens)
      .values({
        studioId: old.studioId,
        userId: old.userId,
        name: old.name,
        tokenHash: hashToken(raw),
        hint: apiTokenHint(raw),
        procedures: old.procedures,
        projectIds,
        createdById: actor.userId,
        expiresAt: old.expiresAt,
      })
      .returning();
    await audit(tx, actor, {
      studioId: old.studioId,
      action: "api_token.rotated",
      targetType: "api_token",
      targetId: inserted!.id,
      data: { name: old.name, from: old.hint, hint: inserted!.hint, previousTokenId: old.id },
    });
    return inserted!;
  });
  return { id: row.id, token: raw, expiresAt: row.expiresAt.toISOString() };
}

export async function revokeApiToken(actor: Actor, input: { tokenId: string }) {
  const token = await requireToken(actor, input.tokenId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiTokens)
      .set({ revokedAt: now(), revokedById: actor.userId })
      .where(and(eq(apiTokens.id, token.id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    if (!row) throw conflict("That token was already revoked.");
    await audit(tx, actor, { studioId: token.studioId, action: "api_token.revoked", targetType: "api_token", targetId: token.id, data: { name: token.name, hint: token.hint } });
  });
  return { ok: true };
}

/** When a member leaves a studio, their tokens go with them (called inside the removal transaction). */
export async function revokeMemberTokens(ex: Executor, actor: Actor, studioId: string, userId: string) {
  const rows = await ex
    .update(apiTokens)
    .set({ revokedAt: now(), revokedById: actor.userId })
    .where(and(eq(apiTokens.studioId, studioId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id, name: apiTokens.name, hint: apiTokens.hint });
  for (const row of rows) {
    await audit(ex, actor, { studioId, action: "api_token.revoked", targetType: "api_token", targetId: row.id, data: { name: row.name, hint: row.hint, reason: "member_removed" } });
  }
}
