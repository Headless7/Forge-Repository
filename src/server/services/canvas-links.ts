import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { boundsOf, folderFrames, freeSpot, LAYOUT_GAP, type Rect } from "@/lib/canvas-folders";
import { LINK_NODE } from "@/lib/canvas-links";
import { NODE_DEFAULT } from "@/lib/canvas-points";
import { computeProgress, type SharedFacts } from "@/lib/deliverables";
import type { BacklinkDTO, CanvasLinkDTO, CardDetailDTO, LinkCandidatesDTO, LinkedCardDTO } from "@/lib/types";
import { assertCard, requireCard, type CardAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { assetVersions, attachments, boardColumns, boards, canvasLinks, cards, comments, deliverableGroups, deliverables, projects } from "../db/schema";
import { conflict, invalid, notFound } from "../errors";
import { logActivity } from "./activity";
import { loadCardDetail, loadDeliverableFacts, mediaRef } from "./card-dto";
import { touchCard } from "./cards";
import type { Actor } from "./context";
import { removeEmptyGroups } from "./deliverable-groups";
import { Effects } from "./effects";

/**
 * Links between cards (see lib/canvas-links). A link sits on one card's canvas and points at
 * another card of the same project, or shares one of its deliverables. Adding, moving and removing
 * links is arranging the canvas: it takes the card's edit permission and never touches either
 * card's work. The other card shows the link as "linked from" — it can't be hidden or removed from
 * there. A shared deliverable counts only on its own card; `needed` makes this card wait for it
 * (it can't be completed until the shared work is approved), and completing records its revision.
 */

const EDIT_MESSAGE = "You don't have permission to change this card's links.";

type LinkRow = typeof canvasLinks.$inferSelect;

const keyOf = (ctx: CardAccess, number: number) => `${ctx.access.project.key}-${number}`;

async function requireLink(actor: Actor, linkId: string): Promise<{ ctx: CardAccess; link: LinkRow }> {
  const [link] = await db.select().from(canvasLinks).where(eq(canvasLinks.id, linkId));
  if (!link) throw notFound("Link");
  const ctx = await requireCard(actor.userId, link.cardId).catch(() => {
    throw notFound("Link");
  });
  return { ctx, link };
}

async function finish(actor: Actor, ctx: CardAccess, fx: Effects): Promise<CardDetailDTO> {
  fx.flush(actor.clientId);
  return loadCardDetail(await requireCard(actor.userId, ctx.card.id));
}

// ── Placement ───────────────────────────────────────────────────────────────

/**
 * Where something new goes on a card's canvas: the nearest spot to `wanted` — or, without one,
 * beside everything already there (beside a folder's contents when it goes in one) — where a node
 * of `size` covers nothing: deliverables, links and folder frames. Sizes not yet measured count as
 * the defaults. Used for new deliverables and links.
 */
export async function placeOnCanvas(tx: Executor, cardId: string, size: { w: number; h: number }, groupId: string | null, wanted: { x: number; y: number } | null): Promise<{ x: number; y: number }> {
  const [ds, ls, gs] = await Promise.all([
    tx
      .select({ id: deliverables.id, groupId: deliverables.groupId, x: deliverables.canvasX, y: deliverables.canvasY, w: deliverables.canvasW, h: deliverables.canvasH })
      .from(deliverables)
      .where(and(eq(deliverables.cardId, cardId), isNull(deliverables.archivedAt))),
    tx.select({ id: canvasLinks.id, groupId: canvasLinks.groupId, x: canvasLinks.canvasX, y: canvasLinks.canvasY }).from(canvasLinks).where(eq(canvasLinks.cardId, cardId)),
    tx.select({ id: deliverableGroups.id, parentId: deliverableGroups.parentId }).from(deliverableGroups).where(eq(deliverableGroups.cardId, cardId)),
  ]);
  const items = [
    ...ds.map((d) => ({ id: d.id, groupId: d.groupId, rect: { x: d.x, y: d.y, w: d.w ?? NODE_DEFAULT.w, h: d.h ?? NODE_DEFAULT.h } })),
    ...ls.map((l) => ({ id: l.id, groupId: l.groupId, rect: { x: l.x, y: l.y, ...LINK_NODE } })),
  ];
  const frames = folderFrames(
    gs.map((g) => ({ ...g, collapsed: false })),
    items,
  );
  const obstacles: Rect[] = [...items.map((i) => i.rect), ...frames.values()];
  const siblings = groupId ? items.filter((i) => i.groupId === groupId).map((i) => i.rect) : obstacles;
  const near = boundsOf(siblings);
  const start = wanted ?? (near ? { x: near.x + near.w + LAYOUT_GAP, y: near.y } : { x: 0, y: 0 });
  const spot = freeSpot({ ...start, ...size }, groupId ? obstacles.filter((o) => o !== frames.get(groupId)) : obstacles);
  return { x: Math.round(spot.x), y: Math.round(spot.y) };
}

// ── Changes ─────────────────────────────────────────────────────────────────

/**
 * Links another card of this project (or shares one of its deliverables) here. The target must be
 * active; anything outside the project is "not found". A card is linked once, and each deliverable
 * shared once. Without a position, it's placed beside what's on the canvas.
 */
export async function createLink(
  actor: Actor,
  input: { cardId: string; targetCardId: string; targetDeliverableId?: string | null; needed?: boolean; groupId?: string | null; x?: number; y?: number },
): Promise<CardDetailDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  if (input.targetCardId === ctx.card.id) throw invalid("A card can't link to itself.");
  const [target] = await db
    .select({ card: cards, boardArchivedAt: boards.archivedAt })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(eq(cards.id, input.targetCardId), eq(cards.projectId, ctx.card.projectId)));
  if (!target) throw notFound("Card");
  const key = keyOf(ctx, target.card.number);
  if (target.card.archivedAt) throw conflict(`${key} is archived. Restore it before linking it.`);
  if (target.boardArchivedAt) throw conflict(`${key} is on an archived board. Restore the board before linking it.`);
  let shared: typeof deliverables.$inferSelect | null = null;
  if (input.targetDeliverableId) {
    [shared] = await db
      .select()
      .from(deliverables)
      .where(and(eq(deliverables.id, input.targetDeliverableId), eq(deliverables.cardId, target.card.id)));
    if (!shared) throw notFound("Deliverable");
    if (shared.archivedAt) throw conflict(`${shared.name} is archived on ${key}. Restore it before sharing it.`);
  } else if (input.needed) {
    throw invalid("Only a shared deliverable can be needed to complete a card.");
  }
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: canvasLinks.id })
      .from(canvasLinks)
      .where(
        and(
          eq(canvasLinks.cardId, ctx.card.id),
          eq(canvasLinks.targetCardId, target.card.id),
          shared ? eq(canvasLinks.targetDeliverableId, shared.id) : isNull(canvasLinks.targetDeliverableId),
        ),
      );
    if (existing) throw conflict(shared ? `${shared.name} from ${key} is already shared here.` : `${key} is already linked here.`);
    const groupId = input.groupId ?? null;
    if (groupId) {
      const [group] = await tx.select({ id: deliverableGroups.id }).from(deliverableGroups).where(and(eq(deliverableGroups.id, groupId), eq(deliverableGroups.cardId, ctx.card.id)));
      if (!group) throw notFound("Folder");
    }
    // Where it was asked for (beside what it came from, or where it was before an undo), else beside
    // everything — either way never on top of something.
    const wanted = input.x !== undefined && input.y !== undefined && Number.isFinite(input.x) && Number.isFinite(input.y) ? { x: input.x, y: input.y } : null;
    const at = await placeOnCanvas(tx, ctx.card.id, LINK_NODE, groupId, wanted);
    await tx.insert(canvasLinks).values({
      cardId: ctx.card.id,
      projectId: ctx.card.projectId,
      targetCardId: target.card.id,
      targetDeliverableId: shared?.id ?? null,
      needed: Boolean(shared && input.needed),
      groupId,
      canvasX: at.x,
      canvasY: at.y,
      createdById: actor.userId,
      createdAt: now(),
    });
    const base = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, actorId: actor.userId };
    const sourceKey = keyOf(ctx, ctx.card.number);
    await logActivity(tx, { ...base, cardId: ctx.card.id, type: "card.linked", data: { cardKey: key, cardTitle: target.card.title, deliverable: shared?.name, needed: Boolean(shared && input.needed) } });
    await logActivity(tx, { ...base, cardId: target.card.id, type: "card.linked_from", data: { cardKey: sourceKey, cardTitle: ctx.card.title, deliverable: shared?.name } });
    await touchCard(tx, ctx.card.id, actor.userId);
    fx.card(ctx.card.projectId, ctx.card.id, false).card(ctx.card.projectId, target.card.id, false);
  });
  return finish(actor, ctx, fx);
}

