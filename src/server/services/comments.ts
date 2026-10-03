import { and, eq, inArray, isNull } from "drizzle-orm";
import { extractMentions, REACTION_EMOJIS } from "@/lib/mentions";
import type { AnnotationType, CardDetailDTO, CommentKind } from "@/lib/types";
import { deliverableTeam } from "@/lib/deliverables";
import { assertCard, computeDeliverablePermissions, loadContributors, requireCard, type CardAccess } from "../access";
import { now } from "../clock";
import { db, type Tx } from "../db";
import { assetVersions, attachments, commentMentions, commentReactions, comments, deliverables, mediaAnnotations, users } from "../db/schema";
import { forbidden, invalid, notFound } from "../errors";
import { enforceRateLimit } from "../rate-limit";
import { logActivity } from "./activity";
import { loadCardDetail } from "./card-dto";
import { addWatchers, cardNotificationData, touchCard } from "./cards";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { filterProjectMembers } from "./members-query";
import { notify, NotificationBatch } from "./notifications";

export interface AnnotationInput {
  type: AnnotationType;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  timestampMs?: number | null;
}

export interface CreateCommentInput {
  cardId: string;
  body: string;
  kind?: CommentKind;
  parentId?: string | null;
  /** Scope: null = the card as a whole; otherwise one deliverable. File feedback derives it from the file. */
  deliverableId?: string | null;
  versionId?: string | null;
  attachmentId?: string | null;
  annotation?: AnnotationInput | null;
  attachmentIds?: string[];
}

const unit = (v: number | null | undefined) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Validates annotation geometry against the media it points at. Coordinates are normalised (0–1). */
function validateAnnotation(annotation: AnnotationInput, media: typeof attachments.$inferSelect) {
  if (annotation.type === "TIMESTAMP") {
    // Videos, audio, and Roblox animations (timeline of the previewed animation) take timestamps.
    if (media.kind !== "VIDEO" && media.kind !== "AUDIO" && media.kind !== "ROBLOX") {
      throw invalid("Timestamp feedback can only be left on videos, audio and animations.");
    }
    const t = annotation.timestampMs;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t > 24 * 3600 * 1000) throw invalid("Invalid timestamp.");
    if (media.durationMs && t > media.durationMs + 1000) throw invalid("That timestamp is past the end of the file.");
    if (media.kind !== "VIDEO" && (annotation.x != null || annotation.y != null)) throw invalid("Points can only be placed on video frames.");
    if ((annotation.x != null || annotation.y != null) && !(unit(annotation.x) && unit(annotation.y))) {
      throw invalid("Invalid point on the video frame.");
    }
    return;
  }
  if (media.kind !== "IMAGE" && media.kind !== "VIDEO") throw invalid("Annotations can only be left on images and videos.");
  if (!unit(annotation.x) || !unit(annotation.y)) throw invalid("Annotation position must be inside the image.");
  if (annotation.type === "REGION") {
    if (!unit(annotation.width) || !unit(annotation.height) || !annotation.width || !annotation.height) {
      throw invalid("Invalid annotation region.");
    }
    if (annotation.x! + annotation.width > 1.0001 || annotation.y! + annotation.height > 1.0001) {
      throw invalid("Annotation region must stay inside the image.");
    }
  }
}

async function resolveMentions(tx: Tx, ctx: CardAccess, body: string): Promise<string[]> {
  const usernames = extractMentions(body);
  if (usernames.length === 0) return [];
  const rows = await tx.select({ id: users.id }).from(users).where(inArray(users.username, usernames));
  return filterProjectMembers(ctx.access.project, rows.map((r) => r.id), tx);
}

const excerpt = (body: string) => (body.length > 160 ? `${body.slice(0, 157)}…` : body);

