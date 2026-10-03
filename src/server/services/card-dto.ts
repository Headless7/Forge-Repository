import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { blockedBy, computeProgress, computeReadiness, type DeliverableFacts, type LinkFacts } from "@/lib/deliverables";
import type {
  AttachmentDTO,
  AttachmentKind,
  CardDetailDTO,
  CardSummaryDTO,
  ChecklistDTO,
  CommentDTO,
  DeliverableDTO,
  MediaRefDTO,
  ReviewDTO,
  VersionDTO,
} from "@/lib/types";
import { computeDeliverablePermissions, loadContributors, type CardAccess, type CardRow, type DeliverableRow } from "../access";
import { db } from "../db";
import {
  assetVersions,
  attachments,
  cardAssignees,
  cardLabels,
  cardReviewers,
  cardViews,
  cardWatchers,
  checklistItems,
  checklists,
  commentMentions,
  commentReactions,
  comments,
  deliverableLinks,
  deliverables,
  mediaAnnotations,
  productionEvents,
  reviews,
} from "../db/schema";
import { storage } from "../storage";

export type AttachmentRow = typeof attachments.$inferSelect;

const UNREAD_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Kinds that render inline in the app (everything except generic files). */
const PREVIEWABLE = new Set<AttachmentKind>(["IMAGE", "VIDEO", "AUDIO", "ROBLOX"]);

export function derivedKeyOf(row: Pick<AttachmentRow, "meta">): string | null {
  const key = row.meta?.derivedKey;
  return typeof key === "string" ? key : null;
}

export async function attachmentToDTO(row: AttachmentRow): Promise<AttachmentDTO> {
  const store = storage();
  const ready = row.status === "READY" || row.status === "PROCESSING";
  const inline = row.kind === "IMAGE" || row.kind === "VIDEO" || row.kind === "AUDIO";
  const derivedKey = derivedKeyOf(row);
  const [url, thumbUrl, previewUrl, downloadUrl, derivedUrl] = await Promise.all([
    ready && inline ? store.signedUrl(row.playbackKey ?? row.storageKey) : null,
    row.thumbnailKey ? store.signedUrl(row.thumbnailKey) : null,
    row.previewKey ? store.signedUrl(row.previewKey) : null,
    ready ? store.signedUrl(row.storageKey, { downloadName: row.filename }) : null,
    ready && derivedKey ? store.signedUrl(derivedKey) : null,
  ]);
  const { derivedKey: _hidden, ...meta } = row.meta ?? {};
  return {
    id: row.id,
    cardId: row.cardId,
    versionId: row.versionId,
    deliverableId: row.deliverableId,
    commentId: row.commentId,
    purpose: row.purpose,
    kind: row.kind,
    status: row.status,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    fps: row.fps,
    url,
    thumbUrl,
    previewUrl,
    downloadUrl,
    uploadedById: row.uploadedById,
    createdAt: row.createdAt.toISOString(),
    error: row.error,
    meta: row.meta ? meta : null,
    previewConfig: row.previewConfig ?? null,
    derivedUrl,
  };
}

export async function mediaRef(row: AttachmentRow | undefined): Promise<MediaRefDTO | null> {
  if (!row || row.kind === "FILE" || row.archivedAt) return null;
  const store = storage();
  const [thumbUrl, previewUrl] = await Promise.all([
    row.thumbnailKey ? store.signedUrl(row.thumbnailKey) : null,
    row.kind === "VIDEO" && (row.status === "READY" || row.status === "PROCESSING")
      ? store.signedUrl(row.previewKey ?? row.playbackKey ?? row.storageKey)
      : null,
  ]);
  return {
    attachmentId: row.id,
    kind: row.kind,
    status: row.status,
    thumbUrl,
    previewUrl,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
  };
}

interface CardDeliverableFacts {
  rows: DeliverableRow[];
  facts: DeliverableFacts[];
  links: LinkFacts[];
  /** Contributors per deliverable. */
  contributors: Map<string, string[]>;
}

