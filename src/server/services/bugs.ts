/**
 * Bug reports: a layer beside the boards. A bug belongs to the project (and optionally to one
 * update / milestone), has one assignee who fixes it and one reviewer who verifies the fix, and
 * carries tags, pictures/clips and a flat comment thread. Unresolved bugs (open, in progress or
 * fixed-but-unverified) stay in the project's global list whatever update they belong to.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bugKey as makeBugKey } from "@/lib/bug-meta";
import { extractMentions } from "@/lib/mentions";
import { permissionsFor, roleHas } from "@/lib/permissions";
import type { BugCommentDTO, BugDetailDTO, BugListDTO, BugPriority, BugResolution, BugStatus, BugSummaryDTO, BugTagDTO } from "@/lib/types";
import { assertBug, assertProjectPermission, computeBugPermissions, requireBug, requireProject, type BugAccess, type BugRow, type ProjectAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { attachments, bugComments, bugTagLinks, bugTags, bugs, milestones, projects, users } from "../db/schema";
import { forbidden, invalid, isUniqueViolation, notFound } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { logActivity } from "./activity";
import { milestoneToDTO } from "./board";
import { attachmentToDTO, mediaRef } from "./card-dto";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { filterProjectMembers } from "./members-query";
import { NotificationBatch, notify, type NotifyInput } from "./notifications";
import { enqueueStorageCleanup, storageUnits } from "./purge";

type TagRow = typeof bugTags.$inferSelect;
type CommentRow = typeof bugComments.$inferSelect;

const tagToDTO = (t: TagRow): BugTagDTO => ({ id: t.id, name: t.name, color: t.color });

const commentToDTO = (c: CommentRow): BugCommentDTO => ({
  id: c.id,
  authorId: c.authorId,
  body: c.deletedAt ? "" : c.body,
  editedAt: c.editedAt?.toISOString() ?? null,
  deletedAt: c.deletedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
});

const excerpt = (body: string) => (body.length > 160 ? `${body.slice(0, 157)}…` : body);

function bugKeyOf(access: ProjectAccess, bug: Pick<BugRow, "number">) {
  return makeBugKey(access.project.key, bug.number);
}

/** What bug notifications say they're about (see lib/notifications notificationSubject). */
function bugNotificationData(access: ProjectAccess, bug: Pick<BugRow, "number" | "title">) {
  return { bugKey: bugKeyOf(access, bug), bugTitle: bug.title, projectName: access.project.name };
}

function bugNotice(ctx: BugAccess, actorId: string, type: NotifyInput["type"], recipientIds: Array<string | null | undefined>, data: Record<string, unknown> = {}): NotifyInput {
  return {
    recipientIds: recipientIds.filter((id): id is string => Boolean(id)),
    actorId,
    type,
    studioId: ctx.access.studioId,
    projectId: ctx.bug.projectId,
    bugId: ctx.bug.id,
    data: { ...bugNotificationData(ctx.access, ctx.bug), ...data },
  };
}

