/**
 * Forums: trackers beside the boards. Every project has Bugs and QA; managers add custom ones
 * (a playtest round, an update's polish list). Each forum holds items that belong to the project
 * (and optionally to one update / milestone), have one assignee who does them and one reviewer who
 * verifies, and carry tags, pictures/clips and a flat comment thread. Unresolved items (open, in
 * progress or done-but-unverified) stay in the forum's global list whatever update they belong to.
 */
import { and, asc, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { DEFAULT_FORUMS, itemKey as makeItemKey, keyPrefixFrom } from "@/lib/forum-meta";
import { extractMentions } from "@/lib/mentions";
import { permissionsFor, roleHas } from "@/lib/permissions";
import { slugify } from "@/lib/slugs";
import type { ForumCommentDTO, ForumDTO, ForumItemDetailDTO, ForumItemSummaryDTO, ForumTagDTO, ForumViewDTO, ItemPriority, ItemResolution, ItemStatus } from "@/lib/types";
import { assertItem, assertProjectPermission, computeItemPermissions, requireForum, requireItem, requireProject, type ForumAccess, type ForumRow, type ItemAccess, type ItemRow, type ProjectAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { attachments, forumComments, forumItemTags, forumItems, forumTags, forums, milestones, users } from "../db/schema";
import { conflict, forbidden, invalid, isUniqueViolation, notFound } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { logActivity } from "./activity";
import { milestoneToDTO } from "./board";
import { attachmentToDTO, mediaRef } from "./card-dto";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { filterProjectMembers } from "./members-query";
import { NotificationBatch, type NotifyInput } from "./notifications";
import { enqueueStorageCleanup, storageUnits } from "./purge";

type TagRow = typeof forumTags.$inferSelect;
type CommentRow = typeof forumComments.$inferSelect;

const POSITION_GAP = 1024;

export function forumToDTO(f: ForumRow): ForumDTO {
  return {
    id: f.id,
    projectId: f.projectId,
    slug: f.slug,
    name: f.name,
    description: f.description,
    icon: f.icon,
    kind: f.kind,
    keyPrefix: f.keyPrefix,
    itemLabel: f.itemLabel,
    position: f.position,
    settings: { defaultReviewerId: f.settings.defaultReviewerId ?? null },
    archived: Boolean(f.archivedAt),
  };
}

const tagToDTO = (t: TagRow): ForumTagDTO => ({ id: t.id, name: t.name, color: t.color });

const commentToDTO = (c: CommentRow): ForumCommentDTO => ({
  id: c.id,
  authorId: c.authorId,
  body: c.deletedAt ? "" : c.body,
  editedAt: c.editedAt?.toISOString() ?? null,
  deletedAt: c.deletedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
});

const excerpt = (body: string) => (body.length > 160 ? `${body.slice(0, 157)}…` : body);

function itemKeyOf(access: ProjectAccess, forum: Pick<ForumRow, "keyPrefix">, item: Pick<ItemRow, "number">) {
  return makeItemKey(access.project.key, forum.keyPrefix, item.number);
}

/** What item notifications say they're about (see lib/notifications notificationSubject). */
function itemNotificationData(ctx: ItemAccess) {
  return { itemKey: itemKeyOf(ctx.access, ctx.forum, ctx.item), itemTitle: ctx.item.title, itemNoun: ctx.forum.itemLabel, forumName: ctx.forum.name, projectName: ctx.access.project.name };
}

function itemNotice(ctx: ItemAccess, actorId: string, type: NotifyInput["type"], recipientIds: Array<string | null | undefined>, data: Record<string, unknown> = {}): NotifyInput {
  return {
    recipientIds: recipientIds.filter((id): id is string => Boolean(id)),
    actorId,
    type,
    studioId: ctx.access.studioId,
    projectId: ctx.item.projectId,
    itemId: ctx.item.id,
    data: { ...itemNotificationData(ctx), ...data },
  };
}

async function nextItemNumber(tx: Executor, forumId: string): Promise<number> {
  const [row] = await tx
    .update(forums)
    .set({ counter: sql`${forums.counter} + 1` })
    .where(eq(forums.id, forumId))
    .returning({ counter: forums.counter });
  return row!.counter;
}

async function touchItem(tx: Executor, itemId: string) {
  await tx.update(forumItems).set({ lastActivityAt: now() }).where(eq(forumItems.id, itemId));
}

async function assertMilestone(tx: Executor, milestoneId: string, projectId: string) {
  const [row] = await tx.select({ id: milestones.id, name: milestones.name }).from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId)));
  if (!row) throw notFound("Update");
  return row;
}