/** Deliverables, links and "has files" for many cards with a fixed number of queries. */
export async function loadDeliverableFacts(cardIds: string[]): Promise<Map<string, CardDeliverableFacts>> {
  const out = new Map<string, CardDeliverableFacts>();
  if (!cardIds.length) return out;
  const [rows, linkRows, fileRows, versionCounts] = await Promise.all([
    db.select().from(deliverables).where(inArray(deliverables.cardId, cardIds)).orderBy(asc(deliverables.position), asc(deliverables.number)),
    db.select().from(deliverableLinks).where(inArray(deliverableLinks.cardId, cardIds)),
    db
      .selectDistinct({ deliverableId: deliverables.id })
      .from(deliverables)
      .innerJoin(attachments, eq(attachments.versionId, deliverables.currentVersionId))
      .where(and(inArray(deliverables.cardId, cardIds), isNull(attachments.archivedAt), inArray(attachments.status, ["READY", "PROCESSING"]))),
    db
      .select({ deliverableId: assetVersions.deliverableId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(assetVersions)
      .where(inArray(assetVersions.cardId, cardIds))
      .groupBy(assetVersions.deliverableId),
  ]);
  const withFiles = new Set(fileRows.map((r) => r.deliverableId));
  const counts = new Map(versionCounts.map((r) => [r.deliverableId, r.n]));
  const contributors = await loadContributors(db, rows.map((r) => r.id));
  for (const id of cardIds) out.set(id, { rows: [], facts: [], links: [], contributors: new Map() });
  for (const row of rows) {
    const entry = out.get(row.cardId)!;
    entry.rows.push(row);
    entry.contributors.set(row.id, contributors.get(row.id) ?? []);
    entry.facts.push({
      id: row.id,
      name: row.name,
      state: row.state,
      required: row.required,
      archived: Boolean(row.archivedAt),
      currentVersionId: row.currentVersionId,
      approvedVersionId: row.approvedVersionId,
      hasFiles: withFiles.has(row.id),
      versionCount: counts.get(row.id) ?? 0,
    });
  }
  for (const link of linkRows) out.get(link.cardId)?.links.push({ fromId: link.fromId, toId: link.toId, type: link.type });
  return out;
}

/** Builds board-tile summaries for many cards with a fixed number of queries. */
export async function summarizeCards(
  cardRows: CardRow[],
  viewerId: string,
  projectKeys: Map<string, string>,
): Promise<CardSummaryDTO[]> {
  if (cardRows.length === 0) return [];
  const ids = cardRows.map((c) => c.id);
  const coverIds = cardRows.map((c) => c.coverAttachmentId).filter((id): id is string => Boolean(id));

  const [assignees, labelRows, commentAgg, attachmentAgg, checklistAgg, versionAgg, covers, views, deliverableFacts] = await Promise.all([
    db.select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId }).from(cardAssignees).where(inArray(cardAssignees.cardId, ids)).orderBy(asc(cardAssignees.createdAt)),
    db.select({ cardId: cardLabels.cardId, labelId: cardLabels.labelId }).from(cardLabels).where(inArray(cardLabels.cardId, ids)),
    db
      .select({
        cardId: comments.cardId,
        total: sql<number>`count(*) filter (where ${comments.deletedAt} is null)`.mapWith(Number),
        unresolved: sql<number>`count(*) filter (where ${comments.kind} = 'FEEDBACK' and ${comments.parentId} is null and ${comments.resolvedAt} is null and ${comments.deletedAt} is null)`.mapWith(Number),
        resolved: sql<number>`count(*) filter (where ${comments.kind} = 'FEEDBACK' and ${comments.parentId} is null and ${comments.resolvedAt} is not null and ${comments.deletedAt} is null)`.mapWith(Number),
      })
      .from(comments)
      .where(inArray(comments.cardId, ids))
      .groupBy(comments.cardId),
    db
      .select({
        cardId: attachments.cardId,
        total: sql<number>`count(*) filter (where ${attachments.purpose} in ('VERSION', 'CARD'))`.mapWith(Number),
        hasVideo: sql<boolean>`coalesce(bool_or(${attachments.kind} = 'VIDEO'), false)`,
        hasImage: sql<boolean>`coalesce(bool_or(${attachments.kind} = 'IMAGE'), false)`,
        hasAudio: sql<boolean>`coalesce(bool_or(${attachments.kind} = 'AUDIO'), false)`,
        hasRoblox: sql<boolean>`coalesce(bool_or(${attachments.kind} = 'ROBLOX' and ${attachments.purpose} <> 'RESOURCE'), false)`,
      })
      .from(attachments)
      .where(and(inArray(attachments.cardId, ids), isNull(attachments.archivedAt), inArray(attachments.status, ["READY", "PROCESSING"])))
      .groupBy(attachments.cardId),
    db
      .select({
        cardId: checklistItems.cardId,
        total: sql<number>`count(*)`.mapWith(Number),
        done: sql<number>`count(*) filter (where ${checklistItems.isDone})`.mapWith(Number),
      })
      .from(checklistItems)
      .where(inArray(checklistItems.cardId, ids))
      .groupBy(checklistItems.cardId),
    db
      .select({
        cardId: assetVersions.cardId,
        total: sql<number>`count(*)`.mapWith(Number),
        latest: sql<number>`max(${assetVersions.versionNumber})`.mapWith(Number),
      })
      .from(assetVersions)
      .where(inArray(assetVersions.cardId, ids))
      .groupBy(assetVersions.cardId),
    coverIds.length ? db.select().from(attachments).where(inArray(attachments.id, coverIds)) : Promise.resolve([]),
    db
      .select({ cardId: cardViews.cardId, lastViewedAt: cardViews.lastViewedAt })
      .from(cardViews)
      .where(and(eq(cardViews.userId, viewerId), inArray(cardViews.cardId, ids))),
    loadDeliverableFacts(ids),
  ]);

  const group = <T extends { cardId: string }, V>(rows: T[], pick: (r: T) => V) => {
    const map = new Map<string, V[]>();
    for (const r of rows) {
      const list = map.get(r.cardId) ?? [];
      list.push(pick(r));
      map.set(r.cardId, list);
    }
    return map;
  };
  const assigneeMap = group(assignees, (r) => r.userId);
  const labelMap = group(labelRows, (r) => r.labelId);
  const commentMap = new Map(commentAgg.map((r) => [r.cardId, r]));
  const attachmentMap = new Map(attachmentAgg.map((r) => [r.cardId, r]));
  const checklistMap = new Map(checklistAgg.map((r) => [r.cardId, r]));
  const versionMap = new Map(versionAgg.map((r) => [r.cardId, r]));
  const coverMap = new Map(covers.map((c) => [c.id, c]));
  const viewMap = new Map(views.map((v) => [v.cardId, v.lastViewedAt]));
  const nowMs = Date.now();

  return Promise.all(
    cardRows.map(async (card) => {
      const lastViewed = viewMap.get(card.id);
      const byOther = card.lastActivityById !== viewerId;
      const unread =
        byOther &&
        (lastViewed
          ? card.lastActivityAt.getTime() > lastViewed.getTime()
          : nowMs - card.lastActivityAt.getTime() < UNREAD_WINDOW_MS);
      const c = commentMap.get(card.id);
      const a = attachmentMap.get(card.id);
      const k = checklistMap.get(card.id);
      const v = versionMap.get(card.id);
      const facts = deliverableFacts.get(card.id)!;
      const recorded = card.productionStatus !== "TODO";
      const readiness = recorded
        ? computeReadiness({ deliverables: facts.facts, links: facts.links, snapshot: card.productionSnapshot, recorded, versionNumbers: new Map() })
        : null;
      return {
        id: card.id,
        key: `${projectKeys.get(card.projectId) ?? "CARD"}-${card.number}`,
        number: card.number,
        title: card.title,
        columnId: card.columnId,
        position: card.position,
        state: card.state,
        productionStatus: card.productionStatus,
        productionPosition: card.productionPosition,
        progress: computeProgress(facts.facts, facts.links),
        pendingChanges: Boolean(readiness?.pendingChanges.length),
        hasAudio: Boolean(a?.hasAudio),
        hasRoblox: Boolean(a?.hasRoblox),
        priority: card.priority,
        displayMode: card.displayMode,
        dueAt: card.dueAt?.toISOString() ?? null,
        milestoneId: card.milestoneId,
        assigneeIds: assigneeMap.get(card.id) ?? [],
        deliverableAssigneeIds: [
          ...new Set(facts.rows.filter((d) => !d.archivedAt).flatMap((d) => [d.ownerId, ...(facts.contributors.get(d.id) ?? [])]).filter((id): id is string => Boolean(id))),
        ],
        labelIds: labelMap.get(card.id) ?? [],
        cover: await mediaRef(card.coverAttachmentId ? coverMap.get(card.coverAttachmentId) : undefined),
        coverMode: card.coverMode,
        counts: {
          comments: c?.total ?? 0,
          attachments: a?.total ?? 0,
          unresolvedFeedback: c?.unresolved ?? 0,
          resolvedFeedback: c?.resolved ?? 0,
          checklistDone: k?.done ?? 0,
          checklistTotal: k?.total ?? 0,
          versions: v?.total ?? 0,
        },
        hasVideo: Boolean(a?.hasVideo),
        hasImage: Boolean(a?.hasImage),
        unread,
        createdById: card.createdById,
        currentVersionNumber: v?.latest ?? null,
        updatedAt: card.updatedAt.toISOString(),
        lastActivityAt: card.lastActivityAt.toISOString(),
      } satisfies CardSummaryDTO;
    }),
  );
}