export async function createComment(actor: Actor, input: CreateCommentInput): Promise<CardDetailDTO> {
  enforceRateLimit(`comment:${actor.userId}`, 60, 60 * 1000);
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canComment", "You don't have permission to comment on this card.");
  const body = input.body.trim();
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (!body && attachmentIds.length === 0) throw invalid("Write a comment or attach a file.");
  if (body.length > 10_000) throw invalid("Comments are limited to 10,000 characters.");

  const fx = new Effects();
  await db.transaction(async (tx) => {
    let kind: CommentKind = input.kind ?? "DISCUSSION";
    let deliverableId = input.deliverableId ?? null;
    let versionId = input.versionId ?? null;
    let attachmentId = input.attachmentId ?? null;
    let parent: typeof comments.$inferSelect | undefined;

    if (input.parentId) {
      [parent] = await tx.select().from(comments).where(and(eq(comments.id, input.parentId), eq(comments.cardId, ctx.card.id)));
      if (!parent || parent.deletedAt) throw notFound("Comment");
      if (parent.parentId) throw invalid("Replies can't be nested further.");
      kind = "DISCUSSION";
      deliverableId = parent.deliverableId;
      versionId = parent.versionId;
      attachmentId = null;
    }

    let media: typeof attachments.$inferSelect | undefined;
    if (attachmentId) {
      [media] = await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, attachmentId), eq(attachments.cardId, ctx.card.id)));
      if (!media) throw notFound("Attachment");
      // Feedback on a file always belongs to the revision (and deliverable) that file was uploaded in.
      versionId = media.versionId;
      deliverableId = media.deliverableId;
    }
    if (input.annotation && !parent) {
      if (!media) throw invalid("Annotations must point at an image or video.");
      validateAnnotation(input.annotation, media);
    }
    if (versionId && !media) {
      const [version] = await tx
        .select({ id: assetVersions.id, deliverableId: assetVersions.deliverableId })
        .from(assetVersions)
        .where(and(eq(assetVersions.id, versionId), eq(assetVersions.cardId, ctx.card.id)));
      if (!version) throw notFound("Version");
      deliverableId = version.deliverableId;
    }
    let scope: typeof deliverables.$inferSelect | undefined;
    if (deliverableId) {
      [scope] = await tx.select().from(deliverables).where(and(eq(deliverables.id, deliverableId), eq(deliverables.cardId, ctx.card.id)));
      if (!scope) throw notFound("Deliverable");
    }

    const [comment] = await tx
      .insert(comments)
      .values({
        cardId: ctx.card.id,
        projectId: ctx.card.projectId,
        parentId: parent?.id ?? null,
        authorId: actor.userId,
        kind,
        body,
        deliverableId,
        versionId,
        attachmentId,
        createdAt: now(),
      })
      .returning();

    if (input.annotation && media && !parent) {
      const a = input.annotation;
      await tx.insert(mediaAnnotations).values({
        commentId: comment!.id,
        attachmentId: media.id,
        versionId: media.versionId,
        type: a.type,
        x: a.x ?? null,
        y: a.y ?? null,
        width: a.type === "REGION" ? (a.width ?? null) : null,
        height: a.type === "REGION" ? (a.height ?? null) : null,
        timestampMs: a.type === "TIMESTAMP" ? (a.timestampMs ?? null) : null,
        createdAt: now(),
      });
    }

    if (attachmentIds.length) {
      const linked = await tx
        .update(attachments)
        .set({ commentId: comment!.id })
        .where(
          and(
            inArray(attachments.id, attachmentIds),
            eq(attachments.cardId, ctx.card.id),
            eq(attachments.purpose, "COMMENT"),
            eq(attachments.uploadedById, actor.userId),
            isNull(attachments.commentId),
          ),
        )
        .returning({ id: attachments.id });
      if (linked.length !== attachmentIds.length) throw invalid("Some attachments are no longer available. Please re-upload them.");
    }

    const mentioned = (await resolveMentions(tx, ctx, body)).filter((id) => id !== actor.userId);
    if (mentioned.length) {
      await tx.insert(commentMentions).values(mentioned.map((userId) => ({ commentId: comment!.id, userId }))).onConflictDoNothing();
    }

    const data = {
      ...cardNotificationData(ctx.access, ctx.card),
      excerpt: excerpt(body || "(attachment)"),
      kind,
      timestampMs: input.annotation?.timestampMs ?? null,
      deliverable: scope?.name,
      deliverableNumber: scope?.number,
    };
    const base = {
      actorId: actor.userId,
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      deliverableId: scope?.id ?? null,
      versionId,
      commentId: comment!.id,
      data,
    };
    // On a deliverable: the people working on it. On the card itself: its assignees and creator.
    const workers = scope
      ? deliverableTeam({ ownerId: scope.ownerId, contributorIds: (await loadContributors(tx, [scope.id])).get(scope.id) ?? [] }, ctx.assigneeIds).ids
      : [...ctx.assigneeIds, ctx.card.createdById].filter((id): id is string => Boolean(id));
    const notified = await new NotificationBatch()
      .add({ ...base, type: "MENTIONED", recipientIds: mentioned })
      .add({ ...base, type: "REPLY", recipientIds: parent?.authorId ? [parent.authorId] : [] })
      .add({ ...base, type: "COMMENT", recipientIds: workers })
      .send(tx);

    await addWatchers(tx, ctx.card.id, [actor.userId]);
    await touchCard(tx, ctx.card.id, actor.userId, false);
    fx.notify(notified).card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

async function loadComment(actor: Actor, commentId: string) {
  const [comment] = await db.select().from(comments).where(eq(comments.id, commentId));
  if (!comment) throw notFound("Comment");
  const ctx = await requireCard(actor.userId, comment.cardId);
  return { comment, ctx };
}

