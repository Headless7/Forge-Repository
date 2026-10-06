import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { roleHas } from "@/lib/permissions";
import type { ActivityDTO, CardState, CardSummaryDTO, ProjectListItemDTO } from "@/lib/types";
import { getProjectAccess, requireStudio, type ProjectAccess } from "../access";
import { db } from "../db";
import { boardColumns, boards, cardAssignees, cardReviewers, cardViews, cards, deliverableContributors, deliverables } from "../db/schema";
import { listProjectActivity } from "./activity";
import { summarizeCards } from "./card-dto";
import type { Actor } from "./context";
import { listProjects } from "./projects";
import { loadCardWork } from "./workflow";

export type ProjectRef = { id: string; slug: string; name: string; icon: string; key: string };
/** The card's board, so links open there; `shown` when the project has several boards (then its name is displayed). */
export type BoardRef = { number: number; name: string; shown: boolean };

export interface AttentionItem {
  reason: "CHANGES_REQUESTED" | "NEEDS_YOUR_REVIEW" | "OVERDUE" | "DUE_SOON";
  card: CardSummaryDTO;
  project: ProjectRef;
  board: BoardRef | null;
}

/** A deliverable the viewer works on (responsible, contributor, or a card assignee when it inherits). */
export interface MyDeliverableItem {
  deliverable: { id: string; number: number; name: string; state: CardState; required: boolean };
  card: { id: string; key: string; title: string };
  project: ProjectRef;
  board: BoardRef | null;
  role: "responsible" | "contributor" | "card";
  /** Its own deadline, or the card's when it has none (`dueInherited`). */
  dueAt: string | null;
  dueInherited: boolean;
  /** Names of unapproved prerequisites it waits on. */
  waitingOn: string[];
  reviewerId: string | null;
}

export interface StudioHomeDTO {
  projects: ProjectListItemDTO[];
  attention: AttentionItem[];
  /** Unfinished deliverables the viewer works on, soonest deadline first. */
  deliverables: MyDeliverableItem[];
  recent: Array<{ card: CardSummaryDTO; project: ProjectRef; board: BoardRef | null; viewedAt: string }>;
  activity: ActivityDTO[];
}

/** The viewer's unfinished deliverables in these projects, with their effective deadline and blockers (also /mywork in Discord). */
export async function myDeliverables(userId: string, projectIds: string[], projectRef: (id: string) => ProjectRef, boardRef: (boardId: string) => BoardRef | null): Promise<MyDeliverableItem[]> {
  const mineExplicit = sql`(${deliverables.ownerId} = ${userId} or exists (select 1 from ${deliverableContributors} dc where dc.deliverable_id = ${deliverables.id} and dc.user_id = ${userId}))`;
  const inheritsFromMe = sql`(${deliverables.ownerId} is null and not exists (select 1 from ${deliverableContributors} dc where dc.deliverable_id = ${deliverables.id}) and exists (select 1 from ${cardAssignees} ca where ca.card_id = ${deliverables.cardId} and ca.user_id = ${userId}))`;
  const rows = await db
    .select({ d: deliverables, card: cards, isContributor: sql<boolean>`exists (select 1 from ${deliverableContributors} dc where dc.deliverable_id = ${deliverables.id} and dc.user_id = ${userId})` })
    .from(deliverables)
    .innerJoin(cards, eq(cards.id, deliverables.cardId))
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(
      and(
        inArray(deliverables.projectId, projectIds),
        isNull(deliverables.archivedAt),
        isNull(cards.archivedAt),
        isNull(boardColumns.archivedAt),
        isNull(boards.archivedAt),
        ne(deliverables.state, "APPROVED"),
        sql`(${mineExplicit} or ${inheritsFromMe})`,
      ),
    )
    .orderBy(sql`coalesce(${deliverables.dueAt}, ${cards.dueAt}) asc nulls last`, desc(cards.lastActivityAt))
    .limit(50);
  const works = new Map<string, Awaited<ReturnType<typeof loadCardWork>>>();
  const items: MyDeliverableItem[] = [];
  for (const { d, card, isContributor } of rows) {
    const work = works.get(card.id) ?? works.set(card.id, await loadCardWork(db, card.id)).get(card.id)!;
    const names = new Map(work.deliverables.map((x) => [x.id, x.name]));
    const project = projectRef(card.projectId);
    items.push({
      deliverable: { id: d.id, number: d.number, name: d.name, state: d.state, required: d.required },
      card: { id: card.id, key: `${project.key}-${card.number}`, title: card.title },
      project,
      board: boardRef(card.boardId),
      role: d.ownerId === userId ? "responsible" : isContributor ? "contributor" : "card",
      dueAt: (d.dueAt ?? card.dueAt)?.toISOString() ?? null,
      dueInherited: !d.dueAt && Boolean(card.dueAt),
      waitingOn: (work.blocked.get(d.id) ?? []).map((id) => names.get(id) ?? "?"),
      reviewerId: d.reviewerId,
    });
  }
  return items;
}