/** Replaces an item's tags with `tagIds` (only tags of its forum count). */
async function replaceTags(tx: Executor, itemId: string, forumId: string, tagIds: string[]) {
  const wanted = [...new Set(tagIds)];
  const valid = wanted.length ? await tx.select({ id: forumTags.id }).from(forumTags).where(and(eq(forumTags.forumId, forumId), inArray(forumTags.id, wanted))) : [];
  await tx.delete(forumItemTags).where(eq(forumItemTags.itemId, itemId));
  if (valid.length) await tx.insert(forumItemTags).values(valid.map((t) => ({ itemId, tagId: t.id })));
  return valid.map((t) => t.id);
}

// ── Forums ──────────────────────────────────────────────────────────────────

/** The Bugs and QA forums every project starts with. Called inside the project's creating transaction. */
export async function createDefaultForums(tx: Executor, projectId: string, createdById: string | null) {
  await tx.insert(forums).values(
    DEFAULT_FORUMS.map((f, i) => ({
      projectId,
      slug: f.slug,
      name: f.name,
      description: f.description,
      icon: f.icon,
      kind: f.kind,
      keyPrefix: f.keyPrefix,
      itemLabel: f.itemLabel,
      position: i * POSITION_GAP,
      createdById,
    })),
  );
}

/** Live forums of a project in order (archived ones only when asked). */
export async function listForums(projectId: string, options: { includeArchived?: boolean } = {}, ex: Executor = db): Promise<ForumRow[]> {
  return ex
    .select()
    .from(forums)
    .where(and(eq(forums.projectId, projectId), options.includeArchived ? undefined : isNull(forums.archivedAt)))
    .orderBy(asc(forums.position), asc(forums.createdAt));
}

/** The project's forums as DTOs (archived ones only when asked), for settings and switchers. */
export async function listForumsFor(actor: Actor, projectId: string, includeArchived = false): Promise<ForumDTO[]> {
  await requireProject(actor.userId, projectId, "project.view");
  return (await listForums(projectId, { includeArchived })).map(forumToDTO);
}

async function uniqueSlug(tx: Executor, projectId: string, base: string, excludeId?: string): Promise<string> {
  const root = slugify(base) || "forum";
  const rows = await tx.select({ id: forums.id, slug: forums.slug }).from(forums).where(eq(forums.projectId, projectId));
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.slug));
  let candidate = root;
  for (let n = 2; taken.has(candidate); n++) candidate = `${root}-${n}`;
  return candidate;
}

