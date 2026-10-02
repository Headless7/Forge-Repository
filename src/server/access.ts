/**
 * Server-side authorization. Every service resolves access through these helpers,
 * so a user can never reach another studio's data by guessing IDs: lookups always
 * join through the caller's studio membership and fail with NOT_FOUND otherwise.
 */
import { and, eq } from "drizzle-orm";
import { deliverablePermissions } from "@/lib/deliverables";
import type { DeliverablePermissions } from "@/lib/types";
import {
  cardPermissions,
  isRole,
  roleHas,
  type CardPermissions,
  type Permission,
  type Role,
} from "@/lib/permissions";
import { db, type Executor } from "./db";
import { cardAssignees, cards, deliverables, projectMembers, projects, studioMembers, studios } from "./db/schema";
import { forbidden, notFound } from "./errors";

export type ProjectRow = typeof projects.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type DeliverableRow = typeof deliverables.$inferSelect;

export interface StudioAccess {
  userId: string;
  studioId: string;
  studioSlug: string;
  studioName: string;
  role: Role;
}

export interface ProjectAccess extends StudioAccess {
  project: ProjectRow;
  /** Effective role inside this project (studio role or project override). */
  role: Role;
  studioRole: Role;
}

export interface CardAccess {
  access: ProjectAccess;
  card: CardRow;
  assigneeIds: string[];
  perms: CardPermissions;
}

function asRole(value: string): Role {
  return isRole(value) ? value : "VIEWER";
}

/** Owners/admins always keep their studio role; others may be promoted/demoted per project. */
export function effectiveProjectRole(studioRole: Role, override: string | null): Role {
  if (studioRole === "OWNER" || studioRole === "ADMIN") return studioRole;
  if (override && isRole(override)) return override;
  return studioRole;
}

export function has(access: { role: Role }, permission: Permission): boolean {
  return roleHas(access.role, permission);
}

