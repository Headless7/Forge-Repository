import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { deliverableTeam } from "@/lib/deliverables";
import { roleHas } from "@/lib/permissions";
import type { CardDetailDTO, CardState } from "@/lib/types";
import { assertDeliverable, requireCard, requireDeliverable, type DeliverableAccess } from "../access";
import { now } from "../clock";
import { db, type Tx } from "../db";
import { assetVersions, cardReviewers, cards, comments, deliverables, reviews } from "../db/schema";
import { conflict, invalid } from "../errors";
import { logActivity } from "./activity";
import { loadCardDetail } from "./card-dto";
import { addWatchers, cardNotificationData, watcherIds } from "./cards";
import type { Actor } from "./context";
import { recomputeCardRollup } from "./deliverables";
import { queueDiscordEvent } from "./discord";
import { Effects } from "./effects";
import { listProjectMembers } from "./members-query";
import { NotificationBatch } from "./notifications";
import { addDependencyNotifications, dependencyChanges, loadCardWork, type CardWork } from "./workflow";

type VersionRow = typeof assetVersions.$inferSelect;

async function currentVersion(tx: Tx, ctx: DeliverableAccess, versionId?: string | null): Promise<VersionRow | null> {
  if (versionId) {
    const rows = await tx
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.id, versionId), eq(assetVersions.deliverableId, ctx.deliverable.id)));
    if (!rows[0]) throw invalid("That revision doesn't belong to this deliverable.");
    return rows[0];
  }
  const [d] = await tx.select({ currentVersionId: deliverables.currentVersionId }).from(deliverables).where(eq(deliverables.id, ctx.deliverable.id));
  if (!d?.currentVersionId) return null;
  const rows = await tx.select().from(assetVersions).where(eq(assetVersions.id, d.currentVersionId));
  return rows[0] ?? null;
}

/** Sets one deliverable's state and re-derives the card roll-up. */
async function setState(tx: Tx, ctx: DeliverableAccess, state: CardState, actorId: string, extra: Partial<typeof deliverables.$inferInsert> = {}) {
  await tx.update(deliverables).set({ state, ...extra }).where(eq(deliverables.id, ctx.deliverable.id));
  await recomputeCardRollup(tx, ctx.card.id);
  await tx
    .update(cards)
    .set({ revision: sql`${cards.revision} + 1`, lastActivityAt: now(), lastActivityById: actorId })
    .where(eq(cards.id, ctx.card.id));
}

async function reviewerRecipients(tx: Tx, ctx: DeliverableAccess): Promise<string[]> {
  if (ctx.deliverable.reviewerId) return [ctx.deliverable.reviewerId];
  const explicit = await tx.select({ userId: cardReviewers.userId }).from(cardReviewers).where(eq(cardReviewers.cardId, ctx.card.id));
  if (explicit.length) return explicit.map((r) => r.userId);
  // No named reviewers: everyone who can review in this project is asked.
  const members = await listProjectMembers(ctx.access.project, tx);
  return members.filter((m) => roleHas(m.role, "card.review")).map((m) => m.id);
}

/** Who works on this deliverable (its own team, or the card's assignees when it inherits). */
function team(ctx: DeliverableAccess): string[] {
  return deliverableTeam({ ownerId: ctx.deliverable.ownerId, contributorIds: ctx.contributorIds }, ctx.assigneeIds).ids;
}

/** People a decision is for: whoever works on the deliverable, plus whoever submitted/created the revision. */
function workOwners(ctx: DeliverableAccess, version: VersionRow | null): string[] {
  return [...team(ctx), version?.submittedById, version?.createdById].filter((id): id is string => Boolean(id));
}

/** Adds notices for dependants that became ready, got closer, or are waiting again after a change. */
async function addDependants(batch: NotificationBatch, tx: Tx, ctx: DeliverableAccess, actorId: string, before: CardWork, approvedId?: string) {
  const after = await loadCardWork(tx, ctx.card.id);
  addDependencyNotifications(batch, after, dependencyChanges(before, after, approvedId), {
    actorId,
    studioId: ctx.access.studioId,
    projectId: ctx.card.projectId,
    cardId: ctx.card.id,
    cardData: cardNotificationData(ctx.access, ctx.card),
  });
  return batch;
}