async function uniquePrefix(tx: Executor, projectId: string, wanted: string, excludeId?: string): Promise<string> {
  const rows = await tx.select({ id: forums.id, keyPrefix: forums.keyPrefix }).from(forums).where(eq(forums.projectId, projectId));
  const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.keyPrefix));
  const root = wanted.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "F";
  if (!taken.has(root)) return root;
  for (let n = 2; n < 100; n++) {
    const candidate = `${root.slice(0, 2)}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw conflict("Pick another key prefix: that one is taken.");
}

export interface CreateForumInput {
  projectId: string;
  name: string;
  description?: string;
  icon?: string;
  keyPrefix?: string;
  itemLabel?: string;
  defaultReviewerId?: string | null;
}

export async function createForum(actor: Actor, input: CreateForumInput): Promise<ForumDTO> {
  const access = await requireProject(actor.userId, input.projectId, "forum.manage");
  const row = await db.transaction(async (tx) => {
    const [agg] = await tx.select({ value: max(forums.position) }).from(forums).where(eq(forums.projectId, access.project.id));
    const [reviewerId] = input.defaultReviewerId ? await filterProjectMembers(access.project, [input.defaultReviewerId], tx) : [];
    const [created] = await tx
      .insert(forums)
      .values({
        projectId: access.project.id,
        slug: await uniqueSlug(tx, access.project.id, input.name),
        name: input.name.trim(),
        description: input.description?.trim() ?? "",
        icon: input.icon ?? "📋",
        kind: "CUSTOM",
        keyPrefix: await uniquePrefix(tx, access.project.id, input.keyPrefix ?? keyPrefixFrom(input.name)),
        itemLabel: input.itemLabel?.trim().toLowerCase() || "issue",
        position: (agg?.value ?? 0) + POSITION_GAP,
        settings: { defaultReviewerId: reviewerId ?? null },
        createdById: actor.userId,
      })
      .returning();
    await logActivity(tx, { studioId: access.studioId, projectId: access.project.id, actorId: actor.userId, type: "forum.created", data: { forumName: created!.name, forumSlug: created!.slug } });
    return created!;
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return forumToDTO(row);
}

export interface UpdateForumInput {
  forumId: string;
  name?: string;
  description?: string;
  icon?: string;
  keyPrefix?: string;
  itemLabel?: string;
  defaultReviewerId?: string | null;
  archived?: boolean;
  /** Move before/after other forums (list order). */
  position?: number;
}

export async function updateForum(actor: Actor, input: UpdateForumInput): Promise<ForumDTO> {
  const { forum, access } = await requireForum(actor.userId, input.forumId);
  assertProjectPermission(access, "forum.manage");
  const row = await db.transaction(async (tx) => {
    const patch: Partial<typeof forums.$inferInsert> = {};
    if (input.name !== undefined && input.name.trim() !== forum.name) {
      patch.name = input.name.trim();
      // Custom forums follow their name in the URL; Bugs and QA keep their well-known addresses.
      if (forum.kind === "CUSTOM") patch.slug = await uniqueSlug(tx, forum.projectId, patch.name, forum.id);
    }
    if (input.description !== undefined) patch.description = input.description.trim();
    if (input.icon !== undefined) patch.icon = input.icon;
    if (input.keyPrefix !== undefined && input.keyPrefix.toUpperCase() !== forum.keyPrefix) {
      const prefix = await uniquePrefix(tx, forum.projectId, input.keyPrefix, forum.id);
      if (prefix !== input.keyPrefix.toUpperCase()) throw conflict("Another forum already uses that key prefix.");
      patch.keyPrefix = prefix;
    }
    if (input.itemLabel !== undefined) patch.itemLabel = input.itemLabel.trim().toLowerCase() || forum.itemLabel;
    if (input.defaultReviewerId !== undefined) {
      const [reviewerId] = input.defaultReviewerId ? await filterProjectMembers(access.project, [input.defaultReviewerId], tx) : [];
      if (input.defaultReviewerId && !reviewerId) throw invalid("That person can't open this project.");
      patch.settings = { ...forum.settings, defaultReviewerId: reviewerId ?? null };
    }
    if (input.archived !== undefined && input.archived !== Boolean(forum.archivedAt)) {
      if (input.archived && forum.kind !== "CUSTOM") throw invalid("Bugs and QA are part of every project and can't be archived.");
      patch.archivedAt = input.archived ? now() : null;
      patch.archivedById = input.archived ? actor.userId : null;
      await logActivity(tx, { studioId: access.studioId, projectId: forum.projectId, actorId: actor.userId, type: input.archived ? "forum.archived" : "forum.restored", data: { forumName: forum.name, forumSlug: forum.slug } });
    }
    if (input.position !== undefined) patch.position = input.position;
    if (patch.name !== undefined && patch.name !== forum.name) {
      await logActivity(tx, { studioId: access.studioId, projectId: forum.projectId, actorId: actor.userId, type: "forum.renamed", data: { from: forum.name, to: patch.name, forumSlug: patch.slug ?? forum.slug } });
    }
    const [updated] = Object.keys(patch).length ? await tx.update(forums).set(patch).where(eq(forums.id, forum.id)).returning() : [forum];
    return updated!;
  });
  new Effects().project(forum.projectId).flush(actor.clientId);
  return forumToDTO(row);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Files that show on an item: finished (or still transcoding) pictures and clips, oldest first. */
function liveItemFiles(itemIds: string[]) {
  return db
    .select()
    .from(attachments)
    .where(and(inArray(attachments.itemId, itemIds), eq(attachments.purpose, "ITEM"), isNull(attachments.archivedAt), inArray(attachments.status, ["READY", "PROCESSING"])))
    .orderBy(asc(attachments.createdAt));
}

async function summaries(access: ProjectAccess, forum: ForumRow, rows: ItemRow[], ex: Executor = db): Promise<ForumItemSummaryDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((b) => b.id);
  const [links, files, commentCounts] = await Promise.all([
    ex.select().from(forumItemTags).where(inArray(forumItemTags.itemId, ids)),
    liveItemFiles(ids),
    ex
      .select({ itemId: forumComments.itemId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(forumComments)
      .where(and(inArray(forumComments.itemId, ids), isNull(forumComments.deletedAt)))
      .groupBy(forumComments.itemId),
  ]);
  const tagsByItem = new Map<string, string[]>();
  for (const l of links) tagsByItem.set(l.itemId, [...(tagsByItem.get(l.itemId) ?? []), l.tagId]);
  const filesByItem = new Map<string, typeof files>();
  for (const f of files) filesByItem.set(f.itemId!, [...(filesByItem.get(f.itemId!) ?? []), f]);
  const comments = new Map(commentCounts.map((c) => [c.itemId, c.n]));
  return Promise.all(
    rows.map(async (b) => {
      const own = filesByItem.get(b.id) ?? [];
      return {
        id: b.id,
        forumId: b.forumId,
        projectId: b.projectId,
        number: b.number,
        key: itemKeyOf(access, forum, b),
        title: b.title,
        status: b.status,
        priority: b.priority,
        resolution: b.resolution,
        milestoneId: b.milestoneId,
        assigneeId: b.assigneeId,
        reviewerId: b.reviewerId,
        reportedById: b.reportedById,
        dueAt: b.dueAt?.toISOString() ?? null,
        tagIds: tagsByItem.get(b.id) ?? [],
        counts: { attachments: own.length, comments: comments.get(b.id) ?? 0 },
        cover: await mediaRef(own.find((f) => f.thumbnailKey) ?? own[0]),
        fixedAt: b.fixedAt?.toISOString() ?? null,
        verifiedAt: b.verifiedAt?.toISOString() ?? null,
        closedAt: b.closedAt?.toISOString() ?? null,
        lastActivityAt: b.lastActivityAt.toISOString(),
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      } satisfies ForumItemSummaryDTO;
    }),
  );
}

async function loadDetail(ctx: ItemAccess): Promise<ForumItemDetailDTO> {
  const [summary] = await summaries(ctx.access, ctx.forum, [ctx.item]);
  const [files, comments] = await Promise.all([
    liveItemFiles([ctx.item.id]),
    db.select().from(forumComments).where(eq(forumComments.itemId, ctx.item.id)).orderBy(asc(forumComments.createdAt)),
  ]);
  return {
    ...summary!,
    description: ctx.item.description,
    fixedById: ctx.item.fixedById,
    verifiedById: ctx.item.verifiedById,
    closedById: ctx.item.closedById,
    attachments: await Promise.all(files.map(attachmentToDTO)),
    comments: comments.map(commentToDTO),
    permissions: ctx.perms,
  };
}

/** A forum with everything its page needs: items (resolved ones too), tags, the project's updates and the other forums. */
export async function getForumView(actor: Actor, forumId: string): Promise<ForumViewDTO> {
  const { forum, access } = await requireForum(actor.userId, forumId);
  const [rows, tags, ms, all] = await Promise.all([
    db.select().from(forumItems).where(eq(forumItems.forumId, forum.id)).orderBy(desc(forumItems.createdAt)),
    db.select().from(forumTags).where(eq(forumTags.forumId, forum.id)).orderBy(asc(forumTags.name)),
    db.select().from(milestones).where(eq(milestones.projectId, forum.projectId)).orderBy(asc(milestones.position), asc(milestones.createdAt)),
    listForums(forum.projectId),
  ]);
  const p = access.project;
  return {
    project: { id: p.id, name: p.name, slug: p.slug, key: p.key, icon: p.icon, archived: Boolean(p.archivedAt) },
    forum: forumToDTO(forum),
    forums: all.map(forumToDTO),
    items: await summaries(access, forum, rows),
    tags: tags.map(tagToDTO),
    milestones: ms.map(milestoneToDTO),
    viewer: { userId: actor.userId, role: access.role, permissions: permissionsFor(access.role) },
  };
}

/** Resolves "/f/bugs" inside a project. */
export async function findForumIdBySlug(actor: Actor, projectId: string, slug: string): Promise<string> {
  await requireProject(actor.userId, projectId, "project.view");
  const rows = await db.select({ id: forums.id }).from(forums).where(and(eq(forums.projectId, projectId), eq(forums.slug, slug))).limit(1);
  if (!rows[0]) throw notFound("Forum");
  return rows[0].id;
}

export async function getItem(actor: Actor, itemId: string): Promise<ForumItemDetailDTO> {
  return loadDetail(await requireItem(actor.userId, itemId));
}

/** Resolves "UTD-B12" style references inside a forum. */
export async function findItemIdByNumber(actor: Actor, forumId: string, number: number): Promise<string> {
  await requireForum(actor.userId, forumId);
  const rows = await db.select({ id: forumItems.id }).from(forumItems).where(and(eq(forumItems.forumId, forumId), eq(forumItems.number, number))).limit(1);
  if (!rows[0]) throw notFound("Item");
  return rows[0].id;
}

// ── Creating and editing items ──────────────────────────────────────────────

export interface CreateItemInput {
  forumId: string;
  title: string;
  description?: string;
  priority?: ItemPriority;
  milestoneId?: string | null;
  assigneeId?: string | null;
  /** Undefined: the forum's default reviewer. Null: nobody (anyone on the team verifies). */
  reviewerId?: string | null;
  tagIds?: string[];
  /** ISO date-time it should be done by. */
  dueAt?: string | null;
}

export async function createItem(actor: Actor, input: CreateItemInput): Promise<ForumItemDetailDTO> {
  enforceRateLimit(`item:${actor.userId}`, 60, 10 * 60 * 1000);
  const { forum, access } = await requireForum(actor.userId, input.forumId);
  assertProjectPermission(access, "item.create");
  if (forum.archivedAt) throw conflict("This forum is archived.");
  const project = access.project;
  const defaultReviewer = forum.settings.defaultReviewerId ?? null;
  const reviewerWanted = input.reviewerId === undefined ? defaultReviewer : input.reviewerId;
  // Reporters pick themselves freely; choosing other people (or overriding the default reviewer) is assigning.
  if (input.assigneeId && input.assigneeId !== actor.userId) assertProjectPermission(access, "item.assign");
  if (reviewerWanted !== defaultReviewer && reviewerWanted !== actor.userId) assertProjectPermission(access, "item.assign");

  const fx = new Effects();
  const item = await db.transaction(async (tx) => {
    const milestone = input.milestoneId ? await assertMilestone(tx, input.milestoneId, project.id) : null;
    const number = await nextItemNumber(tx, forum.id);
    const [assigneeId] = input.assigneeId ? await filterProjectMembers(project, [input.assigneeId], tx) : [];
    const [reviewerId] = reviewerWanted ? await filterProjectMembers(project, [reviewerWanted], tx) : [];
    const createdAt = now();
    const [row] = await tx
      .insert(forumItems)
      .values({
        forumId: forum.id,
        projectId: project.id,
        number,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        priority: input.priority ?? "MEDIUM",
        milestoneId: milestone?.id ?? null,
        assigneeId: assigneeId ?? null,
        reviewerId: reviewerId ?? null,
        reportedById: actor.userId,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        lastActivityAt: createdAt,
        createdAt,
      })
      .returning();
    if (input.tagIds?.length) await replaceTags(tx, row!.id, forum.id, input.tagIds);
    const ctx: ItemAccess = { access, forum, item: row!, perms: computeItemPermissions(access, forum, row!) };
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: project.id,
      itemId: row!.id,
      actorId: actor.userId,
      type: "item.created",
      data: { priority: row!.priority, milestoneName: milestone?.name ?? null, noun: forum.itemLabel, forumName: forum.name },
    });
    const batch = new NotificationBatch();
    if (assigneeId) batch.add({ ...itemNotice(ctx, actor.userId, "ITEM_ASSIGNED", [assigneeId]), selfDm: true });
    if (reviewerId) batch.add(itemNotice(ctx, actor.userId, "ITEM_REVIEWER_ASSIGNED", [reviewerId]));
    fx.notify(await batch.send(tx));
    fx.item(project.id, row!.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return loadDetail({ access, forum, item, perms: computeItemPermissions(access, forum, item) });
}

export interface UpdateItemInput {
  itemId: string;
  title?: string;
  description?: string;
  priority?: ItemPriority;
  milestoneId?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  tagIds?: string[];
  dueAt?: string | null;
}

export async function updateItem(actor: Actor, input: UpdateItemInput): Promise<ForumItemDetailDTO> {
  const ctx = await requireItem(actor.userId, input.itemId);
  const { item, forum, access, perms } = ctx;
  const editsFields = input.title !== undefined || input.description !== undefined || input.priority !== undefined || input.milestoneId !== undefined || input.tagIds !== undefined || input.dueAt !== undefined;
  if (editsFields) assertItem(perms, "canEdit");
  if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
    const takesIt = input.assigneeId === actor.userId && !item.assigneeId;
    const leavesIt = input.assigneeId === null && item.assigneeId === actor.userId;
    if (takesIt) assertItem(perms, "canSelfAssign", `You don't have permission to take ${forum.itemLabel}s.`);
    else if (leavesIt) assertItem(perms, "canEdit");
    else assertItem(perms, "canAssign", "You don't have permission to assign people.");
  }
  if (input.reviewerId !== undefined && input.reviewerId !== item.reviewerId) assertItem(perms, "canAssign", "You don't have permission to choose who verifies.");

  const fx = new Effects();
  await db.transaction(async (tx) => {
    const patch: Partial<typeof forumItems.$inferInsert> = {};
    const log = (type: Parameters<typeof logActivity>[1]["type"], data: Record<string, unknown>) =>
      logActivity(tx, { studioId: access.studioId, projectId: item.projectId, itemId: item.id, actorId: actor.userId, type, data: { noun: forum.itemLabel, ...data } });

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw invalid("Describe it in a line.");
      if (title !== item.title) {
        patch.title = title;
        await log("item.renamed", { from: item.title, to: title });
      }
    }
    if (input.description !== undefined && input.description.trim() !== item.description) {
      patch.description = input.description.trim();
      await log("item.description_changed", {});
    }
    if (input.priority !== undefined && input.priority !== item.priority) {
      patch.priority = input.priority;
      await log("item.priority_changed", { from: item.priority, to: input.priority });
    }
    if (input.milestoneId !== undefined && input.milestoneId !== item.milestoneId) {
      const milestone = input.milestoneId ? await assertMilestone(tx, input.milestoneId, item.projectId) : null;
      patch.milestoneId = milestone?.id ?? null;
      await log("item.milestone_changed", { to: milestone?.name ?? null });
    }
    if (input.tagIds !== undefined) {
      const ids = await replaceTags(tx, item.id, forum.id, input.tagIds);
      await log("item.tags_changed", { count: ids.length });
    }
    const batch = new NotificationBatch();
    const nextDue = input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null;
    if (nextDue !== undefined && (nextDue?.getTime() ?? null) !== (item.dueAt?.getTime() ?? null)) {
      patch.dueAt = nextDue;
      await log("item.due_changed", { from: item.dueAt?.toISOString() ?? null, to: nextDue?.toISOString() ?? null });
    }
    if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
      const [assigneeId] = input.assigneeId ? await filterProjectMembers(access.project, [input.assigneeId], tx) : [];
      if (input.assigneeId && !assigneeId) throw invalid("That person can't open this project.");
      patch.assigneeId = assigneeId ?? null;
      await log("item.assignee_changed", { userId: assigneeId ?? null, from: item.assigneeId });
      if (assigneeId) batch.add({ ...itemNotice(ctx, actor.userId, "ITEM_ASSIGNED", [assigneeId]), selfDm: true });
    }
    if (input.reviewerId !== undefined && input.reviewerId !== item.reviewerId) {
      const [reviewerId] = input.reviewerId ? await filterProjectMembers(access.project, [input.reviewerId], tx) : [];
      if (input.reviewerId && !reviewerId) throw invalid("That person can't open this project.");
      patch.reviewerId = reviewerId ?? null;
      await log("item.reviewer_changed", { userId: reviewerId ?? null, from: item.reviewerId });
      if (reviewerId) batch.add(itemNotice(ctx, actor.userId, "ITEM_REVIEWER_ASSIGNED", [reviewerId]));
    }
    if (patch.dueAt !== undefined) {
      // The people named on it hear about the new deadline (never whoever moved it); someone just
      // given the item hears about the assignment instead.
      const named = [patch.assigneeId !== undefined ? patch.assigneeId : item.assigneeId, patch.reviewerId !== undefined ? patch.reviewerId : item.reviewerId];
      batch.add(itemNotice(ctx, actor.userId, "DUE_CHANGED", named, { dueAt: patch.dueAt?.toISOString() ?? null, previousDueAt: item.dueAt?.toISOString() ?? null }));
    }
    if (Object.keys(patch).length || input.tagIds !== undefined) {
      await tx.update(forumItems).set({ ...patch, lastActivityAt: now() }).where(eq(forumItems.id, item.id));
    }
    fx.notify(await batch.send(tx));
    fx.item(item.projectId, item.id);
  });
  fx.flush(actor.clientId);
  return getItem(actor, item.id);
}