/** Whether this card needs a shared deliverable approved before it can be completed. */
export async function setLinkNeeded(actor: Actor, input: { linkId: string; needed: boolean }): Promise<CardDetailDTO> {
  const { ctx, link } = await requireLink(actor, input.linkId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  if (!link.targetDeliverableId) throw invalid("Only a shared deliverable can be needed to complete a card.");
  const fx = new Effects();
  if (link.needed !== input.needed) {
    await db.transaction(async (tx) => {
      await tx.update(canvasLinks).set({ needed: input.needed }).where(eq(canvasLinks.id, link.id));
      const [d] = await tx
        .select({ name: deliverables.name, number: cards.number })
        .from(deliverables)
        .innerJoin(cards, eq(cards.id, deliverables.cardId))
        .where(eq(deliverables.id, link.targetDeliverableId!));
      await logActivity(tx, {
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        actorId: actor.userId,
        type: "card.link_needed",
        data: { needed: input.needed, deliverable: d?.name, cardKey: d ? keyOf(ctx, d.number) : undefined },
      });
      await touchCard(tx, ctx.card.id, actor.userId);
      fx.card(ctx.card.projectId, ctx.card.id).card(ctx.card.projectId, link.targetCardId, false);
    });
  }
  return finish(actor, ctx, fx);
}

/** Removes a link: neither card's work changes. A folder left empty goes with it. */
export async function removeLink(actor: Actor, input: { linkId: string }): Promise<CardDetailDTO> {
  const { ctx, link } = await requireLink(actor, input.linkId);
  assertCard(ctx.perms, "canEdit", EDIT_MESSAGE);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const [target] = await tx.select({ number: cards.number, title: cards.title }).from(cards).where(eq(cards.id, link.targetCardId));
    const [d] = link.targetDeliverableId ? await tx.select({ name: deliverables.name }).from(deliverables).where(eq(deliverables.id, link.targetDeliverableId)) : [];
    await tx.delete(canvasLinks).where(eq(canvasLinks.id, link.id));
    await removeEmptyGroups(tx, ctx.card.id);
    const base = { studioId: ctx.access.studioId, projectId: ctx.card.projectId, actorId: actor.userId };
    await logActivity(tx, { ...base, cardId: ctx.card.id, type: "card.unlinked", data: { cardKey: target ? keyOf(ctx, target.number) : undefined, cardTitle: target?.title, deliverable: d?.name } });
    await logActivity(tx, { ...base, cardId: link.targetCardId, type: "card.unlinked_from", data: { cardKey: keyOf(ctx, ctx.card.number), cardTitle: ctx.card.title, deliverable: d?.name } });
    await touchCard(tx, ctx.card.id, actor.userId);
    fx.card(ctx.card.projectId, ctx.card.id, link.needed).card(ctx.card.projectId, link.targetCardId, false);
  });
  return finish(actor, ctx, fx);
}