async function scopeLabel(tx: Tx, ctx: DeliverableAccess): Promise<string | undefined> {
  const [agg] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(deliverables)
    .where(and(eq(deliverables.cardId, ctx.card.id), isNull(deliverables.archivedAt)));
  return (agg?.n ?? 1) > 1 ? ctx.deliverable.name : undefined;
}

async function detail(actor: Actor, cardId: string) {
  return loadCardDetail(await requireCard(actor.userId, cardId));
}

// ── Submit ──────────────────────────────────────────────────────────────────

export async function submitForReview(
  actor: Actor,
  input: { deliverableId: string; versionId?: string | null; note?: string },
): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  assertDeliverable(ctx.dperms, "canSubmit", "Only people working on this deliverable can submit it for review.");
  if (ctx.deliverable.state === "NEEDS_REVIEW") throw conflict(`${ctx.deliverable.name} is already waiting for review.`);

  const fx = new Effects();
  await db.transaction(async (tx) => {
    const version = await currentVersion(tx, ctx, input.versionId);
    if (version?.status === "APPROVED" && ctx.deliverable.state === "APPROVED") {
      throw invalid(`V${version.versionNumber} is already approved. Upload a new revision to submit again.`);
    }
    const at = now();
    if (version) {
      await tx
        .update(assetVersions)
        .set({ status: "IN_REVIEW", submittedAt: at, submittedById: actor.userId, decidedAt: null, decidedById: null })
        .where(eq(assetVersions.id, version.id));
    }
    const [submitted] = await tx
      .insert(reviews)
      .values({
        cardId: ctx.card.id,
        deliverableId: ctx.deliverable.id,
        versionId: version?.id ?? null,
        actorId: actor.userId,
        action: "SUBMITTED",
        note: input.note?.trim() ?? "",
        createdAt: at,
      })
      .returning({ id: reviews.id });
    await setState(tx, ctx, "NEEDS_REVIEW", actor.userId);
    await addWatchers(tx, ctx.card.id, [actor.userId]);
    const deliverableName = await scopeLabel(tx, ctx);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "review.submitted",
      data: { versionNumber: version?.versionNumber ?? null, note: input.note?.trim() || undefined, deliverable: deliverableName, deliverableId: ctx.deliverable.id },
    });

    // A resubmission follows a change request on this deliverable.
    const [earlier] = await tx
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.deliverableId, ctx.deliverable.id), eq(reviews.action, "CHANGES_REQUESTED")))
      .limit(1);
    const data = {
      ...cardNotificationData(ctx.access, ctx.card),
      versionNumber: version?.versionNumber ?? null,
      deliverable: deliverableName,
      deliverableNumber: ctx.deliverable.number,
      resubmission: Boolean(earlier),
    };
    const where = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, deliverableId: ctx.deliverable.id, versionId: version?.id ?? null };
    const notified = await new NotificationBatch()
      .add({ ...where, recipientIds: await reviewerRecipients(tx, ctx), actorId: actor.userId, type: "REVIEW_REQUESTED", data })
      .add({
        ...where,
        recipientIds: await watcherIds(tx, ctx.card.id),
        actorId: actor.userId,
        type: "WATCHED_CARD",
        data: { ...data, change: deliverableName ? `submitted ${deliverableName} for review` : "submitted it for review" },
      })
      .send(tx);
    fx.notify(notified).card(ctx.card.projectId, ctx.card.id);
    fx.discord(
      await queueDiscordEvent(
        tx,
        { type: "REVIEW_SUBMITTED", projectId: ctx.card.projectId, boardId: ctx.card.boardId, cardId: ctx.card.id, deliverableId: ctx.deliverable.id, actorId: actor.userId, versionNumber: version?.versionNumber ?? null, resubmission: Boolean(earlier), at: at.toISOString() },
        `review:${submitted!.id}`,
      ),
    );
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