// ── The workflow ────────────────────────────────────────────────────────────

/**
 * Moves an item along: In progress (the assignee starts, taking it if nobody has it) → Fixed / done
 * (waits for verification) → Verified by the reviewer; or Closed with a reason. Reopening (to Open,
 * or back to In progress from done) clears what was recorded.
 */
export async function setItemStatus(actor: Actor, input: { itemId: string; status: ItemStatus; resolution?: ItemResolution | null }): Promise<ForumItemDetailDTO> {
  const ctx = await requireItem(actor.userId, input.itemId);
  const { item, forum, access, perms } = ctx;
  const from = item.status;
  const to = input.status;
  if (from === to && !(to === "CLOSED" && input.resolution && input.resolution !== item.resolution)) return loadDetail(ctx);

  const at = now();
  const patch: Partial<typeof forumItems.$inferInsert> = { status: to, lastActivityAt: at };
  const batch = new NotificationBatch();
  const others = (ids: Array<string | null>) => ids.filter((id): id is string => Boolean(id) && id !== actor.userId);

  switch (to) {
    case "IN_PROGRESS": {
      if (from === "FIXED" || from === "VERIFIED" || from === "CLOSED") {
        // Sent back: it didn't hold (or it's being looked at again).
        if (!perms.canVerify && !perms.canEdit) throw forbidden("You don't have permission to send this back.");
        Object.assign(patch, { fixedAt: null, fixedById: null, verifiedAt: null, verifiedById: null, closedAt: null, closedById: null, resolution: null });
        batch.add(itemNotice(ctx, actor.userId, "ITEM_REOPENED", others([item.assigneeId]), { from }));
      } else if (!perms.canEdit) {
        if (!item.assigneeId && perms.canSelfAssign) patch.assigneeId = actor.userId;
        else throw forbidden(`You don't have permission to work on this ${forum.itemLabel}.`);
      }
      if (!item.assigneeId && !patch.assigneeId) patch.assigneeId = actor.userId;
      break;
    }
    case "FIXED": {
      assertItem(perms, "canEdit", `Only the assignee or a manager can mark a ${forum.itemLabel} done.`);
      if (from === "VERIFIED" || from === "CLOSED") throw invalid("Reopen it first.");
      Object.assign(patch, { fixedAt: at, fixedById: actor.userId, verifiedAt: null, verifiedById: null });
      if (!item.assigneeId) patch.assigneeId = actor.userId;
      batch.add(itemNotice(ctx, actor.userId, "ITEM_FIXED", others([item.reviewerId ?? item.reportedById])));
      break;
    }
    case "VERIFIED": {
      assertItem(perms, "canVerify", `You don't have permission to verify this ${forum.itemLabel}.`);
      if (from === "CLOSED") throw invalid("Reopen it first.");
      Object.assign(patch, { fixedAt: item.fixedAt ?? at, fixedById: item.fixedById ?? item.assigneeId ?? actor.userId, verifiedAt: at, verifiedById: actor.userId });
      batch.add(itemNotice(ctx, actor.userId, "ITEM_RESOLVED", others([item.assigneeId, item.reportedById]), { status: to }));
      break;
    }
    case "CLOSED": {
      assertItem(perms, "canClose", `Only a manager or the reporter can close a ${forum.itemLabel} without doing it.`);
      if (!input.resolution) throw invalid("Say why it's closed.");
      Object.assign(patch, { closedAt: item.closedAt ?? at, closedById: actor.userId, resolution: input.resolution });
      if (from !== "CLOSED") batch.add(itemNotice(ctx, actor.userId, "ITEM_RESOLVED", others([item.assigneeId, item.reportedById]), { status: to, resolution: input.resolution }));
      break;
    }
    case "OPEN": {
      if (!perms.canEdit && !perms.canVerify) throw forbidden("You don't have permission to reopen this.");
      Object.assign(patch, { fixedAt: null, fixedById: null, verifiedAt: null, verifiedById: null, closedAt: null, closedById: null, resolution: null });
      batch.add(itemNotice(ctx, actor.userId, "ITEM_REOPENED", others([item.assigneeId]), { from }));
      break;
    }
  }

  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.update(forumItems).set(patch).where(eq(forumItems.id, item.id));
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: item.projectId,
      itemId: item.id,
      actorId: actor.userId,
      type: "item.status_changed",
      data: { from, to, resolution: to === "CLOSED" ? input.resolution : null, noun: forum.itemLabel, kind: forum.kind },
    });
    if (patch.assigneeId && patch.assigneeId !== item.assigneeId) {
      await logActivity(tx, { studioId: access.studioId, projectId: item.projectId, itemId: item.id, actorId: actor.userId, type: "item.assignee_changed", data: { userId: patch.assigneeId, from: item.assigneeId, noun: forum.itemLabel } });
      // Taking it yourself: a Discord DM so it's in your pocket, like any other assignment.
      batch.add({ ...itemNotice(ctx, actor.userId, "ITEM_ASSIGNED", [patch.assigneeId]), selfDm: true });
    }
    fx.notify(await batch.send(tx));
    fx.item(item.projectId, item.id);
  });
  fx.flush(actor.clientId);
  return getItem(actor, item.id);
}