/**
 * Before cards or deliverables are deleted for good: links pointing at them from cards that stay
 * say so in those cards' history (the links themselves go with what they point at).
 */
export async function noteLinksToDeleted(tx: Executor, actorId: string, target: { cardIds?: string[]; deliverableIds?: string[] }): Promise<Array<{ projectId: string; cardId: string }>> {
  const cardIds = target.cardIds ?? [];
  const deliverableIds = target.deliverableIds ?? [];
  if (!cardIds.length && !deliverableIds.length) return [];
  const rows = await tx
    .select({ link: canvasLinks, targetNumber: cards.number, targetTitle: cards.title, projectKey: projects.key, studioId: projects.studioId, deliverable: deliverables.name })
    .from(canvasLinks)
    .innerJoin(cards, eq(cards.id, canvasLinks.targetCardId))
    .innerJoin(projects, eq(projects.id, canvasLinks.projectId))
    .leftJoin(deliverables, eq(deliverables.id, canvasLinks.targetDeliverableId))
    .where(
      and(
        or(cardIds.length ? inArray(canvasLinks.targetCardId, cardIds) : undefined, deliverableIds.length ? inArray(canvasLinks.targetDeliverableId, deliverableIds) : undefined),
        cardIds.length ? notInArray(canvasLinks.cardId, cardIds) : undefined,
      ),
    );
  for (const r of rows) {
    await logActivity(tx, {
      studioId: r.studioId,
      projectId: r.link.projectId,
      cardId: r.link.cardId,
      actorId,
      type: "card.link_removed",
      data: { cardKey: `${r.projectKey}-${r.targetNumber}`, cardTitle: r.targetTitle, deliverable: r.deliverable ?? undefined },
    });
  }
  return rows.map((r) => ({ projectId: r.link.projectId, cardId: r.link.cardId }));
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The project's active cards (and their active deliverables) that this card can link to, by board and category. */
export async function linkCandidates(actor: Actor, input: { cardId: string }): Promise<LinkCandidatesDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  const projectId = ctx.card.projectId;
  const [boardRows, columnRows, cardRows] = await Promise.all([
    db.select().from(boards).where(and(eq(boards.projectId, projectId), isNull(boards.archivedAt))).orderBy(asc(boards.position), asc(boards.number)),
    db.select().from(boardColumns).where(and(eq(boardColumns.projectId, projectId), isNull(boardColumns.archivedAt))).orderBy(asc(boardColumns.position)),
    db
      .select({ id: cards.id, number: cards.number, title: cards.title, boardId: cards.boardId, columnId: cards.columnId, state: cards.state })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cards.projectId, projectId), isNull(cards.archivedAt), isNull(boards.archivedAt), ne(cards.id, ctx.card.id)))
      .orderBy(asc(cards.position)),
  ]);
  const ids = cardRows.map((c) => c.id);
  const deliverableRows = ids.length
    ? await db
        .select({ id: deliverables.id, cardId: deliverables.cardId, number: deliverables.number, name: deliverables.name, assetType: deliverables.assetType, state: deliverables.state })
        .from(deliverables)
        .where(and(inArray(deliverables.cardId, ids), isNull(deliverables.archivedAt)))
        .orderBy(asc(deliverables.position), asc(deliverables.number))
    : [];
  const byCard = new Map<string, LinkCandidatesDTO["cards"][number]["deliverables"]>();
  for (const d of deliverableRows) byCard.set(d.cardId, [...(byCard.get(d.cardId) ?? []), { id: d.id, number: d.number, name: d.name, assetType: d.assetType, state: d.state }]);
  return {
    boards: boardRows.map((b) => ({
      id: b.id,
      number: b.number,
      name: b.name,
      columns: columnRows.filter((c) => c.boardId === b.id).map((c) => ({ id: c.id, name: c.name, icon: c.icon, color: c.color })),
    })),
    cards: cardRows.map((c) => ({ ...c, key: keyOf(ctx, c.number), deliverables: byCard.get(c.id) ?? [] })),
  };
}

