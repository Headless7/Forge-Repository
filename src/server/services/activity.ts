import { and, desc, eq, inArray, lt, notInArray, type SQL } from "drizzle-orm";
import type { ActivityDTO } from "@/lib/types";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { activityEvents, auditLogs, cards, projects } from "../db/schema";
import type { Actor } from "./context";
import { loadUsers, toUserDTO } from "./users-lookup";

/**
 * Activity types. Card-level history shows everything except `project.*`/`column.*`;
 * the project feed shows the highlights listed in PROJECT_FEED_TYPES.
 */
export type ActivityType =
  | "card.created"
  | "card.moved"
  | "card.renamed"
  | "card.archived"
  | "card.restored"
  | "card.duplicated"
  | "card.assignee_added"
  | "card.assignee_removed"
  | "card.reviewer_added"
  | "card.reviewer_removed"
  | "card.due_changed"
  | "card.priority_changed"
  | "card.milestone_changed"
  | "card.labels_changed"
  | "card.description_changed"
  | "card.state_changed"
  | "card.cover_changed"
  | "version.uploaded"
  | "attachment.added"
  | "review.submitted"
  | "review.approved"
  | "review.changes_requested"
  | "review.withdrawn"
  | "review.reopened"
  | "feedback.resolved"
  | "feedback.reopened"
  | "checklist.completed"
  | "checklist.item_assigned"
  | "checklist.item_due"
  | "checklist.item_done"
  | "deliverable.created"
  | "deliverable.updated"
  | "deliverable.archived"
  | "deliverable.restored"
  | "deliverable.linked"
  | "deliverable.unlinked"
  | "production.changed"
  | "resource.resolved"
  | "column.created"
  | "column.renamed"
  | "column.archived"
  | "column.restored"
  | "card.start_changed"
  | "column.duplicated"
  | "board.created"
  | "board.renamed"
  | "board.archived"
  | "board.restored"
  | "project.created"
  | "project.updated";

const PROJECT_FEED_TYPES: ActivityType[] = [
  "card.created",
  "card.moved",
  "card.archived",
  "card.assignee_added",
  "version.uploaded",
  "review.submitted",
  "review.approved",
  "review.changes_requested",
  "checklist.completed",
  "production.changed",
  "column.created",
  "column.archived",
  "board.created",
  "board.archived",
  "board.restored",
  "project.created",
];

export async function logActivity(
  ex: Executor,
  entry: {
    studioId: string;
    projectId: string;
    cardId?: string | null;
    actorId: string | null;
    type: ActivityType;
    data?: Record<string, unknown>;
  },
) {
  await ex.insert(activityEvents).values({
    studioId: entry.studioId,
    projectId: entry.projectId,
    cardId: entry.cardId ?? null,
    actorId: entry.actorId,
    type: entry.type,
    data: entry.data ?? {},
    createdAt: now(),
  });
}

export async function audit(
  ex: Executor,
  actor: Actor,
  entry: { studioId: string | null; action: string; targetType: string; targetId?: string | null; data?: Record<string, unknown> },
) {
  await ex.insert(auditLogs).values({
    studioId: entry.studioId,
    actorId: actor.userId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    data: entry.data ?? {},
    ipAddress: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    createdAt: now(),
  });
}

async function hydrate(rows: Array<typeof activityEvents.$inferSelect>): Promise<ActivityDTO[]> {
  const userIds = rows.map((r) => r.actorId).filter((id): id is string => Boolean(id));
  const cardIds = [...new Set(rows.map((r) => r.cardId).filter((id): id is string => Boolean(id)))];
  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  const [users, cardRows, projectRows] = await Promise.all([
    loadUsers(userIds),
    cardIds.length
      ? db
          .select({ id: cards.id, number: cards.number, title: cards.title, projectId: cards.projectId })
          .from(cards)
          .where(inArray(cards.id, cardIds))
      : Promise.resolve([]),
    db
      .select({ id: projects.id, name: projects.name, slug: projects.slug, icon: projects.icon, key: projects.key })
      .from(projects)
      .where(inArray(projects.id, projectIds.length ? projectIds : ["00000000-0000-0000-0000-000000000000"])),
  ]);
  const cardMap = new Map(cardRows.map((c) => [c.id, c]));
  const projectMap = new Map(projectRows.map((p) => [p.id, p]));
  return Promise.all(
    rows.map(async (row) => {
      const card = row.cardId ? cardMap.get(row.cardId) : undefined;
      const project = projectMap.get(row.projectId);
      const actor = row.actorId ? users.get(row.actorId) : undefined;
      return {
        id: row.id,
        type: row.type,
        actorId: row.actorId,
        actor: actor ? await toUserDTO(actor) : null,
        cardId: row.cardId,
        card: card && project ? { id: card.id, key: `${project.key}-${card.number}`, title: card.title } : null,
        project: project ? { id: project.id, name: project.name, slug: project.slug, icon: project.icon } : null,
        data: row.data,
        createdAt: row.createdAt.toISOString(),
      } satisfies ActivityDTO;
    }),
  );
}

export async function listAuditLog(studioId: string, limit = 100) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.studioId, studioId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(limit, 200));
  const actors = await loadUsers(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)));
  return Promise.all(
    rows.map(async (r) => {
      const actor = r.actorId ? actors.get(r.actorId) : undefined;
      return {
        id: r.id,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
        actor: actor ? await toUserDTO(actor) : null,
      };
    }),
  );
}

export async function listCardActivity(cardId: string, limit = 200): Promise<ActivityDTO[]> {
  const rows = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.cardId, cardId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit);
  return hydrate(rows);
}

export async function listProjectActivity(
  projectIds: string[],
  options: { before?: Date; limit?: number; all?: boolean; excludeTypes?: string[] } = {},
): Promise<ActivityDTO[]> {
  if (projectIds.length === 0) return [];
  const conditions: SQL[] = [inArray(activityEvents.projectId, projectIds)];
  if (!options.all) conditions.push(inArray(activityEvents.type, PROJECT_FEED_TYPES));
  if (options.excludeTypes?.length) conditions.push(notInArray(activityEvents.type, options.excludeTypes));
  if (options.before) conditions.push(lt(activityEvents.createdAt, options.before));
  const rows = await db
    .select()
    .from(activityEvents)
    .where(and(...conditions))
    .orderBy(desc(activityEvents.createdAt))
    .limit(Math.min(options.limit ?? 50, 200));
  return hydrate(rows);
}