export async function getStudioHome(actor: Actor, studioId: string): Promise<StudioHomeDTO> {
  await requireStudio(actor.userId, studioId);
  const projectList = await listProjects(actor, studioId);
  const accessMap = new Map<string, ProjectAccess>();
  for (const p of projectList) {
    const access = await getProjectAccess(actor.userId, p.id);
    if (access) accessMap.set(p.id, access);
  }
  const projectIds = [...accessMap.keys()];
  if (projectIds.length === 0) return { projects: projectList, attention: [], deliverables: [], recent: [], activity: [] };

  const reviewProjectIds = projectIds.filter((id) => roleHas(accessMap.get(id)!.role, "card.review"));
  const soon = new Date(Date.now() + 48 * 60 * 60 * 1000);
  // Work on archived columns or boards is archived work: nobody needs to act on it.
  const active = and(inArray(cards.projectId, projectIds), isNull(cards.archivedAt), isNull(boardColumns.archivedAt), isNull(boards.archivedAt));

  const [mine, reviewQueue, recentRows, activity, boardRows] = await Promise.all([
    db
      .select({ card: cards })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(cardAssignees, and(eq(cardAssignees.cardId, cards.id), eq(cardAssignees.userId, actor.userId)))
      .where(and(active, or(eq(cards.state, "CHANGES_REQUESTED"), and(ne(cards.state, "APPROVED"), lte(cards.dueAt, soon)))))
      .orderBy(desc(cards.lastActivityAt))
      .limit(30),
    reviewProjectIds.length
      ? db
          .select({ card: cards, isReviewer: sql<boolean>`${cardReviewers.userId} is not null`, reviewerCount: sql<number>`(select count(*) from ${cardReviewers} r where r.card_id = ${cards.id})`.mapWith(Number) })
          .from(cards)
          .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
          .innerJoin(boards, eq(boards.id, cards.boardId))
          .leftJoin(cardReviewers, and(eq(cardReviewers.cardId, cards.id), eq(cardReviewers.userId, actor.userId)))
          .where(and(active, inArray(cards.projectId, reviewProjectIds), eq(cards.state, "NEEDS_REVIEW")))
          .orderBy(cards.lastActivityAt)
          .limit(30)
      : Promise.resolve([]),
    db
      .select({ card: cards, viewedAt: cardViews.lastViewedAt })
      .from(cardViews)
      .innerJoin(cards, eq(cards.id, cardViews.cardId))
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(and(eq(cardViews.userId, actor.userId), active))
      .orderBy(desc(cardViews.lastViewedAt))
      .limit(8),
    listProjectActivity(projectIds, { limit: 15 }),
    db
      .select({ id: boards.id, projectId: boards.projectId, number: boards.number, name: boards.name })
      .from(boards)
      .where(and(inArray(boards.projectId, projectIds), isNull(boards.archivedAt))),
  ]);
  const boardsPerProject = new Map<string, number>();
  for (const b of boardRows) boardsPerProject.set(b.projectId, (boardsPerProject.get(b.projectId) ?? 0) + 1);
  const boardById = new Map(boardRows.map((b) => [b.id, b]));
  const boardRef = (boardId: string): BoardRef | null => {
    const b = boardById.get(boardId);
    return b ? { number: b.number, name: b.name, shown: (boardsPerProject.get(b.projectId) ?? 0) > 1 } : null;
  };

  // Review requests addressed to someone else aren't "yours" unless no reviewer was named.
  const reviewCards = reviewQueue.filter((r) => r.isReviewer || r.reviewerCount === 0).map((r) => r.card);
  const allCards = [...mine.map((m) => m.card), ...reviewCards, ...recentRows.map((r) => r.card)];
  const keys = new Map(projectList.map((p) => [p.id, p.key]));
  const summaries = await summarizeCards(allCards, actor.userId, keys);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const projectRef = (id: string): ProjectRef => {
    const p = projectList.find((x) => x.id === id)!;
    return { id: p.id, slug: p.slug, name: p.name, icon: p.icon, key: p.key };
  };

  const attention: AttentionItem[] = [];
  const seen = new Set<string>();
  const push = (reason: AttentionItem["reason"], card: typeof cards.$inferSelect) => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    attention.push({ reason, card: byId.get(card.id)!, project: projectRef(card.projectId), board: boardRef(card.boardId) });
  };
  for (const { card } of mine) if (card.state === "CHANGES_REQUESTED") push("CHANGES_REQUESTED", card);
  for (const card of reviewCards) push("NEEDS_YOUR_REVIEW", card);
  for (const { card } of mine) {
    if (card.dueAt) push(card.dueAt.getTime() < Date.now() ? "OVERDUE" : "DUE_SOON", card);
  }

  return {
    projects: projectList,
    attention,
    deliverables: await myDeliverables(actor.userId, projectIds, projectRef, boardRef),
    recent: recentRows.map((r) => ({ card: byId.get(r.card.id)!, project: projectRef(r.card.projectId), board: boardRef(r.card.boardId), viewedAt: r.viewedAt.toISOString() })),
    activity,
  };
}