// ── Comments ────────────────────────────────────────────────────────────────

async function resolveMentions(tx: Executor, access: ProjectAccess, body: string): Promise<string[]> {
  const usernames = extractMentions(body);
  if (usernames.length === 0) return [];
  const rows = await tx.select({ id: users.id }).from(users).where(inArray(users.username, usernames));
  return filterProjectMembers(access.project, rows.map((r) => r.id), tx);
}

export async function addComment(actor: Actor, input: { itemId: string; body: string }): Promise<ForumItemDetailDTO> {
  enforceRateLimit(`item-comment:${actor.userId}`, 60, 60 * 1000);
  const ctx = await requireItem(actor.userId, input.itemId);
  assertItem(ctx.perms, "canComment", "You don't have permission to comment here.");
  const body = input.body.trim();
  if (!body) throw invalid("Write a comment.");
  if (body.length > 10_000) throw invalid("Comments are limited to 10,000 characters.");
  const { item, access, forum } = ctx;
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.insert(forumComments).values({ itemId: item.id, projectId: item.projectId, authorId: actor.userId, body, createdAt: now() });
    await logActivity(tx, { studioId: access.studioId, projectId: item.projectId, itemId: item.id, actorId: actor.userId, type: "item.commented", data: { excerpt: excerpt(body), noun: forum.itemLabel } });
    await touchItem(tx, item.id);
    const mentioned = await resolveMentions(tx, access, body);
    const batch = new NotificationBatch();
    if (mentioned.length) batch.add(itemNotice(ctx, actor.userId, "MENTIONED", mentioned, { excerpt: excerpt(body) }));
    batch.add(itemNotice(ctx, actor.userId, "ITEM_COMMENT", [item.assigneeId, item.reviewerId, item.reportedById], { excerpt: excerpt(body) }));
    fx.notify(await batch.send(tx));
    fx.item(item.projectId, item.id);
  });
  fx.flush(actor.clientId);
  return getItem(actor, item.id);
}

