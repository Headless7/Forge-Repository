/**
 * Scheduled work for the timeline, the calendars and calendar subscriptions: cards and their
 * deliverables whose dates overlap a range. A deliverable without its own start or deadline uses
 * the card's (and says so). Only live work is included — nothing on archived cards, columns,
 * boards or projects — and only in projects the viewer can open.
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { ScheduleCardDTO, ScheduleDTO } from "@/lib/types";
import { accessibleProjectIds, computeCardPermissions, getProjectAccess, requireProject, requireStudio, type ProjectAccess } from "../access";
import { db } from "../db";
import { boardColumns, boards, cardAssignees, cardReviewers, cards, deliverableContributors, deliverableLinks, deliverables, milestones, projects } from "../db/schema";
import { invalid, notFound } from "../errors";
import type { Actor } from "./context";

/** Longest range one request may cover. */
const MAX_RANGE_DAYS = 400;
const MAX_CARDS = 600;

function range(from: string, to: string) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw invalid("Invalid date range.");
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000) throw invalid(`Show at most ${MAX_RANGE_DAYS} days at a time.`);
  return { start, end };
}

interface Scope {
  accesses: Map<string, ProjectAccess>;
  boardId?: string | null;
  /** Only work this person is on (assigned, responsible, contributing or reviewing). */
  mineOnly?: boolean;
  /** Include cards with no dates at all (board/project views). */
  withUnscheduled?: boolean;
}

/** Live (not archived) cards in the scope's projects. */
function liveCards(projectIds: string[], boardId?: string | null) {
  return and(
    inArray(cards.projectId, projectIds),
    boardId ? eq(cards.boardId, boardId) : undefined,
    isNull(cards.archivedAt),
    isNull(boardColumns.archivedAt),
    isNull(boards.archivedAt),
    isNull(projects.archivedAt),
  );
}