export interface CardLinksView {
  links: CanvasLinkDTO[];
  linkedFrom: BacklinkDTO[];
  /** Shared deliverables this card needs (for its readiness), with their revision numbers. */
  needed: SharedFacts[];
  versionNumbers: Map<string, number>;
}

/** Everything about a card's links for its detail view, in a fixed number of queries. */
export async function loadCardLinks(ctx: CardAccess): Promise<CardLinksView> {
  const [rows, backRows] = await Promise.all([
    db.select().from(canvasLinks).where(eq(canvasLinks.cardId, ctx.card.id)).orderBy(asc(canvasLinks.createdAt)),
    db
      .select({ link: canvasLinks, card: cards, boardNumber: boards.number, boardName: boards.name })
      .from(canvasLinks)
      .innerJoin(cards, eq(cards.id, canvasLinks.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(eq(canvasLinks.targetCardId, ctx.card.id))
      .orderBy(asc(canvasLinks.createdAt)),
  ]);
  const linkedFrom: BacklinkDTO[] = backRows.map((r) => ({
    id: r.link.id,
    card: { id: r.card.id, key: keyOf(ctx, r.card.number), number: r.card.number, title: r.card.title, board: { id: r.card.boardId, number: r.boardNumber, name: r.boardName }, state: r.card.state, archived: Boolean(r.card.archivedAt) },
    deliverableId: r.link.targetDeliverableId,
    needed: r.link.needed,
  }));
  if (!rows.length) return { links: [], linkedFrom, needed: [], versionNumbers: new Map() };

  const targetIds = [...new Set(rows.map((r) => r.targetCardId))];
  const sharedIds = rows.map((r) => r.targetDeliverableId).filter((id): id is string => Boolean(id));
  const [targets, facts, feedback, versions] = await Promise.all([
    db
      .select({ card: cards, board: boards, column: boardColumns })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .leftJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .where(inArray(cards.id, targetIds)),
    loadDeliverableFacts(targetIds),
    sharedIds.length
      ? db
          .select({ deliverableId: comments.deliverableId, n: sql<number>`count(*)`.mapWith(Number) })
          .from(comments)
          .where(and(inArray(comments.deliverableId, sharedIds), eq(comments.kind, "FEEDBACK"), isNull(comments.parentId), isNull(comments.resolvedAt), isNull(comments.deletedAt)))
          .groupBy(comments.deliverableId)
      : Promise.resolve([]),
    sharedIds.length
      ? db.select({ id: assetVersions.id, number: assetVersions.versionNumber }).from(assetVersions).where(inArray(assetVersions.deliverableId, sharedIds))
      : Promise.resolve([]),
  ]);
  const targetById = new Map(targets.map((t) => [t.card.id, t]));
  const deliverableRows = new Map([...facts.values()].flatMap((f) => f.rows.map((r) => [r.id, r] as const)));
  const coverIds = [...targets.map((t) => t.card.coverAttachmentId), ...sharedIds.map((id) => deliverableRows.get(id)?.coverAttachmentId)].filter((id): id is string => Boolean(id));
  const covers = coverIds.length ? await db.select().from(attachments).where(inArray(attachments.id, coverIds)) : [];
  const coverById = new Map(covers.map((c) => [c.id, c]));
  const openFeedback = new Map(feedback.map((f) => [f.deliverableId, f.n]));
  const versionNumbers = new Map(versions.map((v) => [v.id, v.number]));

  const cardDTOs = new Map<string, LinkedCardDTO>();
  for (const id of targetIds) {
    const t = targetById.get(id);
    const f = facts.get(id);
    if (!t || !f) continue;
    cardDTOs.set(id, {
      id,
      key: keyOf(ctx, t.card.number),
      number: t.card.number,
      title: t.card.title,
      board: { id: t.board.id, number: t.board.number, name: t.board.name, archived: Boolean(t.board.archivedAt) },
      column: t.column ? { id: t.column.id, name: t.column.name, icon: t.column.icon, color: t.column.color } : null,
      state: t.card.state,
      productionStatus: t.card.productionStatus,
      archived: Boolean(t.card.archivedAt),
      cover: await mediaRef(t.card.coverAttachmentId ? coverById.get(t.card.coverAttachmentId) : undefined),
      progress: computeProgress(f.facts, f.links),
      deliverables: f.rows.filter((d) => !d.archivedAt).map((d) => ({ id: d.id, number: d.number, name: d.name, assetType: d.assetType, state: d.state })),
    });
  }

  const links: CanvasLinkDTO[] = [];
  const needed: SharedFacts[] = [];
  for (const r of rows) {
    const card = cardDTOs.get(r.targetCardId);
    if (!card) continue;
    let deliverable: CanvasLinkDTO["deliverable"] = null;
    if (r.targetDeliverableId) {
      const d = deliverableRows.get(r.targetDeliverableId);
      const fact = facts.get(r.targetCardId)?.facts.find((x) => x.id === r.targetDeliverableId);
      if (!d || !fact) continue;
      deliverable = {
        id: d.id,
        number: d.number,
        name: d.name,
        assetType: d.assetType,
        state: d.state,
        required: d.required,
        archived: Boolean(d.archivedAt),
        color: d.color,
        cover: await mediaRef(d.coverAttachmentId ? coverById.get(d.coverAttachmentId) : undefined),
        versionCount: fact.versionCount,
        hasFiles: fact.hasFiles,
        openFeedback: openFeedback.get(d.id) ?? 0,
        approvedVersionNumber: d.approvedVersionId ? (versionNumbers.get(d.approvedVersionId) ?? null) : null,
      };
      // An archived card's work isn't being finished: like archived deliverables, it stops counting.
      if (r.needed) needed.push({ ...fact, archived: fact.archived || card.archived, cardKey: card.key });
    }
    links.push({
      id: r.id,
      card,
      deliverable,
      needed: Boolean(deliverable) && r.needed,
      groupId: r.groupId,
      canvasX: r.canvasX,
      canvasY: r.canvasY,
      createdById: r.createdById,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return { links, linkedFrom, needed, versionNumbers };
}

/**
 * Shared deliverables each card needs (for readiness and "pending changes" on many cards at
 * once), in a fixed number of queries.
 */
export async function loadNeededShares(cardIds: string[], projectKeys: Map<string, string>): Promise<{ byCard: Map<string, SharedFacts[]>; versionNumbers: Map<string, number> }> {
  const byCard = new Map<string, SharedFacts[]>();
  if (!cardIds.length) return { byCard, versionNumbers: new Map() };
  const rows = await db
    .select({ cardId: canvasLinks.cardId, deliverableId: canvasLinks.targetDeliverableId, targetCardId: canvasLinks.targetCardId, projectId: cards.projectId, number: cards.number, targetArchivedAt: cards.archivedAt })
    .from(canvasLinks)
    .innerJoin(cards, eq(cards.id, canvasLinks.targetCardId))
    .where(and(inArray(canvasLinks.cardId, cardIds), eq(canvasLinks.needed, true), isNotNull(canvasLinks.targetDeliverableId)));
  if (!rows.length) return { byCard, versionNumbers: new Map() };
  const deliverableIds = rows.map((r) => r.deliverableId!);
  const [facts, versions] = await Promise.all([
    loadDeliverableFacts([...new Set(rows.map((r) => r.targetCardId))]),
    db.select({ id: assetVersions.id, number: assetVersions.versionNumber }).from(assetVersions).where(inArray(assetVersions.deliverableId, deliverableIds)),
  ]);
  for (const r of rows) {
    const fact = facts.get(r.targetCardId)?.facts.find((f) => f.id === r.deliverableId);
    if (!fact) continue;
    const key = `${projectKeys.get(r.projectId) ?? "CARD"}-${r.number}`;
    byCard.set(r.cardId, [...(byCard.get(r.cardId) ?? []), { ...fact, archived: fact.archived || Boolean(r.targetArchivedAt), cardKey: key }]);
  }
  return { byCard, versionNumbers: new Map(versions.map((v) => [v.id, v.number])) };
}

/** Copies a card's links to its duplicate (same targets, same places; folders mapped to the copy's). */
export async function copyLinks(tx: Executor, sourceId: string, copyId: string, groupMap: Map<string, string>, actorId: string) {
  const rows = await tx.select().from(canvasLinks).where(eq(canvasLinks.cardId, sourceId));
  if (!rows.length) return;
  await tx.insert(canvasLinks).values(
    rows
      .filter((r) => r.targetCardId !== copyId)
      .map((r) => ({
        cardId: copyId,
        projectId: r.projectId,
        targetCardId: r.targetCardId,
        targetDeliverableId: r.targetDeliverableId,
        needed: r.needed,
        groupId: r.groupId ? (groupMap.get(r.groupId) ?? null) : null,
        canvasX: r.canvasX,
        canvasY: r.canvasY,
        createdById: actorId,
        createdAt: now(),
      })),
  );
}