export async function withdrawSubmission(actor: Actor, input: { deliverableId: string }): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  assertDeliverable(ctx.dperms, "canSubmit");
  if (ctx.deliverable.state !== "NEEDS_REVIEW") throw conflict(`${ctx.deliverable.name} isn't waiting for review anymore.`);
  await db.transaction(async (tx) => {
    const version = await currentVersion(tx, ctx);
    if (version?.status === "IN_REVIEW") {
      await tx.update(assetVersions).set({ status: "DRAFT" }).where(eq(assetVersions.id, version.id));
    }
    await tx.insert(reviews).values({
      cardId: ctx.card.id,
      deliverableId: ctx.deliverable.id,
      versionId: version?.id ?? null,
      actorId: actor.userId,
      action: "WITHDRAWN",
      createdAt: now(),
    });
    await setState(tx, ctx, "IN_PROGRESS", actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "review.withdrawn",
      data: { versionNumber: version?.versionNumber ?? null, deliverable: await scopeLabel(tx, ctx) },
    });
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

// ── Decisions ───────────────────────────────────────────────────────────────

function reviewDenied(ctx: DeliverableAccess, actorId: string) {
  const own = team(ctx).includes(actorId);
  return own
    ? "You're responsible for this work, and this project doesn't allow approving your own work."
    : "You don't have permission to review work in this project.";
}

export async function approve(
  actor: Actor,
  input: { deliverableId: string; note?: string; resolveOpenFeedback?: boolean },
): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  assertDeliverable(ctx.dperms, "canReview", reviewDenied(ctx, actor.userId));
  if (ctx.deliverable.state === "APPROVED") throw conflict(`${ctx.deliverable.name} is already approved.`);

  const fx = new Effects();
  await db.transaction(async (tx) => {
    const before = await loadCardWork(tx, ctx.card.id);
    const version = await currentVersion(tx, ctx);
    const at = now();
    const [review] = await tx
      .insert(reviews)
      .values({
        cardId: ctx.card.id,
        deliverableId: ctx.deliverable.id,
        versionId: version?.id ?? null,
        actorId: actor.userId,
        action: "APPROVED",
        note: input.note?.trim() ?? "",
        createdAt: at,
      })
      .returning();
    if (version) {
      await tx
        .update(assetVersions)
        .set({ status: "APPROVED", decidedAt: at, decidedById: actor.userId, submittedAt: version.submittedAt ?? at })
        .where(eq(assetVersions.id, version.id));
    }
    if (input.resolveOpenFeedback) {
      await tx
        .update(comments)
        .set({ resolvedAt: at, resolvedById: actor.userId })
        .where(
          and(
            eq(comments.deliverableId, ctx.deliverable.id),
            eq(comments.kind, "FEEDBACK"),
            isNull(comments.resolvedAt),
            isNull(comments.parentId),
          ),
        );
    }
    await setState(tx, ctx, "APPROVED", actor.userId, version ? { approvedVersionId: version.id } : {});
    await addWatchers(tx, ctx.card.id, [actor.userId]);
    const deliverableName = await scopeLabel(tx, ctx);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "review.approved",
      data: { versionNumber: version?.versionNumber ?? null, reviewId: review!.id, deliverable: deliverableName, deliverableId: ctx.deliverable.id },
    });

    const data = {
      ...cardNotificationData(ctx.access, ctx.card),
      versionNumber: version?.versionNumber ?? null,
      note: input.note?.trim() || undefined,
      deliverable: deliverableName,
      deliverableNumber: ctx.deliverable.number,
    };
    const where = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, deliverableId: ctx.deliverable.id, versionId: version?.id ?? null };
    const batch = new NotificationBatch().add({ ...where, recipientIds: workOwners(ctx, version), actorId: actor.userId, type: "APPROVED", data });
    // Dependants that are now ready (or one step closer).
    await addDependants(batch, tx, ctx, actor.userId, before, ctx.deliverable.id);
    batch.add({
      ...where,
      recipientIds: await watcherIds(tx, ctx.card.id),
      actorId: actor.userId,
      type: "WATCHED_CARD",
      data: { ...data, change: deliverableName ? `approved ${deliverableName}` : "approved it" },
    });
    fx.notify(await batch.send(tx)).card(ctx.card.projectId, ctx.card.id);
    fx.discord(
      await queueDiscordEvent(
        tx,
        { type: "APPROVED", projectId: ctx.card.projectId, boardId: ctx.card.boardId, cardId: ctx.card.id, deliverableId: ctx.deliverable.id, actorId: actor.userId, versionNumber: version?.versionNumber ?? null, at: now().toISOString() },
        `review:${review!.id}`,
      ),
    );
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