export async function getStudioAccess(userId: string, studioId: string, ex: Executor = db): Promise<StudioAccess | null> {
  const rows = await ex
    .select({ studioId: studios.id, slug: studios.slug, name: studios.name, role: studioMembers.role })
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(and(eq(studioMembers.studioId, studioId), eq(studioMembers.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { userId, studioId: row.studioId, studioSlug: row.slug, studioName: row.name, role: asRole(row.role) };
}

export async function getStudioAccessBySlug(userId: string, slug: string, ex: Executor = db): Promise<StudioAccess | null> {
  const rows = await ex
    .select({ studioId: studios.id, slug: studios.slug, name: studios.name, role: studioMembers.role })
    .from(studios)
    .innerJoin(studioMembers, and(eq(studioMembers.studioId, studios.id), eq(studioMembers.userId, userId)))
    .where(eq(studios.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { userId, studioId: row.studioId, studioSlug: row.slug, studioName: row.name, role: asRole(row.role) };
}

export async function requireStudio(
  userId: string,
  studioId: string,
  permission?: Permission,
  ex: Executor = db,
): Promise<StudioAccess> {
  const access = await getStudioAccess(userId, studioId, ex);
  if (!access) throw notFound("Studio");
  if (permission && !roleHas(access.role, permission)) throw forbidden();
  return access;
}

type ProjectLookup = { projectId: string } | { studioSlug: string; projectSlug: string };

async function loadProjectAccess(userId: string, lookup: ProjectLookup, ex: Executor): Promise<ProjectAccess | null> {
  const where =
    "projectId" in lookup
      ? eq(projects.id, lookup.projectId)
      : and(eq(studios.slug, lookup.studioSlug), eq(projects.slug, lookup.projectSlug));
  const rows = await ex
    .select({
      project: projects,
      studioSlug: studios.slug,
      studioName: studios.name,
      studioRole: studioMembers.role,
      overrideRole: projectMembers.role,
      projectMemberId: projectMembers.id,
    })
    .from(projects)
    .innerJoin(studios, eq(studios.id, projects.studioId))
    .innerJoin(studioMembers, and(eq(studioMembers.studioId, projects.studioId), eq(studioMembers.userId, userId)))
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(where)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const studioRole = asRole(row.studioRole);
  const privileged = studioRole === "OWNER" || studioRole === "ADMIN";
  if (row.project.visibility === "PRIVATE" && !row.projectMemberId && !privileged) return null;
  return {
    userId,
    studioId: row.project.studioId,
    studioSlug: row.studioSlug,
    studioName: row.studioName,
    project: row.project,
    studioRole,
    role: effectiveProjectRole(studioRole, row.overrideRole),
  };
}

export function getProjectAccess(userId: string, projectId: string, ex: Executor = db) {
  return loadProjectAccess(userId, { projectId }, ex);
}

export function getProjectAccessBySlug(userId: string, studioSlug: string, projectSlug: string, ex: Executor = db) {
  return loadProjectAccess(userId, { studioSlug, projectSlug }, ex);
}

const ARCHIVED_ALLOWED: Permission[] = ["project.view", "project.update", "project.delete", "members.view"];

export async function requireProject(
  userId: string,
  projectId: string,
  permission?: Permission,
  ex: Executor = db,
): Promise<ProjectAccess> {
  const access = await getProjectAccess(userId, projectId, ex);
  if (!access) throw notFound("Project");
  assertProjectPermission(access, permission);
  return access;
}

export function assertProjectPermission(access: ProjectAccess, permission?: Permission) {
  if (!permission) return;
  if (access.project.archivedAt && !ARCHIVED_ALLOWED.includes(permission)) {
    throw forbidden("This project is archived. Restore it from project settings to make changes.");
  }
  if (!roleHas(access.role, permission)) throw forbidden();
}

export async function requireCard(userId: string, cardId: string, ex: Executor = db): Promise<CardAccess> {
  const cardRows = await ex.select().from(cards).where(eq(cards.id, cardId)).limit(1);
  const card = cardRows[0];
  if (!card) throw notFound("Card");
  const access = await getProjectAccess(userId, card.projectId, ex);
  if (!access) throw notFound("Card");
  const assigneeRows = await ex
    .select({ userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(eq(cardAssignees.cardId, cardId));
  const assigneeIds = assigneeRows.map((r) => r.userId);
  const perms = computeCardPermissions(access, card, assigneeIds);
  return { access, card, assigneeIds, perms };
}

export function computeCardPermissions(access: ProjectAccess, card: CardRow, assigneeIds: string[]): CardPermissions {
  const base = cardPermissions({
    role: access.role,
    userId: access.userId,
    card: { createdById: card.createdById, assigneeIds },
    allowSelfApproval: access.project.settings.allowSelfApproval,
  });
  if (!access.project.archivedAt && !card.archivedAt) return base;
  // Archived cards/projects are read-only apart from restore/delete.
  return {
    ...base,
    canEdit: false,
    canMove: false,
    canAssign: false,
    canSelfAssign: false,
    canReview: false,
    canSubmit: false,
    canUpload: false,
    canComment: false,
    canResolveFeedback: false,
    canPublish: false,
    canArchive: base.canArchive && !access.project.archivedAt,
  };
}

export function assertCard(perms: CardPermissions, key: keyof CardPermissions, message?: string) {
  if (!perms[key]) {
    throw forbidden(message ?? "You no longer have permission to change this card.");
  }
}

export interface DeliverableAccess extends CardAccess {
  deliverable: DeliverableRow;
  dperms: DeliverablePermissions;
}

export function computeDeliverablePermissions(ctx: CardAccess, deliverable: Pick<DeliverableRow, "ownerId" | "archivedAt">): DeliverablePermissions {
  return deliverablePermissions({
    card: ctx.perms,
    role: ctx.access.role,
    userId: ctx.access.userId,
    ownerId: deliverable.ownerId,
    allowSelfApproval: ctx.access.project.settings.allowSelfApproval,
    readOnly: Boolean(ctx.card.archivedAt || ctx.access.project.archivedAt || deliverable.archivedAt),
  });
}

/** Resolves a deliverable through the caller's card access (NOT_FOUND outside it). */
export async function requireDeliverable(userId: string, deliverableId: string, ex: Executor = db): Promise<DeliverableAccess> {
  const rows = await ex.select().from(deliverables).where(eq(deliverables.id, deliverableId)).limit(1);
  const deliverable = rows[0];
  if (!deliverable) throw notFound("Deliverable");
  const ctx = await requireCard(userId, deliverable.cardId, ex).catch(() => {
    throw notFound("Deliverable");
  });
  return { ...ctx, deliverable, dperms: computeDeliverablePermissions(ctx, deliverable) };
}

export function assertDeliverable(perms: DeliverablePermissions, key: keyof DeliverablePermissions, message?: string) {
  if (!perms[key]) throw forbidden(message ?? "You don't have permission to change this deliverable.");
}
