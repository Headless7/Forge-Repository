/**
 * Server-side authorization. Every service resolves access through these helpers,
 * so a user can never reach another studio's data by guessing IDs: lookups always
 * join through the caller's studio membership and fail with NOT_FOUND otherwise.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { deliverablePermissions } from "@/lib/deliverables";
import type { DeliverablePermissions } from "@/lib/types";
import {
  cardPermissions,
  memberCanOpenProject,
  normalizeRole,
  PRIVATE_ACCESS_ROLES,
  roleHas,
  type CardPermissions,
  type MemberAccess,
  type Permission,
  type Role,
} from "@/lib/permissions";
import { db, type Executor } from "./db";
import { boards, cardAssignees, cards, deliverableContributors, deliverables, projectMembers, projects, studioMembers, studios } from "./db/schema";
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
  /** PROJECTS = an external collaborator who only sees the projects they were added to. */
  scope: MemberAccess;
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
  /** The card's board is archived: the card is read-only until the board is restored. */
  boardArchived: boolean;
}

export function asRole(value: string): Role {
  return normalizeRole(value) ?? "VIEWER";
}

/** Owners/admins always keep their studio role; others may be promoted/demoted per project. */
export function effectiveProjectRole(studioRole: Role, override: string | null): Role {
  if (studioRole === "OWNER" || studioRole === "ADMIN") return studioRole;
  return normalizeRole(override) ?? studioRole;
}

export function has(access: { role: Role }, permission: Permission): boolean {
  return roleHas(access.role, permission);
}

function asScope(role: Role, access: string): MemberAccess {
  return access === "PROJECTS" && role !== "OWNER" && role !== "ADMIN" ? "PROJECTS" : "STUDIO";
}

const studioAccessColumns = { studioId: studios.id, slug: studios.slug, name: studios.name, role: studioMembers.role, access: studioMembers.access };

function toStudioAccess(userId: string, row: { studioId: string; slug: string; name: string; role: string; access: string }): StudioAccess {
  const role = asRole(row.role);
  return { userId, studioId: row.studioId, studioSlug: row.slug, studioName: row.name, role, scope: asScope(role, row.access) };
}

export async function getStudioAccess(userId: string, studioId: string, ex: Executor = db): Promise<StudioAccess | null> {
  const rows = await ex
    .select(studioAccessColumns)
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(and(eq(studioMembers.studioId, studioId), eq(studioMembers.userId, userId)))
    .limit(1);
  return rows[0] ? toStudioAccess(userId, rows[0]) : null;
}

export async function getStudioAccessBySlug(userId: string, slug: string, ex: Executor = db): Promise<StudioAccess | null> {
  const rows = await ex
    .select(studioAccessColumns)
    .from(studios)
    .innerJoin(studioMembers, and(eq(studioMembers.studioId, studios.id), eq(studioMembers.userId, userId)))
    .where(eq(studios.slug, slug))
    .limit(1);
  return rows[0] ? toStudioAccess(userId, rows[0]) : null;
}

/**
 * Every project the user can open (all studios, or one), in a single query: the SQL form of
 * `memberCanOpenProject`, for lists that would otherwise check projects one by one.
 */