async function loadComment(actor: Actor, commentId: string) {
  const [comment] = await db.select().from(forumComments).where(eq(forumComments.id, commentId));
  if (!comment || comment.deletedAt) throw notFound("Comment");
  const ctx = await requireItem(actor.userId, comment.itemId);
  return { comment, ctx };
}

export async function editComment(actor: Actor, input: { commentId: string; body: string }): Promise<ForumItemDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  if (comment.authorId !== actor.userId) throw forbidden("You can only edit your own comments.");
  assertItem(ctx.perms, "canComment");
  const body = input.body.trim();
  if (!body) throw invalid("Write a comment.");
  if (body.length > 10_000) throw invalid("Comments are limited to 10,000 characters.");
  await db.update(forumComments).set({ body, editedAt: now() }).where(eq(forumComments.id, comment.id));
  new Effects().item(ctx.item.projectId, ctx.item.id).flush(actor.clientId);
  return getItem(actor, ctx.item.id);
}

export async function deleteComment(actor: Actor, input: { commentId: string }): Promise<ForumItemDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  if (comment.authorId !== actor.userId && !roleHas(ctx.access.role, "comment.moderate")) throw forbidden("You can only delete your own comments.");
  await db.update(forumComments).set({ deletedAt: now() }).where(eq(forumComments.id, comment.id));
  new Effects().item(ctx.item.projectId, ctx.item.id).flush(actor.clientId);
  return getItem(actor, ctx.item.id);
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Takes a picture or clip off an item for good (the stored files are cleaned up). */
export async function removeItemAttachment(actor: Actor, input: { attachmentId: string }): Promise<ForumItemDetailDTO> {
  const [file] = await db.select().from(attachments).where(eq(attachments.id, input.attachmentId));
  if (!file || !file.itemId) throw notFound("File");
  const ctx = await requireItem(actor.userId, file.itemId);
  const own = file.uploadedById === actor.userId;
  if (!(ctx.perms.canUpload || (own && ctx.perms.canComment))) throw forbidden("You can't remove this file.");
  await db.transaction(async (tx) => {
    await tx.delete(attachments).where(eq(attachments.id, file.id));
    await enqueueStorageCleanup(tx, storageUnits(file), `item file ${file.id} removed`);
    await logActivity(tx, { studioId: ctx.access.studioId, projectId: ctx.item.projectId, itemId: ctx.item.id, actorId: actor.userId, type: "item.attachment_removed", data: { filename: file.filename, noun: ctx.forum.itemLabel } });
    await touchItem(tx, ctx.item.id);
  });
  new Effects().item(ctx.item.projectId, ctx.item.id).flush(actor.clientId);
  return getItem(actor, ctx.item.id);
}