/** Everything the card workspace needs, in one payload. */
export async function loadCardDetail(cardAccess: CardAccess): Promise<CardDetailDTO> {
  const { card, access, assigneeIds, perms } = cardAccess;
  const projectKeys = new Map([[card.projectId, access.project.key]]);

  const [summary] = await summarizeCards([card], access.userId, projectKeys);
  const [versionRows, attachmentRows, commentRows, reviewRows, checklistRows, itemRows, reviewerRows, watcherRows, deliverableFacts, linkRows, eventRows] =
    await Promise.all([
      db.select().from(assetVersions).where(eq(assetVersions.cardId, card.id)).orderBy(asc(assetVersions.versionNumber), asc(assetVersions.createdAt)),
      db
        .select()
        .from(attachments)
        .where(and(eq(attachments.cardId, card.id), isNull(attachments.archivedAt)))
        .orderBy(asc(attachments.createdAt)),
      db.select().from(comments).where(eq(comments.cardId, card.id)).orderBy(asc(comments.createdAt)),
      db.select().from(reviews).where(eq(reviews.cardId, card.id)).orderBy(asc(reviews.createdAt)),
      db.select().from(checklists).where(eq(checklists.cardId, card.id)).orderBy(asc(checklists.position)),
      db.select().from(checklistItems).where(eq(checklistItems.cardId, card.id)).orderBy(asc(checklistItems.position)),
      db.select({ userId: cardReviewers.userId }).from(cardReviewers).where(eq(cardReviewers.cardId, card.id)),
      db.select({ userId: cardWatchers.userId }).from(cardWatchers).where(eq(cardWatchers.cardId, card.id)),
      loadDeliverableFacts([card.id]),
      db.select().from(deliverableLinks).where(eq(deliverableLinks.cardId, card.id)).orderBy(asc(deliverableLinks.createdAt)),
      db.select().from(productionEvents).where(eq(productionEvents.cardId, card.id)).orderBy(asc(productionEvents.createdAt)),
    ]);

  const commentIds = commentRows.map((c) => c.id);
  const [annotationRows, reactionRows, mentionRows] = commentIds.length
    ? await Promise.all([
        db.select().from(mediaAnnotations).where(inArray(mediaAnnotations.commentId, commentIds)),
        db
          .select()
          .from(commentReactions)
          .where(inArray(commentReactions.commentId, commentIds))
          .orderBy(asc(commentReactions.createdAt)),
        db.select().from(commentMentions).where(inArray(commentMentions.commentId, commentIds)),
      ])
    : [[], [], []];

  // Comment uploads only appear once their comment is posted.
  const visibleAttachmentRows = attachmentRows.filter((a) => a.status !== "PENDING" && !(a.purpose === "COMMENT" && !a.commentId));
  const attachmentDTOs = await Promise.all(visibleAttachmentRows.map(attachmentToDTO));
  const annotationByComment = new Map(annotationRows.map((a) => [a.commentId, a]));

  const reactionsByComment = new Map<string, Map<string, string[]>>();
  for (const r of reactionRows) {
    const byEmoji = reactionsByComment.get(r.commentId) ?? new Map<string, string[]>();
    byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.userId]);
    reactionsByComment.set(r.commentId, byEmoji);
  }
  const mentionsByComment = new Map<string, string[]>();
  for (const m of mentionRows) mentionsByComment.set(m.commentId, [...(mentionsByComment.get(m.commentId) ?? []), m.userId]);

  const toComment = (row: (typeof commentRows)[number]): CommentDTO => {
    const annotation = annotationByComment.get(row.id);
    const deleted = Boolean(row.deletedAt);
    return {
      id: row.id,
      parentId: row.parentId,
      authorId: row.authorId,
      kind: row.kind,
      body: deleted ? "" : row.body,
      deliverableId: row.deliverableId,
      versionId: row.versionId,
      attachmentId: row.attachmentId,
      reviewId: row.reviewId,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedById: row.resolvedById,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      annotation: annotation
        ? {
            id: annotation.id,
            type: annotation.type,
            attachmentId: annotation.attachmentId,
            versionId: annotation.versionId,
            x: annotation.x,
            y: annotation.y,
            width: annotation.width,
            height: annotation.height,
            timestampMs: annotation.timestampMs,
          }
        : null,
      reactions: deleted
        ? []
        : [...(reactionsByComment.get(row.id) ?? new Map()).entries()].map(([emoji, userIds]) => ({ emoji, userIds })),
      attachments: deleted ? [] : attachmentDTOs.filter((a) => a.commentId === row.id),
      mentions: mentionsByComment.get(row.id) ?? [],
      replies: [],
    };
  };

  const byId = new Map<string, CommentDTO>();
  const roots: CommentDTO[] = [];
  for (const row of commentRows) byId.set(row.id, toComment(row));
  for (const row of commentRows) {
    const dto = byId.get(row.id)!;
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) parent.replies.push(dto);
    else roots.push(dto);
  }
  // Hide deleted roots that have no surviving replies.
  const visibleRoots = roots.filter((c) => !c.deletedAt || c.replies.some((r) => !r.deletedAt));

  const versions: VersionDTO[] = versionRows.map((v) => {
    const feedback = commentRows.filter((c) => c.versionId === v.id && c.kind === "FEEDBACK" && !c.parentId && !c.deletedAt);
    return {
      id: v.id,
      deliverableId: v.deliverableId,
      number: v.versionNumber,
      notes: v.notes,
      status: v.status,
      createdById: v.createdById,
      createdAt: v.createdAt.toISOString(),
      submittedAt: v.submittedAt?.toISOString() ?? null,
      submittedById: v.submittedById,
      decidedAt: v.decidedAt?.toISOString() ?? null,
      decidedById: v.decidedById,
      attachmentIds: attachmentDTOs.filter((a) => a.versionId === v.id && !a.commentId).map((a) => a.id),
      feedbackCount: feedback.length,
      unresolvedCount: feedback.filter((c) => !c.resolvedAt).length,
    };
  });

  const reviewDTOs: ReviewDTO[] = reviewRows.map((r) => ({
    id: r.id,
    deliverableId: r.deliverableId,
    versionId: r.versionId,
    actorId: r.actorId,
    action: r.action,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    feedbackIds: commentRows.filter((c) => c.reviewId === r.id && !c.deletedAt).map((c) => c.id),
  }));

  const checklistDTOs: ChecklistDTO[] = checklistRows.map((cl) => ({
    id: cl.id,
    title: cl.title,
    position: cl.position,
    items: itemRows
      .filter((i) => i.checklistId === cl.id)
      .map((i) => ({
        id: i.id,
        text: i.text,
        isDone: i.isDone,
        position: i.position,
        doneById: i.doneById,
        doneAt: i.doneAt?.toISOString() ?? null,
      })),
  }));

  const facts = deliverableFacts.get(card.id)!;
  const factById = new Map(facts.facts.map((f) => [f.id, f]));
  const versionNumbers = new Map(versionRows.map((v) => [v.id, v.versionNumber]));
  const blocked = blockedBy(facts.facts, facts.links);
  const attachmentById = new Map(visibleAttachmentRows.map((a) => [a.id, a]));
  const deliverableDTOs: DeliverableDTO[] = await Promise.all(
    facts.rows.map(async (d) => {
      const f = factById.get(d.id)!;
      const currentFiles = d.currentVersionId ? visibleAttachmentRows.filter((a) => a.versionId === d.currentVersionId && !a.archivedAt) : [];
      return {
        id: d.id,
        number: d.number,
        name: d.name,
        description: d.description,
        assetType: d.assetType,
        required: d.required,
        state: d.state,
        ownerId: d.ownerId,
        contributorIds: facts.contributors.get(d.id) ?? [],
        reviewerId: d.reviewerId,
        dueAt: d.dueAt?.toISOString() ?? null,
        currentVersionId: d.currentVersionId,
        approvedVersionId: d.approvedVersionId,
        canvasX: d.canvasX,
        canvasY: d.canvasY,
        canvasW: d.canvasW,
        canvasH: d.canvasH,
        position: d.position,
        createdById: d.createdById,
        createdAt: d.createdAt.toISOString(),
        archivedAt: d.archivedAt?.toISOString() ?? null,
        cover: await mediaRef(d.coverAttachmentId ? attachmentById.get(d.coverAttachmentId) : undefined),
        versionCount: f.versionCount,
        hasFiles: f.hasFiles,
        kinds: [...new Set(currentFiles.map((a) => a.kind))].filter((k) => PREVIEWABLE.has(k) || k === "FILE"),
        openFeedback: commentRows.filter((c) => c.deliverableId === d.id && c.kind === "FEEDBACK" && !c.parentId && !c.resolvedAt && !c.deletedAt).length,
        blockedBy: blocked.get(d.id) ?? [],
        permissions: computeDeliverablePermissions(cardAccess, d, facts.contributors.get(d.id) ?? []),
      };
    }),
  );

  const recorded = card.productionStatus !== "TODO";
  return {
    ...summary!,
    assigneeIds,
    projectId: card.projectId,
    boardId: card.boardId,
    description: card.description,
    revision: card.revision,
    estimateHours: card.estimateHours,
    links: card.links,
    reviewerIds: reviewerRows.map((r) => r.userId),
    watcherIds: watcherRows.map((r) => r.userId),
    createdAt: card.createdAt.toISOString(),
    archivedAt: card.archivedAt?.toISOString() ?? null,
    deliverables: deliverableDTOs,
    deliverableLinks: linkRows.map((l) => ({
      id: l.id,
      fromId: l.fromId,
      fromPoint: l.fromPoint,
      toPoint: l.toPoint,
      toId: l.toId,
      type: l.type,
      note: l.note,
      createdById: l.createdById,
      createdAt: l.createdAt.toISOString(),
    })),
    productionEvents: eventRows.map((e) => ({
      id: e.id,
      actorId: e.actorId,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      snapshot: e.snapshot,
      createdAt: e.createdAt.toISOString(),
    })),
    productionSnapshot: card.productionSnapshot,
    readiness: computeReadiness({ deliverables: facts.facts, links: facts.links, snapshot: card.productionSnapshot, recorded, versionNumbers }),
    completedAt: card.completedAt?.toISOString() ?? null,
    publishedAt: card.publishedAt?.toISOString() ?? null,
    versions,
    coverPinnedId: card.coverPinnedId,
    attachments: attachmentDTOs,
    comments: visibleRoots,
    reviews: reviewDTOs,
    checklists: checklistDTOs,
    permissions: perms,
  };
}