export async function requestChanges(
  actor: Actor,
  input: { deliverableId: string; note?: string; items?: string[] },
): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  assertDeliverable(ctx.dperms, "canReview", reviewDenied(ctx, actor.userId));
  const items = (input.items ?? []).map((i) => i.trim()).filter(Boolean);
  if (items.length > 30) throw invalid("Add at most 30 feedback items at once.");

  const fx = new Effects();
  await db.transaction(async (tx) => {
    const before = await loadCardWork(tx, ctx.card.id);
    const version = await currentVersion(tx, ctx);
    // Feedback already left on this revision (or on the deliverable) becomes part of the decision.
    const pending = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.deliverableId, ctx.deliverable.id),
          version ? sql`(${comments.versionId} = ${version.id} or ${comments.versionId} is null)` : isNull(comments.versionId),
          eq(comments.kind, "FEEDBACK"),
          isNull(comments.parentId),
          isNull(comments.resolvedAt),
          isNull(comments.deletedAt),
          isNull(comments.reviewId),
        ),
      );
    if (ctx.access.project.settings.requireFeedbackForChanges && items.length === 0 && pending.length === 0) {
      throw invalid("Add at least one feedback item so the artist knows what to change.");
    }
    const at = now();
    const [review] = await tx
      .insert(reviews)
      .values({
        cardId: ctx.card.id,
        deliverableId: ctx.deliverable.id,
        versionId: version?.id ?? null,
        actorId: actor.userId,
        action: "CHANGES_REQUESTED",
        note: input.note?.trim() ?? "",
        createdAt: at,
      })
      .returning();
    if (items.length) {
      await tx.insert(comments).values(
        items.map((body, i) => ({
          cardId: ctx.card.id,
          projectId: ctx.card.projectId,
          deliverableId: ctx.deliverable.id,
          authorId: actor.userId,
          kind: "FEEDBACK" as const,
          body,
          versionId: version?.id ?? null,
          reviewId: review!.id,
          // Keep the reviewer's order stable.
          createdAt: new Date(at.getTime() + i),
        })),
      );
    }
    if (pending.length) {
      await tx.update(comments).set({ reviewId: review!.id }).where(inArray(comments.id, pending.map((p) => p.id)));
    }
    if (version) {
      await tx
        .update(assetVersions)
        .set({ status: "CHANGES_REQUESTED", decidedAt: at, decidedById: actor.userId, submittedAt: version.submittedAt ?? at })
        .where(eq(assetVersions.id, version.id));
    }
    await setState(tx, ctx, "CHANGES_REQUESTED", actor.userId);
    await addWatchers(tx, ctx.card.id, [actor.userId]);
    const total = items.length + pending.length;
    const deliverableName = await scopeLabel(tx, ctx);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "review.changes_requested",
      data: { versionNumber: version?.versionNumber ?? null, feedbackCount: total, reviewId: review!.id, deliverable: deliverableName, deliverableId: ctx.deliverable.id },
    });

    const data = {
      ...cardNotificationData(ctx.access, ctx.card),
      versionNumber: version?.versionNumber ?? null,
      feedbackCount: total,
      note: input.note?.trim() || undefined,
      firstItem: items[0],
      deliverable: deliverableName,
      deliverableNumber: ctx.deliverable.number,
    };
    const where = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, deliverableId: ctx.deliverable.id, versionId: version?.id ?? null };
    const batch = new NotificationBatch().add({ ...where, recipientIds: workOwners(ctx, version), actorId: actor.userId, type: "CHANGES_REQUESTED", data });
    // If this work had been approved, what depends on it is waiting again.
    await addDependants(batch, tx, ctx, actor.userId, before);
    batch.add({
      ...where,
      recipientIds: await watcherIds(tx, ctx.card.id),
      actorId: actor.userId,
      type: "WATCHED_CARD",
      data: { ...data, change: deliverableName ? `requested changes on ${deliverableName}` : "requested changes" },
    });
    fx.notify(await batch.send(tx)).card(ctx.card.projectId, ctx.card.id);
    fx.discord(
      await queueDiscordEvent(
        tx,
        { type: "CHANGES_REQUESTED", projectId: ctx.card.projectId, boardId: ctx.card.boardId, cardId: ctx.card.id, deliverableId: ctx.deliverable.id, actorId: actor.userId, versionNumber: version?.versionNumber ?? null, at: now().toISOString() },
        `review:${review!.id}`,
      ),
    );
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