export async function editComment(actor: Actor, input: { commentId: string; body: string }): Promise<CardDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  if (comment.authorId !== actor.userId) throw forbidden("You can only edit your own comments.");
  if (comment.deletedAt) throw invalid("This comment was deleted.");
  assertCard(ctx.perms, "canComment");
  const body = input.body.trim();
  if (!body) throw invalid("Comments can't be empty. Delete the comment instead.");
  if (body.length > 10_000) throw invalid("Comments are limited to 10,000 characters.");

  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.update(comments).set({ body, editedAt: now() }).where(eq(comments.id, comment.id));
    const before = await tx.select({ userId: commentMentions.userId }).from(commentMentions).where(eq(commentMentions.commentId, comment.id));
    const known = new Set(before.map((m) => m.userId));
    const fresh = (await resolveMentions(tx, ctx, body)).filter((id) => id !== actor.userId && !known.has(id));
    if (fresh.length) {
      await tx.insert(commentMentions).values(fresh.map((userId) => ({ commentId: comment.id, userId }))).onConflictDoNothing();
      fx.notify(
        await notify(tx, {
          recipientIds: fresh,
          type: "MENTIONED",
          actorId: actor.userId,
          studioId: ctx.access.studioId,
          projectId: ctx.card.projectId,
          cardId: ctx.card.id,
          deliverableId: comment.deliverableId,
          versionId: comment.versionId,
          commentId: comment.id,
          data: { ...cardNotificationData(ctx.access, ctx.card), excerpt: excerpt(body), kind: comment.kind },
        }),
      );
    }
    fx.card(ctx.card.projectId, ctx.card.id, false);
  });
  fx.flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

export async function deleteComment(actor: Actor, input: { commentId: string }): Promise<CardDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  const own = comment.authorId === actor.userId;
  if (!own && !ctx.perms.canModerate) throw forbidden("You can only delete your own comments.");
  if (own && !ctx.perms.canComment && !ctx.perms.canModerate) throw forbidden();
  // Soft delete keeps thread structure and review history intact.
  await db.update(comments).set({ deletedAt: now() }).where(eq(comments.id, comment.id));
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

export async function setFeedbackResolved(actor: Actor, input: { commentId: string; resolved: boolean }): Promise<CardDetailDTO> {
  const { comment, ctx } = await loadComment(actor, input.commentId);
  if (comment.kind !== "FEEDBACK" || comment.parentId) throw invalid("Only feedback items can be resolved.");
  if (comment.deletedAt) throw invalid("This feedback was deleted.");
  let allowed = ctx.perms.canResolveFeedback;
  const [d] = comment.deliverableId ? await db.select().from(deliverables).where(eq(deliverables.id, comment.deliverableId)) : [];
  if (!allowed && d) {
    const contributors = (await loadContributors(db, [d.id])).get(d.id) ?? [];
    allowed = computeDeliverablePermissions(ctx, d, contributors).canResolveFeedback;
  }
  if (!allowed) throw forbidden("Only the people working on this card or reviewers can resolve feedback.");
  if (Boolean(comment.resolvedAt) === input.resolved) return loadCardDetail(ctx);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx
      .update(comments)
      .set(input.resolved ? { resolvedAt: now(), resolvedById: actor.userId } : { resolvedAt: null, resolvedById: null })
      .where(eq(comments.id, comment.id));
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: input.resolved ? "feedback.resolved" : "feedback.reopened",
      data: { commentId: comment.id, excerpt: excerpt(comment.body) },
    });
    await touchCard(tx, ctx.card.id, actor.userId, false);
    // Whoever gave the feedback hears that it was addressed (or reopened).
    fx.notify(
      await notify(tx, {
        recipientIds: comment.authorId ? [comment.authorId] : [],
        actorId: actor.userId,
        type: "FEEDBACK_RESOLVED",
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        deliverableId: comment.deliverableId,
        versionId: comment.versionId,
        commentId: comment.id,
        data: { ...cardNotificationData(ctx.access, ctx.card), excerpt: excerpt(comment.body), resolved: input.resolved, deliverable: d?.name, deliverableNumber: d?.number },
      }),
    );
  });
  fx.card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

export async function toggleReaction(actor: Actor, input: { commentId: string; emoji: string }): Promise<CardDetailDTO> {
  if (!(REACTION_EMOJIS as readonly string[]).includes(input.emoji)) throw invalid("Unsupported reaction.");
  const { comment, ctx } = await loadComment(actor, input.commentId);
  assertCard(ctx.perms, "canComment");
  if (comment.deletedAt) throw invalid("This comment was deleted.");
  const where = and(
    eq(commentReactions.commentId, comment.id),
    eq(commentReactions.userId, actor.userId),
    eq(commentReactions.emoji, input.emoji),
  );
  const existing = await db.select().from(commentReactions).where(where);
  if (existing.length) await db.delete(commentReactions).where(where);
  else await db.insert(commentReactions).values({ commentId: comment.id, userId: actor.userId, emoji: input.emoji, createdAt: now() });
  new Effects().card(ctx.card.projectId, ctx.card.id, false).flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}