export async function loadSchedule(actor: Actor, scope: Scope, from: string, to: string): Promise<ScheduleDTO> {
  const { start, end } = range(from, to);
  const projectIds = [...scope.accesses.keys()];
  const empty: ScheduleDTO = { from: start.toISOString(), to: end.toISOString(), cards: [], milestones: [], unscheduled: [], unscheduledTotal: 0, truncated: false };
  if (!projectIds.length) return empty;
  const live = liveCards(projectIds, scope.boardId);
  const base = () =>
    db
      .select({ id: cards.id })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(projects, eq(projects.id, cards.projectId));

  // Cards whose own span overlaps, and cards with a deliverable whose (effective) span overlaps.
  const [byCard, byDeliverable] = await Promise.all([
    base().where(
      and(
        live,
        sql`coalesce(${cards.startAt}, ${cards.dueAt}) <= ${end.toISOString()}::timestamptz`,
        sql`coalesce(${cards.dueAt}, ${cards.startAt}) >= ${start.toISOString()}::timestamptz`,
      ),
    ),
    base()
      .innerJoin(deliverables, and(eq(deliverables.cardId, cards.id), isNull(deliverables.archivedAt)))
      .where(
        and(
          live,
          sql`coalesce(${deliverables.startAt}, ${cards.startAt}, ${deliverables.dueAt}, ${cards.dueAt}) <= ${end.toISOString()}::timestamptz`,
          sql`coalesce(${deliverables.dueAt}, ${cards.dueAt}, ${deliverables.startAt}, ${cards.startAt}) >= ${start.toISOString()}::timestamptz`,
        ),
      ),
  ]);
  let ids = [...new Set([...byCard, ...byDeliverable].map((r) => r.id))];
  const truncated = ids.length > MAX_CARDS;
  ids = ids.slice(0, MAX_CARDS);

  const cardRows = ids.length
    ? await db
        .select({ card: cards, board: { id: boards.id, number: boards.number, name: boards.name } })
        .from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .where(inArray(cards.id, ids))
    : [];
  const [deliverableRows, assigneeRows, reviewerRows, linkRows] = ids.length
    ? await Promise.all([
        db.select().from(deliverables).where(and(inArray(deliverables.cardId, ids), isNull(deliverables.archivedAt))).orderBy(asc(deliverables.position)),
        db.select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId }).from(cardAssignees).where(inArray(cardAssignees.cardId, ids)),
        db.select({ cardId: cardReviewers.cardId, userId: cardReviewers.userId }).from(cardReviewers).where(inArray(cardReviewers.cardId, ids)),
        db.select().from(deliverableLinks).where(inArray(deliverableLinks.cardId, ids)),
      ])
    : [[], [], [], []];
  const contributorRows = deliverableRows.length
    ? await db
        .select({ deliverableId: deliverableContributors.deliverableId, userId: deliverableContributors.userId })
        .from(deliverableContributors)
        .where(inArray(deliverableContributors.deliverableId, deliverableRows.map((d) => d.id)))
    : [];

  const group = <T, K extends keyof T>(rows: T[], key: K) => {
    const map = new Map<T[K], T[]>();
    for (const r of rows) map.set(r[key], [...(map.get(r[key]) ?? []), r]);
    return map;
  };
  const assignees = group(assigneeRows, "cardId");
  const reviewers = group(reviewerRows, "cardId");
  const links = group(linkRows, "cardId");
  const contributors = group(contributorRows, "deliverableId");
  const byCardDeliverables = group(deliverableRows, "cardId");
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const me = actor.userId;

  const out: ScheduleCardDTO[] = [];
  for (const { card, board } of cardRows) {
    const access = scope.accesses.get(card.projectId)!;
    const assigneeIds = (assignees.get(card.id) ?? []).map((a) => a.userId);
    const cardReviewerIds = (reviewers.get(card.id) ?? []).map((r) => r.userId);
    const ds = byCardDeliverables.get(card.id) ?? [];
    const states = new Map(ds.map((d) => [d.id, d.state]));
    const cardLinks = (links.get(card.id) ?? []).filter((l) => states.has(l.fromId) && states.has(l.toId));
    const deliverableDtos = ds.map((d) => {
      const contributorIds = (contributors.get(d.id) ?? []).map((c) => c.userId);
      const explicit = Boolean(d.ownerId) || contributorIds.length > 0;
      const team = explicit ? [d.ownerId, ...contributorIds].filter(Boolean) : assigneeIds;
      const reviewing = d.reviewerId ? d.reviewerId === me : cardReviewerIds.includes(me);
      return {
        id: d.id,
        number: d.number,
        name: d.name,
        state: d.state,
        required: d.required,
        startAt: iso(d.startAt ?? card.startAt),
        dueAt: iso(d.dueAt ?? card.dueAt),
        ownStartAt: iso(d.startAt),
        ownDueAt: iso(d.dueAt),
        blockedBy: cardLinks.filter((l) => l.type === "DEPENDENCY" && l.toId === d.id && states.get(l.fromId) !== "APPROVED").map((l) => l.fromId),
        mine: team.includes(me) || reviewing,
      };
    });
    const mine = assigneeIds.includes(me) || deliverableDtos.some((d) => d.mine);
    if (scope.mineOnly && !mine) continue;
    out.push({
      id: card.id,
      key: `${access.project.key}-${card.number}`,
      number: card.number,
      title: card.title,
      state: card.state,
      project: { id: access.project.id, slug: access.project.slug, name: access.project.name, icon: access.project.icon, key: access.project.key, studioSlug: access.studioSlug },
      board,
      columnId: card.columnId,
      startAt: iso(card.startAt),
      dueAt: iso(card.dueAt),
      assigneeIds,
      canEdit: computeCardPermissions(access, card, assigneeIds).canEdit,
      mine,
      deliverables: deliverableDtos,
      links: cardLinks.map((l) => ({ fromId: l.fromId, toId: l.toId, type: l.type })),
    });
  }
  out.sort((a, b) => (a.startAt ?? a.dueAt ?? "").localeCompare(b.startAt ?? b.dueAt ?? "") || a.number - b.number);

  const milestoneRows = await db
    .select({ m: milestones, project: { id: projects.id, slug: projects.slug, name: projects.name, icon: projects.icon } })
    .from(milestones)
    .innerJoin(projects, eq(projects.id, milestones.projectId))
    .where(and(inArray(milestones.projectId, projectIds), isNull(milestones.archivedAt), gte(milestones.dueAt, start), lte(milestones.dueAt, end)))
    .orderBy(asc(milestones.dueAt));

  let unscheduled: ScheduleDTO["unscheduled"] = [];
  let unscheduledTotal = 0;
  if (scope.withUnscheduled) {
    const undated = and(
      live,
      isNull(cards.startAt),
      isNull(cards.dueAt),
      sql`not exists (select 1 from ${deliverables} d where d.card_id = ${cards.id} and d.archived_at is null and (d.start_at is not null or d.due_at is not null))`,
    );
    const rows = await db
      .select({ id: cards.id, number: cards.number, title: cards.title, state: cards.state, projectId: cards.projectId, boardNumber: boards.number, total: sql<number>`count(*) over ()`.mapWith(Number) })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(projects, eq(projects.id, cards.projectId))
      .where(undated)
      .orderBy(asc(cards.number))
      .limit(100);
    unscheduledTotal = rows[0]?.total ?? 0;
    unscheduled = rows.map((r) => ({ id: r.id, key: `${scope.accesses.get(r.projectId)!.project.key}-${r.number}`, title: r.title, state: r.state, boardNumber: r.boardNumber }));
  }

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    cards: out,
    milestones: milestoneRows.map(({ m, project }) => ({ id: m.id, name: m.name, dueAt: m.dueAt!.toISOString(), released: Boolean(m.releasedAt), project: { ...project, studioSlug: scope.accesses.get(project.id)!.studioSlug } })),
    unscheduled,
    unscheduledTotal,
    truncated,
  };
}

/** A board's schedule, or (no board) the whole project's across its boards. */
export async function boardSchedule(actor: Actor, input: { projectId: string; boardId?: string | null; from: string; to: string }) {
  const access = await requireProject(actor.userId, input.projectId, "project.view");
  if (input.boardId) {
    const [board] = await db.select({ id: boards.id }).from(boards).where(and(eq(boards.id, input.boardId), eq(boards.projectId, access.project.id)));
    if (!board) throw notFound("Board");
  }
  return loadSchedule(actor, { accesses: new Map([[access.project.id, access]]), boardId: input.boardId, withUnscheduled: true }, input.from, input.to);
}

async function accessesFor(userId: string, studioId?: string) {
  const ids = [...(await accessibleProjectIds(userId, studioId))];
  const out = new Map<string, ProjectAccess>();
  for (const id of ids) {
    const access = await getProjectAccess(userId, id);
    if (access && !access.project.archivedAt) out.set(id, access);
  }
  return out;
}

/** "My calendar": the person's work (or everything they can see) across a studio's projects. */
export async function studioSchedule(actor: Actor, input: { studioId: string; from: string; to: string; scope: "mine" | "all" }) {
  await requireStudio(actor.userId, input.studioId);
  return loadSchedule(actor, { accesses: await accessesFor(actor.userId, input.studioId), mineOnly: input.scope === "mine" }, input.from, input.to);
}

/** Everything a person works on, across all their studios (calendar subscriptions). */
export async function personalSchedule(userId: string, from: string, to: string) {
  return loadSchedule({ userId }, { accesses: await accessesFor(userId), mineOnly: true }, from, to);
}