export async function accessibleProjectIds(userId: string, studioId?: string, ex: Executor = db): Promise<Set<string>> {
  const rows = await ex
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(studioMembers, and(eq(studioMembers.studioId, projects.studioId), eq(studioMembers.userId, userId)))
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(
      and(
        studioId ? eq(projects.studioId, studioId) : undefined,
        or(
          inArray(studioMembers.role, ["OWNER", "ADMIN"]),
          isNotNull(projectMembers.id),
          and(eq(studioMembers.access, "STUDIO"), or(eq(projects.visibility, "STUDIO"), inArray(studioMembers.role, [...PRIVATE_ACCESS_ROLES]))),
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
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
      studioAccess: studioMembers.access,
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
  const scope = asScope(studioRole, row.studioAccess);
  if (!memberCanOpenProject({ role: studioRole, access: scope }, row.project, Boolean(row.projectMemberId))) return null;
  return {
    userId,
    studioId: row.project.studioId,
    studioSlug: row.studioSlug,
    studioName: row.studioName,
    project: row.project,
    studioRole,
    scope,
    role: effectiveProjectRole(studioRole, row.overrideRole),
  };
}

export function getProjectAccess(userId: string, projectId: string, ex: Executor = db) {
  return loadProjectAccess(userId, { projectId }, ex);
}

export function getProjectAccessBySlug(userId: string, studioSlug: string, projectSlug: string, ex: Executor = db) {
  return loadProjectAccess(userId, { studioSlug, projectSlug }, ex);
}

const ARCHIVED_ALLOWED: Permission[] = ["project.view", "project.update", "project.archive", "project.delete", "members.view"];

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

/**
 * Archiving, restoring and deleting projects belong to the studio owner. Checked against the
 * studio role itself, so no project-level role can grant it.
 */
export function assertStudioOwner(access: ProjectAccess, action = "archive or delete projects") {
  if (access.studioRole !== "OWNER") throw forbidden(`Only the studio owner can ${action}.`);
}

export function assertProjectPermission(access: ProjectAccess, permission?: Permission) {
  if (!permission) return;
  if (access.project.archivedAt && !ARCHIVED_ALLOWED.includes(permission)) {
    throw forbidden("This project is archived. Restore it from project settings to make changes.");
  }
  if (!roleHas(access.role, permission)) throw forbidden();
}

export async function requireCard(userId: string, cardId: string, ex: Executor = db): Promise<CardAccess> {
  const cardRows = await ex
    .select({ card: cards, boardArchivedAt: boards.archivedAt })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(eq(cards.id, cardId))
    .limit(1);
  const card = cardRows[0]?.card;
  if (!card) throw notFound("Card");
  const boardArchived = Boolean(cardRows[0]!.boardArchivedAt);
  const access = await getProjectAccess(userId, card.projectId, ex);
  if (!access) throw notFound("Card");
  const assigneeRows = await ex
    .select({ userId: cardAssignees.userId })
    .from(cardAssignees)
    .where(eq(cardAssignees.cardId, cardId));
  const assigneeIds = assigneeRows.map((r) => r.userId);
  const perms = computeCardPermissions(access, card, assigneeIds, boardArchived);
  return { access, card, assigneeIds, perms, boardArchived };
}

export function computeCardPermissions(access: ProjectAccess, card: CardRow, assigneeIds: string[], boardArchived = false): CardPermissions {
  const base = cardPermissions({
    role: access.role,
    userId: access.userId,
    card: { createdById: card.createdById, assigneeIds },
    allowSelfApproval: access.project.settings.allowSelfApproval,
  });
  if (!access.project.archivedAt && !card.archivedAt && !boardArchived) return base;
  // Archived cards, boards and projects are read-only apart from restore/delete.
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
    canArchive: base.canArchive && !access.project.archivedAt && !boardArchived,
  };
}

export function assertCard(perms: CardPermissions, key: keyof CardPermissions, message?: string) {
  if (!perms[key]) {
    throw forbidden(message ?? "You no longer have permission to change this card.");
  }
}

export interface DeliverableAccess extends CardAccess {
  deliverable: DeliverableRow;
  /** People working on it alongside its responsible person. */
  contributorIds: string[];
  dperms: DeliverablePermissions;
}

export function computeDeliverablePermissions(
  ctx: CardAccess,
  deliverable: Pick<DeliverableRow, "ownerId" | "archivedAt">,
  contributorIds: readonly string[] = [],
): DeliverablePermissions {
  return deliverablePermissions({
    card: ctx.perms,
    role: ctx.access.role,
    userId: ctx.access.userId,
    ownerId: deliverable.ownerId,
    contributorIds,
    cardAssignee: ctx.assigneeIds.includes(ctx.access.userId),
    allowSelfApproval: ctx.access.project.settings.allowSelfApproval,
    readOnly: Boolean(ctx.card.archivedAt || ctx.boardArchived || ctx.access.project.archivedAt || deliverable.archivedAt),
  });
}

/** Contributors of several deliverables at once. */
export async function loadContributors(ex: Executor, deliverableIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!deliverableIds.length) return out;
  const rows = await ex
    .select({ deliverableId: deliverableContributors.deliverableId, userId: deliverableContributors.userId })
    .from(deliverableContributors)
    .where(inArray(deliverableContributors.deliverableId, deliverableIds))
    .orderBy(deliverableContributors.createdAt);
  for (const r of rows) out.set(r.deliverableId, [...(out.get(r.deliverableId) ?? []), r.userId]);
  return out;
}

/** Resolves a deliverable through the caller's card access (NOT_FOUND outside it). */
export async function requireDeliverable(userId: string, deliverableId: string, ex: Executor = db): Promise<DeliverableAccess> {
  const rows = await ex.select().from(deliverables).where(eq(deliverables.id, deliverableId)).limit(1);
  const deliverable = rows[0];
  if (!deliverable) throw notFound("Deliverable");
  const ctx = await requireCard(userId, deliverable.cardId, ex).catch(() => {
    throw notFound("Deliverable");
  });
  const contributorIds = (await loadContributors(ex, [deliverable.id])).get(deliverable.id) ?? [];
  return { ...ctx, deliverable, contributorIds, dperms: computeDeliverablePermissions(ctx, deliverable, contributorIds) };
}

export function assertDeliverable(perms: DeliverablePermissions, key: keyof DeliverablePermissions, message?: string) {
  if (!perms[key]) throw forbidden(message ?? "You don't have permission to change this deliverable.");
}
