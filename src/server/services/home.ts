import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { roleHas } from "@/lib/permissions";
import type { ActivityDTO, CardSummaryDTO, ProjectListItemDTO } from "@/lib/types";
import { getProjectAccess, requireStudio, type ProjectAccess } from "../access";
import { db } from "../db";
import { boardColumns, cardAssignees, cardReviewers, cardViews, cards } from "../db/schema";
import { listProjectActivity } from "./activity";
import { summarizeCards } from "./card-dto";
import type { Actor } from "./context";
import { listProjects } from "./projects";

type ProjectRef = { id: string; slug: string; name: string; icon: string; key: string };

export interface AttentionItem {
  reason: "CHANGES_REQUESTED" | "NEEDS_YOUR_REVIEW" | "OVERDUE" | "DUE_SOON";
  card: CardSummaryDTO;
  project: ProjectRef;
}

export interface StudioHomeDTO {
  projects: ProjectListItemDTO[];
  attention: AttentionItem[];
  recent: Array<{ card: CardSummaryDTO; project: ProjectRef; viewedAt: string }>;
  activity: ActivityDTO[];
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
  if (projectIds.length === 0) return { projects: projectList, attention: [], recent: [], activity: [] };

  const reviewProjectIds = projectIds.filter((id) => roleHas(accessMap.get(id)!.role, "card.review"));
  const soon = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const active = and(inArray(cards.projectId, projectIds), isNull(cards.archivedAt), isNull(boardColumns.archivedAt));

  const [mine, reviewQueue, recentRows, activity] = await Promise.all([
    db
      .select({ card: cards })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .innerJoin(cardAssignees, and(eq(cardAssignees.cardId, cards.id), eq(cardAssignees.userId, actor.userId)))
      .where(and(active, or(eq(cards.state, "CHANGES_REQUESTED"), and(ne(cards.state, "APPROVED"), lte(cards.dueAt, soon)))))
      .orderBy(desc(cards.lastActivityAt))
      .limit(30),
    reviewProjectIds.length
      ? db
          .select({ card: cards, isReviewer: sql<boolean>`${cardReviewers.userId} is not null`, reviewerCount: sql<number>`(select count(*) from ${cardReviewers} r where r.card_id = ${cards.id})`.mapWith(Number) })
          .from(cards)
          .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
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
      .where(and(eq(cardViews.userId, actor.userId), active))
      .orderBy(desc(cardViews.lastViewedAt))
      .limit(8),
    listProjectActivity(projectIds, { limit: 15 }),
  ]);

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
    attention.push({ reason, card: byId.get(card.id)!, project: projectRef(card.projectId) });
  };
  for (const { card } of mine) if (card.state === "CHANGES_REQUESTED") push("CHANGES_REQUESTED", card);
  for (const card of reviewCards) push("NEEDS_YOUR_REVIEW", card);
  for (const { card } of mine) {
    if (card.dueAt) push(card.dueAt.getTime() < Date.now() ? "OVERDUE" : "DUE_SOON", card);
  }

  return {
    projects: projectList,
    attention,
    recent: recentRows.map((r) => ({ card: byId.get(r.card.id)!, project: projectRef(r.card.projectId), viewedAt: r.viewedAt.toISOString() })),
    activity,
  };
}