async function nextBugNumber(tx: Executor, projectId: string): Promise<number> {
  const [row] = await tx
    .update(projects)
    .set({ bugCounter: sql`${projects.bugCounter} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ counter: projects.bugCounter });
  return row!.counter;
}

async function touchBug(tx: Executor, bugId: string) {
  await tx.update(bugs).set({ lastActivityAt: now() }).where(eq(bugs.id, bugId));
}

async function assertMilestone(tx: Executor, milestoneId: string, projectId: string) {
  const [row] = await tx.select({ id: milestones.id, name: milestones.name }).from(milestones).where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId)));
  if (!row) throw notFound("Update");
  return row;
}

/** Replaces a bug's tags with `tagIds` (only tags of its project count). */
async function replaceTags(tx: Executor, bugId: string, projectId: string, tagIds: string[]) {
  const wanted = [...new Set(tagIds)];
  const valid = wanted.length ? await tx.select({ id: bugTags.id }).from(bugTags).where(and(eq(bugTags.projectId, projectId), inArray(bugTags.id, wanted))) : [];
  await tx.delete(bugTagLinks).where(eq(bugTagLinks.bugId, bugId));
  if (valid.length) await tx.insert(bugTagLinks).values(valid.map((t) => ({ bugId, tagId: t.id })));
  return valid.map((t) => t.id);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Files that show on a bug: finished (or still transcoding) pictures and clips, oldest first. */
function liveBugFiles(bugIds: string[]) {
  return db
    .select()
    .from(attachments)
    .where(and(inArray(attachments.bugId, bugIds), eq(attachments.purpose, "BUG"), isNull(attachments.archivedAt), inArray(attachments.status, ["READY", "PROCESSING"])))
    .orderBy(asc(attachments.createdAt));
}

async function summaries(access: ProjectAccess, rows: BugRow[], ex: Executor = db): Promise<BugSummaryDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((b) => b.id);
  const [links, files, commentCounts] = await Promise.all([
    ex.select().from(bugTagLinks).where(inArray(bugTagLinks.bugId, ids)),
    liveBugFiles(ids),
    ex
      .select({ bugId: bugComments.bugId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(bugComments)
      .where(and(inArray(bugComments.bugId, ids), isNull(bugComments.deletedAt)))
      .groupBy(bugComments.bugId),
  ]);
  const tagsByBug = new Map<string, string[]>();
  for (const l of links) tagsByBug.set(l.bugId, [...(tagsByBug.get(l.bugId) ?? []), l.tagId]);
  const filesByBug = new Map<string, typeof files>();
  for (const f of files) filesByBug.set(f.bugId!, [...(filesByBug.get(f.bugId!) ?? []), f]);
  const comments = new Map(commentCounts.map((c) => [c.bugId, c.n]));
  return Promise.all(
    rows.map(async (b) => {
      const own = filesByBug.get(b.id) ?? [];
      return {
        id: b.id,
        projectId: b.projectId,
        number: b.number,
        key: bugKeyOf(access, b),
        title: b.title,
        status: b.status,
        priority: b.priority,
        resolution: b.resolution,
        milestoneId: b.milestoneId,
        assigneeId: b.assigneeId,
        reviewerId: b.reviewerId,
        reportedById: b.reportedById,
        tagIds: tagsByBug.get(b.id) ?? [],
        counts: { attachments: own.length, comments: comments.get(b.id) ?? 0 },
        cover: await mediaRef(own.find((f) => f.thumbnailKey) ?? own[0]),
        fixedAt: b.fixedAt?.toISOString() ?? null,
        verifiedAt: b.verifiedAt?.toISOString() ?? null,
        closedAt: b.closedAt?.toISOString() ?? null,
        lastActivityAt: b.lastActivityAt.toISOString(),
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      } satisfies BugSummaryDTO;
    }),
  );
}

async function loadDetail(ctx: BugAccess): Promise<BugDetailDTO> {
  const [summary] = await summaries(ctx.access, [ctx.bug]);
  const [files, comments] = await Promise.all([
    liveBugFiles([ctx.bug.id]),
    db.select().from(bugComments).where(eq(bugComments.bugId, ctx.bug.id)).orderBy(asc(bugComments.createdAt)),
  ]);
  return {
    ...summary!,
    description: ctx.bug.description,
    fixedById: ctx.bug.fixedById,
    verifiedById: ctx.bug.verifiedById,
    closedById: ctx.bug.closedById,
    attachments: await Promise.all(files.map(attachmentToDTO)),
    comments: comments.map(commentToDTO),
    permissions: ctx.perms,
  };
}

/** The whole tracker of a project: every bug (resolved ones too), its tags and updates. The list filters client-side. */
export async function listBugs(actor: Actor, projectId: string): Promise<BugListDTO> {
  const access = await requireProject(actor.userId, projectId, "project.view");
  const [rows, tags, ms] = await Promise.all([
    db.select().from(bugs).where(eq(bugs.projectId, projectId)).orderBy(desc(bugs.createdAt)),
    db.select().from(bugTags).where(eq(bugTags.projectId, projectId)).orderBy(asc(bugTags.name)),
    db.select().from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.position), asc(milestones.createdAt)),
  ]);
  const p = access.project;
  return {
    project: { id: p.id, name: p.name, slug: p.slug, key: p.key, icon: p.icon, archived: Boolean(p.archivedAt) },
    bugs: await summaries(access, rows),
    tags: tags.map(tagToDTO),
    milestones: ms.map(milestoneToDTO),
    viewer: { userId: actor.userId, role: access.role, permissions: permissionsFor(access.role) },
    settings: { defaultBugReviewerId: p.settings.defaultBugReviewerId ?? null },
  };
}

export async function getBug(actor: Actor, bugId: string): Promise<BugDetailDTO> {
  return loadDetail(await requireBug(actor.userId, bugId));
}

/** Resolves "UTD-B12" style references inside a project. */
export async function findBugIdByNumber(actor: Actor, projectId: string, number: number): Promise<string> {
  await requireProject(actor.userId, projectId, "project.view");
  const rows = await db.select({ id: bugs.id }).from(bugs).where(and(eq(bugs.projectId, projectId), eq(bugs.number, number))).limit(1);
  if (!rows[0]) throw notFound("Bug");
  return rows[0].id;
}

// ── Creating and editing ────────────────────────────────────────────────────

export interface CreateBugInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: BugPriority;
  milestoneId?: string | null;
  assigneeId?: string | null;
  /** Undefined: the project's default bug reviewer. Null: nobody (any manager verifies). */
  reviewerId?: string | null;
  tagIds?: string[];
}

export async function createBug(actor: Actor, input: CreateBugInput): Promise<BugDetailDTO> {
  enforceRateLimit(`bug:${actor.userId}`, 60, 10 * 60 * 1000);
  const access = await requireProject(actor.userId, input.projectId, "bug.create");
  const project = access.project;
  const defaultReviewer = project.settings.defaultBugReviewerId ?? null;
  const reviewerWanted = input.reviewerId === undefined ? defaultReviewer : input.reviewerId;
  // Reporters pick themselves freely; choosing other people (or overriding the default reviewer) is assigning.
  if (input.assigneeId && input.assigneeId !== actor.userId) assertProjectPermission(access, "bug.assign");
  if (reviewerWanted !== defaultReviewer && reviewerWanted !== actor.userId) assertProjectPermission(access, "bug.assign");

  const fx = new Effects();
  const bug = await db.transaction(async (tx) => {
    const milestone = input.milestoneId ? await assertMilestone(tx, input.milestoneId, project.id) : null;
    const number = await nextBugNumber(tx, project.id);
    const [assigneeId] = input.assigneeId ? await filterProjectMembers(project, [input.assigneeId], tx) : [];
    const [reviewerId] = reviewerWanted ? await filterProjectMembers(project, [reviewerWanted], tx) : [];
    const createdAt = now();
    const [row] = await tx
      .insert(bugs)
      .values({
        projectId: project.id,
        number,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        priority: input.priority ?? "MEDIUM",
        milestoneId: milestone?.id ?? null,
        assigneeId: assigneeId ?? null,
        reviewerId: reviewerId ?? null,
        reportedById: actor.userId,
        lastActivityAt: createdAt,
        createdAt,
      })
      .returning();
    if (input.tagIds?.length) await replaceTags(tx, row!.id, project.id, input.tagIds);
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: project.id,
      bugId: row!.id,
      actorId: actor.userId,
      type: "bug.created",
      data: { priority: row!.priority, milestoneName: milestone?.name ?? null },
    });
    const ctx: BugAccess = { access, bug: row!, perms: computeBugPermissions(access, row!) };
    const batch = new NotificationBatch();
    if (assigneeId) batch.add(bugNotice(ctx, actor.userId, "BUG_ASSIGNED", [assigneeId]));
    if (reviewerId) batch.add(bugNotice(ctx, actor.userId, "BUG_REVIEWER_ASSIGNED", [reviewerId]));
    fx.notify(await batch.send(tx));
    fx.bug(project.id, row!.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return loadDetail({ access, bug, perms: computeBugPermissions(access, bug) });
}

export interface UpdateBugInput {
  bugId: string;
  title?: string;
  description?: string;
  priority?: BugPriority;
  milestoneId?: string | null;
  assigneeId?: string | null;
  reviewerId?: string | null;
  tagIds?: string[];
}

export async function updateBug(actor: Actor, input: UpdateBugInput): Promise<BugDetailDTO> {
  const ctx = await requireBug(actor.userId, input.bugId);
  const { bug, access, perms } = ctx;
  const editsFields = input.title !== undefined || input.description !== undefined || input.priority !== undefined || input.milestoneId !== undefined || input.tagIds !== undefined;
  if (editsFields) assertBug(perms, "canEdit");
  if (input.assigneeId !== undefined && input.assigneeId !== bug.assigneeId) {
    const takesIt = input.assigneeId === actor.userId && !bug.assigneeId;
    const leavesIt = input.assigneeId === null && bug.assigneeId === actor.userId;
    if (takesIt) assertBug(perms, "canSelfAssign", "You don't have permission to take bugs.");
    else if (leavesIt) assertBug(perms, "canEdit");
    else assertBug(perms, "canAssign", "You don't have permission to assign bugs.");
  }
  if (input.reviewerId !== undefined && input.reviewerId !== bug.reviewerId) assertBug(perms, "canAssign", "You don't have permission to choose who verifies bugs.");

  const fx = new Effects();
  await db.transaction(async (tx) => {
    const patch: Partial<typeof bugs.$inferInsert> = {};
    const log = (type: Parameters<typeof logActivity>[1]["type"], data: Record<string, unknown>) =>
      logActivity(tx, { studioId: access.studioId, projectId: bug.projectId, bugId: bug.id, actorId: actor.userId, type, data });

    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw invalid("Describe the bug in a line.");
      if (title !== bug.title) {
        patch.title = title;
        await log("bug.renamed", { from: bug.title, to: title });
      }
    }
    if (input.description !== undefined && input.description.trim() !== bug.description) {
      patch.description = input.description.trim();
      await log("bug.description_changed", {});
    }
    if (input.priority !== undefined && input.priority !== bug.priority) {
      patch.priority = input.priority;
      await log("bug.priority_changed", { from: bug.priority, to: input.priority });
    }
    if (input.milestoneId !== undefined && input.milestoneId !== bug.milestoneId) {
      const milestone = input.milestoneId ? await assertMilestone(tx, input.milestoneId, bug.projectId) : null;
      patch.milestoneId = milestone?.id ?? null;
      await log("bug.milestone_changed", { to: milestone?.name ?? null });
    }
    if (input.tagIds !== undefined) {
      const ids = await replaceTags(tx, bug.id, bug.projectId, input.tagIds);
      await log("bug.tags_changed", { count: ids.length });
    }
    const batch = new NotificationBatch();
    if (input.assigneeId !== undefined && input.assigneeId !== bug.assigneeId) {
      const [assigneeId] = input.assigneeId ? await filterProjectMembers(access.project, [input.assigneeId], tx) : [];
      if (input.assigneeId && !assigneeId) throw invalid("That person can't open this project.");
      patch.assigneeId = assigneeId ?? null;
      await log("bug.assignee_changed", { userId: assigneeId ?? null, from: bug.assigneeId });
      if (assigneeId) batch.add(bugNotice(ctx, actor.userId, "BUG_ASSIGNED", [assigneeId]));
    }
    if (input.reviewerId !== undefined && input.reviewerId !== bug.reviewerId) {
      const [reviewerId] = input.reviewerId ? await filterProjectMembers(access.project, [input.reviewerId], tx) : [];
      if (input.reviewerId && !reviewerId) throw invalid("That person can't open this project.");
      patch.reviewerId = reviewerId ?? null;
      await log("bug.reviewer_changed", { userId: reviewerId ?? null, from: bug.reviewerId });
      if (reviewerId) batch.add(bugNotice(ctx, actor.userId, "BUG_REVIEWER_ASSIGNED", [reviewerId]));
    }
    if (Object.keys(patch).length || input.tagIds !== undefined) {
      await tx.update(bugs).set({ ...patch, lastActivityAt: now() }).where(eq(bugs.id, bug.id));
    }
    fx.notify(await batch.send(tx));
    fx.bug(bug.projectId, bug.id);
  });
  fx.flush(actor.clientId);
  return getBug(actor, bug.id);
}

// ── The fix workflow ────────────────────────────────────────────────────────

/**
 * Moves a bug along: In progress (the assignee starts, taking it if nobody has it) → Fixed (waits
 * for verification) → Verified by the reviewer; or Closed with a reason. Reopening (to Open, or
 * back to In progress from Fixed) clears what was recorded.
 */
export async function setBugStatus(actor: Actor, input: { bugId: string; status: BugStatus; resolution?: BugResolution | null }): Promise<BugDetailDTO> {
  const ctx = await requireBug(actor.userId, input.bugId);
  const { bug, access, perms } = ctx;
  const from = bug.status;
  const to = input.status;
  if (from === to && !(to === "CLOSED" && input.resolution && input.resolution !== bug.resolution)) return loadDetail(ctx);

  const at = now();
  const patch: Partial<typeof bugs.$inferInsert> = { status: to, lastActivityAt: at };
  const batch = new NotificationBatch();
  const others = (ids: Array<string | null>) => ids.filter((id): id is string => Boolean(id) && id !== actor.userId);

  switch (to) {
    case "IN_PROGRESS": {
      if (from === "FIXED" || from === "VERIFIED" || from === "CLOSED") {
        // Sent back: the fix didn't hold (or it's being looked at again).
        if (!perms.canVerify && !perms.canEdit) throw forbidden("Only the reviewer or a manager can send a fix back.");
        Object.assign(patch, { fixedAt: null, fixedById: null, verifiedAt: null, verifiedById: null, closedAt: null, closedById: null, resolution: null });
        batch.add(bugNotice(ctx, actor.userId, "BUG_REOPENED", others([bug.assigneeId]), { from }));
      } else if (!perms.canEdit) {
        if (!bug.assigneeId && perms.canSelfAssign) patch.assigneeId = actor.userId;
        else throw forbidden("You don't have permission to work on this bug.");
      }
      if (!bug.assigneeId && !patch.assigneeId) patch.assigneeId = actor.userId;
      break;
    }
    case "FIXED": {
      assertBug(perms, "canEdit", "Only the assignee or a manager can mark a bug fixed.");
      if (from === "VERIFIED" || from === "CLOSED") throw invalid("Reopen the bug first.");
      Object.assign(patch, { fixedAt: at, fixedById: actor.userId, verifiedAt: null, verifiedById: null });
      if (!bug.assigneeId) patch.assigneeId = actor.userId;
      batch.add(bugNotice(ctx, actor.userId, "BUG_FIXED", others([bug.reviewerId ?? bug.reportedById])));
      break;
    }
    case "VERIFIED": {
      assertBug(perms, "canVerify", "Only the reviewer or a manager who isn't fixing it can verify this bug.");
      if (from === "CLOSED") throw invalid("Reopen the bug first.");
      Object.assign(patch, { fixedAt: bug.fixedAt ?? at, fixedById: bug.fixedById ?? bug.assigneeId ?? actor.userId, verifiedAt: at, verifiedById: actor.userId });
      batch.add(bugNotice(ctx, actor.userId, "BUG_RESOLVED", others([bug.assigneeId, bug.reportedById]), { status: to }));
      break;
    }
    case "CLOSED": {
      assertBug(perms, "canClose", "Only a manager or the reporter can close a bug without a fix.");
      if (!input.resolution) throw invalid("Say why it's closed.");
      Object.assign(patch, { closedAt: bug.closedAt ?? at, closedById: actor.userId, resolution: input.resolution });
      if (from !== "CLOSED") batch.add(bugNotice(ctx, actor.userId, "BUG_RESOLVED", others([bug.assigneeId, bug.reportedById]), { status: to, resolution: input.resolution }));
      break;
    }
    case "OPEN": {
      if (!perms.canEdit && !perms.canVerify) throw forbidden("You don't have permission to reopen this bug.");
      Object.assign(patch, { fixedAt: null, fixedById: null, verifiedAt: null, verifiedById: null, closedAt: null, closedById: null, resolution: null });
      batch.add(bugNotice(ctx, actor.userId, "BUG_REOPENED", others([bug.assigneeId]), { from }));
      break;
    }
  }

  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.update(bugs).set(patch).where(eq(bugs.id, bug.id));
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: bug.projectId,
      bugId: bug.id,
      actorId: actor.userId,
      type: "bug.status_changed",
      data: { from, to, resolution: to === "CLOSED" ? input.resolution : null },
    });
    if (patch.assigneeId && patch.assigneeId !== bug.assigneeId) {
      await logActivity(tx, { studioId: access.studioId, projectId: bug.projectId, bugId: bug.id, actorId: actor.userId, type: "bug.assignee_changed", data: { userId: patch.assigneeId, from: bug.assigneeId } });
    }
    fx.notify(await batch.send(tx));
    fx.bug(bug.projectId, bug.id);
  });
  fx.flush(actor.clientId);
  return getBug(actor, bug.id);
}

// ── Comments ────────────────────────────────────────────────────────────────

async function resolveMentions(tx: Executor, access: ProjectAccess, body: string): Promise<string[]> {
  const usernames = extractMentions(body);
  if (usernames.length === 0) return [];
  const rows = await tx.select({ id: users.id }).from(users).where(inArray(users.username, usernames));
  return filterProjectMembers(access.project, rows.map((r) => r.id), tx);
}

export async function addBugComment(actor: Actor, input: { bugId: string; body: string }): Promise<BugDetailDTO> {
  enforceRateLimit(`bug-comment:${actor.userId}`, 60, 60 * 1000);
  const ctx = await requireBug(actor.userId, input.bugId);
  assertBug(ctx.perms, "canComment", "You don't have permission to comment on this bug.");
  const body = input.body.trim();
  if (!body) throw invalid("Write a comment.");
  if (body.length > 10_000) throw invalid("Comments are limited to 10,000 characters.");
  const { bug, access } = ctx;
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.insert(bugComments).values({ bugId: bug.id, projectId: bug.projectId, authorId: actor.userId, body, createdAt: now() });
    await logActivity(tx, { studioId: access.studioId, projectId: bug.projectId, bugId: bug.id, actorId: actor.userId, type: "bug.commented", data: { excerpt: excerpt(body) } });
    await touchBug(tx, bug.id);
    const mentioned = await resolveMentions(tx, access, body);
    const batch = new NotificationBatch();
    if (mentioned.length) batch.add(bugNotice(ctx, actor.userId, "MENTIONED", mentioned, { excerpt: excerpt(body) }));
    batch.add(bugNotice(ctx, actor.userId, "BUG_COMMENT", [bug.assigneeId, bug.reviewerId, bug.reportedById], { excerpt: excerpt(body) }));
    fx.notify(await batch.send(tx));
    fx.bug(bug.projectId, bug.id);
  });
  fx.flush(actor.clientId);
  return getBug(actor, bug.id);
}

async function loadComment(actor: Actor, commentId: string) {
  const [comment] = await db.select().from(bugComments).where(eq(bugComments.id, commentId));
  if (!comment || comment.deletedAt) throw notFound("Comment");
  const ctx = await requireBug(actor.userId, comment.bugId);
  return { comment, ctx };
}

export async function editBugComment(actor: Actor, input: { commentId: string; body: string }): Promise<BugDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  if (comment.authorId !== actor.userId) throw forbidden("You can only edit your own comments.");
  assertBug(ctx.perms, "canComment");
  const body = input.body.trim();
  if (!body) throw invalid("Write a comment.");
  if (body.length > 10_000) throw invalid("Comments are limited to 10,000 characters.");
  await db.update(bugComments).set({ body, editedAt: now() }).where(eq(bugComments.id, comment.id));
  new Effects().bug(ctx.bug.projectId, ctx.bug.id).flush(actor.clientId);
  return getBug(actor, ctx.bug.id);
}

export async function deleteBugComment(actor: Actor, input: { commentId: string }): Promise<BugDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  if (comment.authorId !== actor.userId && !roleHas(ctx.access.role, "comment.moderate")) throw forbidden("You can only delete your own comments.");
  await db.update(bugComments).set({ deletedAt: now() }).where(eq(bugComments.id, comment.id));
  new Effects().bug(ctx.bug.projectId, ctx.bug.id).flush(actor.clientId);
  return getBug(actor, ctx.bug.id);
}

// ── Files ───────────────────────────────────────────────────────────────────

/** Takes a picture or clip off a bug for good (the stored files are cleaned up). */
export async function removeBugAttachment(actor: Actor, input: { attachmentId: string }): Promise<BugDetailDTO> {
  const [file] = await db.select().from(attachments).where(eq(attachments.id, input.attachmentId));
  if (!file || !file.bugId) throw notFound("File");
  const ctx = await requireBug(actor.userId, file.bugId);
  const own = file.uploadedById === actor.userId;
  if (!(ctx.perms.canUpload || (own && ctx.perms.canComment))) throw forbidden("You can't remove this file.");
  await db.transaction(async (tx) => {
    await tx.delete(attachments).where(eq(attachments.id, file.id));
    await enqueueStorageCleanup(tx, storageUnits(file), `bug file ${file.id} removed`);
    await logActivity(tx, { studioId: ctx.access.studioId, projectId: ctx.bug.projectId, bugId: ctx.bug.id, actorId: actor.userId, type: "bug.attachment_removed", data: { filename: file.filename } });
    await touchBug(tx, ctx.bug.id);
  });
  new Effects().bug(ctx.bug.projectId, ctx.bug.id).flush(actor.clientId);
  return getBug(actor, ctx.bug.id);
}

// ── Deleting ────────────────────────────────────────────────────────────────

/** Permanently deletes a bug with its comments and files (admins; closing is the usual way to retire one). */
export async function deleteBug(actor: Actor, input: { bugId: string }) {
  const ctx = await requireBug(actor.userId, input.bugId);
  assertBug(ctx.perms, "canDelete", "Only admins can delete bugs. Close it instead.");
  await db.transaction(async (tx) => {
    const files = await tx.select().from(attachments).where(eq(attachments.bugId, ctx.bug.id));
    await tx.delete(bugs).where(eq(bugs.id, ctx.bug.id));
    await enqueueStorageCleanup(tx, [...new Set(files.flatMap(storageUnits))], `bug ${ctx.bug.id} deleted`);
  });
  new Effects().bug(ctx.bug.projectId, null).flush(actor.clientId);
  return { ok: true };
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function createBugTag(actor: Actor, input: { projectId: string; name: string; color: string }): Promise<BugTagDTO> {
  await requireProject(actor.userId, input.projectId, "bugtag.manage");
  try {
    const [row] = await db.insert(bugTags).values({ projectId: input.projectId, name: input.name.trim(), color: input.color }).returning();
    new Effects().bug(input.projectId, null).flush(actor.clientId);
    return tagToDTO(row!);
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid(`A tag called "${input.name.trim()}" already exists.`);
    throw error;
  }
}

async function loadTag(tagId: string) {
  const [tag] = await db.select().from(bugTags).where(eq(bugTags.id, tagId));
  if (!tag) throw notFound("Tag");
  return tag;
}

export async function updateBugTag(actor: Actor, input: { tagId: string; name?: string; color?: string }): Promise<BugTagDTO> {
  const tag = await loadTag(input.tagId);
  await requireProject(actor.userId, tag.projectId, "bugtag.manage");
  try {
    const [row] = await db
      .update(bugTags)
      .set({ ...(input.name ? { name: input.name.trim() } : {}), ...(input.color ? { color: input.color } : {}) })
      .where(eq(bugTags.id, tag.id))
      .returning();
    new Effects().bug(tag.projectId, null).flush(actor.clientId);
    return tagToDTO(row!);
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid("Another tag already uses that name.");
    throw error;
  }
}

export async function deleteBugTag(actor: Actor, input: { tagId: string }) {
  const tag = await loadTag(input.tagId);
  await requireProject(actor.userId, tag.projectId, "bugtag.manage");
  await db.delete(bugTags).where(eq(bugTags.id, tag.id));
  new Effects().bug(tag.projectId, null).flush(actor.clientId);
  return { ok: true };
}