/**
 * Status changes outside the formal decisions (reopen, back to in-progress …). Review
 * outcomes route through the workflow above so history is never bypassed.
 */
export async function setDeliverableState(actor: Actor, input: { deliverableId: string; state: CardState }): Promise<CardDetailDTO> {
  const ctx = await requireDeliverable(actor.userId, input.deliverableId);
  const from = ctx.deliverable.state;
  if (from === input.state) return loadCardDetail(ctx);
  switch (input.state) {
    case "NEEDS_REVIEW":
      return submitForReview(actor, { deliverableId: input.deliverableId });
    case "APPROVED":
      return approve(actor, { deliverableId: input.deliverableId });
    case "CHANGES_REQUESTED":
      return requestChanges(actor, { deliverableId: input.deliverableId });
    default:
      break;
  }
  if (from === "NEEDS_REVIEW" && ctx.dperms.canSubmit && !ctx.dperms.canReview) {
    return withdrawSubmission(actor, { deliverableId: input.deliverableId });
  }
  const reopening = from === "APPROVED" || from === "CHANGES_REQUESTED" || from === "NEEDS_REVIEW";
  if (!(ctx.dperms.canEdit || ctx.dperms.canUpload || (reopening && ctx.dperms.canReview))) {
    assertDeliverable(ctx.dperms, "canEdit");
  }
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const before = await loadCardWork(tx, ctx.card.id);
    if (reopening) {
      const version = await currentVersion(tx, ctx);
      await tx.insert(reviews).values({
        cardId: ctx.card.id,
        deliverableId: ctx.deliverable.id,
        versionId: version?.id ?? null,
        actorId: actor.userId,
        action: from === "NEEDS_REVIEW" ? "WITHDRAWN" : "REOPENED",
        createdAt: now(),
      });
      if (version && version.status === "IN_REVIEW") {
        await tx.update(assetVersions).set({ status: "DRAFT" }).where(eq(assetVersions.id, version.id));
      }
    }
    // Reopening never erases the approval record: approvedVersionId keeps pointing at the approved revision.
    await setState(tx, ctx, input.state, actor.userId);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: reopening && from === "APPROVED" ? "review.reopened" : "card.state_changed",
      data: { from, to: input.state, deliverable: await scopeLabel(tx, ctx) },
    });
    // Reopening approved work makes what depends on it wait again.
    const batch = await addDependants(new NotificationBatch(), tx, ctx, actor.userId, before);
    fx.notify(await batch.send(tx)).card(ctx.card.projectId, ctx.card.id);
  });
  fx.flush(actor.clientId);
  return detail(actor, ctx.card.id);
}

/**
 * Quick status change from the board. Only unambiguous for single-deliverable cards;
 * cards with several deliverables are changed per deliverable in the card.
 */
export async function setCardState(actor: Actor, input: { cardId: string; state: CardState }): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  const active = await db
    .select({ id: deliverables.id })
    .from(deliverables)
    .where(and(eq(deliverables.cardId, ctx.card.id), isNull(deliverables.archivedAt)));
  if (active.length !== 1) {
    throw conflict(`This card has ${active.length} deliverables — open it to change their review status individually.`);
  }
  return setDeliverableState(actor, { deliverableId: active[0]!.id, state: input.state });
}