// ── Deleting ────────────────────────────────────────────────────────────────

/** Permanently deletes an item with its comments and files (its reporter or an admin; closing is the usual way to retire one). */
export async function deleteItem(actor: Actor, input: { itemId: string }) {
  const ctx = await requireItem(actor.userId, input.itemId);
  assertItem(ctx.perms, "canDelete", `Only whoever reported this ${ctx.forum.itemLabel} or an Admin can delete it. Close it instead.`);
  await db.transaction(async (tx) => {
    const files = await tx.select().from(attachments).where(eq(attachments.itemId, ctx.item.id));
    await tx.delete(forumItems).where(eq(forumItems.id, ctx.item.id));
    await enqueueStorageCleanup(tx, [...new Set(files.flatMap(storageUnits))], `item ${ctx.item.id} deleted`);
  });
  new Effects().item(ctx.item.projectId, null).flush(actor.clientId);
  return { ok: true };
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function createTag(actor: Actor, input: { forumId: string; name: string; color: string }): Promise<ForumTagDTO> {
  const { forum, access } = await requireForum(actor.userId, input.forumId);
  assertProjectPermission(access, "forum.manage");
  try {
    const [row] = await db.insert(forumTags).values({ forumId: forum.id, projectId: forum.projectId, name: input.name.trim(), color: input.color }).returning();
    new Effects().item(forum.projectId, null).flush(actor.clientId);
    return tagToDTO(row!);
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid(`A tag called "${input.name.trim()}" already exists.`);
    throw error;
  }
}

async function loadTag(actor: Actor, tagId: string) {
  const [tag] = await db.select().from(forumTags).where(eq(forumTags.id, tagId));
  if (!tag) throw notFound("Tag");
  const ctx = await requireForum(actor.userId, tag.forumId);
  assertProjectPermission(ctx.access, "forum.manage");
  return { tag, ctx };
}

export async function updateTag(actor: Actor, input: { tagId: string; name?: string; color?: string }): Promise<ForumTagDTO> {
  const { tag } = await loadTag(actor, input.tagId);
  try {
    const [row] = await db
      .update(forumTags)
      .set({ ...(input.name ? { name: input.name.trim() } : {}), ...(input.color ? { color: input.color } : {}) })
      .where(eq(forumTags.id, tag.id))
      .returning();
    new Effects().item(tag.projectId, null).flush(actor.clientId);
    return tagToDTO(row!);
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid("Another tag already uses that name.");
    throw error;
  }
}

export async function deleteTag(actor: Actor, input: { tagId: string }) {
  const { tag } = await loadTag(actor, input.tagId);
  await db.delete(forumTags).where(eq(forumTags.id, tag.id));
  new Effects().item(tag.projectId, null).flush(actor.clientId);
  return { ok: true };
}

export type { ForumAccess };
