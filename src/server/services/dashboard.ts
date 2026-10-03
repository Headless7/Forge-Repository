/**
 * The producer dashboard (Managers and above): where a project stands, what's at risk, how review
 * flows, who carries what, and whether milestones will land. Numbers and their drill-down lists
 * come from the same computation, so a number always matches its list.
 *
 * "Now" metrics use the live state of deliverables on live work (archived cards, columns, boards
 * and projects are left out). Flow metrics (review times, approvals, cycle time) replay the
 * append-only review log, so they cover everything since that log began (`historySince`).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { roleHas } from "@/lib/permissions";
import type { CardState, DashboardItemDTO, DashboardListKey, DurationStatDTO, ProjectDashboardDTO, StudioDashboardRowDTO } from "@/lib/types";
import { accessibleProjectIds, getProjectAccess, requireProject, requireStudio, type ProjectAccess } from "../access";
import { now } from "../clock";
import { db } from "../db";
import { boardColumns, boards, cardAssignees, cardReviewers, cards, deliverableContributors, deliverableLinks, deliverables, milestones, reviews } from "../db/schema";
import { forbidden, invalid } from "../errors";
import type { Actor } from "./context";
import { listProjectMembers } from "./members-query";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STALE_DAYS = 14;
const DUE_SOON_DAYS = 7;
const FORECAST_DAYS = 28;
const STATES: CardState[] = ["NOT_SUBMITTED", "IN_PROGRESS", "NEEDS_REVIEW", "CHANGES_REQUESTED", "APPROVED"];

export interface DashboardFilters {
  projectId: string;
  boardId?: string | null;
  milestoneId?: string | null;
  from: string;
  to: string;
}

interface Row {
  item: DashboardItemDTO;
  createdAt: Date;
  due: Date | null;
  milestoneId: string | null;
  lastActivityAt: Date;
  team: string[];
  owners: string[];
  contributors: string[];
  blockedNames: string[];
}

function stat(values: number[]): DurationStatDTO {
  if (!values.length) return { median: null, p75: null, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  };
  const round = (n: number) => Math.round(n * 10) / 10;
  return { median: round(at(0.5)), p75: round(at(0.75)), n: sorted.length };
}

const weekStart = (d: Date) => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * DAY);
};

function parseRange(from: string, to: string) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw invalid("Invalid date range.");
  if (end.getTime() - start.getTime() > 400 * DAY) throw invalid("Choose a range of at most 400 days.");
  return { start, end };
}

/** Live deliverables of a project (optionally one board / milestone) with who works on them. */
async function loadRows(access: ProjectAccess, filters: { boardId?: string | null; milestoneId?: string | null }): Promise<Row[]> {
  const rows = await db
    .select({ d: deliverables, card: cards, board: { number: boards.number, name: boards.name } })
    .from(deliverables)
    .innerJoin(cards, eq(cards.id, deliverables.cardId))
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(
      and(
        eq(deliverables.projectId, access.project.id),
        filters.boardId ? eq(cards.boardId, filters.boardId) : undefined,
        filters.milestoneId ? eq(cards.milestoneId, filters.milestoneId) : undefined,
        isNull(deliverables.archivedAt),
        isNull(cards.archivedAt),
        isNull(boardColumns.archivedAt),
        isNull(boards.archivedAt),
      ),
    )
    .orderBy(asc(cards.number), asc(deliverables.number));
  if (!rows.length) return [];
  const cardIds = [...new Set(rows.map((r) => r.card.id))];
  const ids = rows.map((r) => r.d.id);
  const [assigneeRows, reviewerRows, contributorRows, linkRows] = await Promise.all([
    db.select().from(cardAssignees).where(inArray(cardAssignees.cardId, cardIds)),
    db.select().from(cardReviewers).where(inArray(cardReviewers.cardId, cardIds)),
    db.select().from(deliverableContributors).where(inArray(deliverableContributors.deliverableId, ids)),
    db.select().from(deliverableLinks).where(and(inArray(deliverableLinks.cardId, cardIds), eq(deliverableLinks.type, "DEPENDENCY"))),
  ]);
  const byId = new Map(rows.map((r) => [r.d.id, r.d]));
  return rows.map(({ d, card, board }) => {
    const assignees = assigneeRows.filter((a) => a.cardId === card.id).map((a) => a.userId);
    const contributors = contributorRows.filter((c) => c.deliverableId === d.id).map((c) => c.userId);
    const explicit = Boolean(d.ownerId) || contributors.length > 0;
    const owners = explicit ? (d.ownerId ? [d.ownerId] : []) : assignees;
    const team = [...new Set([...owners, ...(explicit ? contributors : [])])];
    const reviewerIds = d.reviewerId ? [d.reviewerId] : reviewerRows.filter((r) => r.cardId === card.id).map((r) => r.userId);
    const blockedNames = linkRows
      .filter((l) => l.toId === d.id)
      .map((l) => byId.get(l.fromId))
      .filter((p): p is NonNullable<typeof p> => Boolean(p) && p!.state !== "APPROVED")
      .map((p) => p.name);
    const due = d.dueAt ?? card.dueAt;
    return {
      item: {
        deliverableId: d.id,
        cardId: card.id,
        cardKey: `${access.project.key}-${card.number}`,
        cardTitle: card.title,
        number: d.number,
        name: d.name,
        state: d.state,
        required: d.required,
        board,
        dueAt: due?.toISOString() ?? null,
        dueInherited: !d.dueAt && Boolean(card.dueAt),
        people: team,
        reviewerIds,
        note: null,
      },
      createdAt: d.createdAt,
      due,
      milestoneId: card.milestoneId,
      lastActivityAt: card.lastActivityAt,
      team,
      owners,
      contributors: explicit ? contributors : [],
      blockedNames,
    };
  });
}

interface Computed {
  dto: Omit<ProjectDashboardDTO, "workload"> & { workloadIds: Map<string, Omit<ProjectDashboardDTO["workload"][number], "displayName" | "avatarUrl" | "avatarColor">> };
  lists: Map<string, DashboardItemDTO[]>;
}

async function compute(access: ProjectAccess, filters: DashboardFilters): Promise<Computed> {
  const { start, end } = parseRange(filters.from, filters.to);
  const at = now();
  const rows = await loadRows(access, filters);
  const lists = new Map<string, DashboardItemDTO[]>();
  const add = (key: string, row: Row, note: string | null = null) => lists.set(key, [...(lists.get(key) ?? []), { ...row.item, note }]);
  const open = (r: Row) => r.item.state !== "APPROVED";
  const days = (ms: number) => Math.max(0, Math.floor(ms / DAY));

  // ── Now ──
  const byState = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<CardState, number>;
  for (const r of rows) {
    byState[r.item.state] += 1;
    add(`state:${r.item.state}`, r);
    if (!open(r)) continue;
    if (r.due && r.due < at) add("overdue", r, `${days(at.getTime() - r.due.getTime())} day(s) overdue`);
    else if (r.due && r.due.getTime() <= at.getTime() + DUE_SOON_DAYS * DAY) add("dueSoon", r, `due in ${Math.max(0, Math.ceil((r.due.getTime() - at.getTime()) / DAY))} day(s)`);
    if (r.blockedNames.length) add("blocked", r, `waiting on ${r.blockedNames.join(", ")}`);
    if (!r.team.length) add("unassigned", r, "nobody responsible");
    if (r.lastActivityAt.getTime() < at.getTime() - STALE_DAYS * DAY) add("stale", r, `no activity for ${days(at.getTime() - r.lastActivityAt.getTime())} days`);
  }

  // ── Flow (review log) ──
  const ids = rows.map((r) => r.item.deliverableId);
  const log = ids.length ? await db.select().from(reviews).where(inArray(reviews.deliverableId, ids)).orderBy(asc(reviews.createdAt)) : [];
  const [first] = await db
    .select({ at: reviews.createdAt })
    .from(reviews)
    .innerJoin(cards, eq(cards.id, reviews.cardId))
    .where(eq(cards.projectId, access.project.id))
    .orderBy(asc(reviews.createdAt))
    .limit(1);
  const inRange = (t: Date) => t >= start && t <= end;
  const firstReview: number[] = [];
  const toApproval: number[] = [];
  const cycle: number[] = [];
  const weeks = new Map<number, number>();
  for (let w = weekStart(start).getTime(); w <= end.getTime(); w += 7 * DAY) weeks.set(w, 0);
  let decisions = 0;
  let changesRequested = 0;
  let approvals = 0;
  let approvalsAfterChanges = 0;
  const waitingSince = new Map<string, Date>();
  const approvedBefore = new Set<string>();
  const createdAt = new Map(rows.map((r) => [r.item.deliverableId, r.createdAt]));
  const byDeliverable = new Map<string, typeof log>();
  for (const e of log) byDeliverable.set(e.deliverableId!, [...(byDeliverable.get(e.deliverableId!) ?? []), e]);
  for (const [id, events] of byDeliverable) {
    let roundStart: Date | null = null;
    let pending: Date | null = null;
    let hadChanges = false;
    for (const e of events) {
      const t = e.createdAt;
      if (e.action === "SUBMITTED") {
        roundStart ??= t;
        pending = t;
      } else if (e.action === "CHANGES_REQUESTED" || e.action === "APPROVED") {
        if (inRange(t)) {
          decisions += 1;
          if (pending) firstReview.push((t.getTime() - pending.getTime()) / HOUR);
        }
        pending = null;
        if (e.action === "CHANGES_REQUESTED") {
          hadChanges = true;
          if (inRange(t)) changesRequested += 1;
        } else {
          if (inRange(t)) {
            approvals += 1;
            if (hadChanges) approvalsAfterChanges += 1;
            if (roundStart) toApproval.push((t.getTime() - roundStart.getTime()) / HOUR);
            const w = weekStart(t).getTime();
            weeks.set(w, (weeks.get(w) ?? 0) + 1);
            if (!approvedBefore.has(id)) cycle.push((t.getTime() - createdAt.get(id)!.getTime()) / HOUR);
          }
          approvedBefore.add(id);
          roundStart = null;
          hadChanges = false;
        }
      } else if (e.action === "WITHDRAWN") {
        pending = null;
      } else if (e.action === "REOPENED") {
        roundStart = null;
        hadChanges = false;
      }
    }
    if (pending) waitingSince.set(id, pending);
  }
  let oldestWaiting: number | null = null;
  for (const r of rows.filter((x) => x.item.state === "NEEDS_REVIEW")) {
    const since = waitingSince.get(r.item.deliverableId) ?? null;
    const hours = since ? (at.getTime() - since.getTime()) / HOUR : null;
    if (hours !== null) oldestWaiting = Math.max(oldestWaiting ?? 0, hours);
    add("queue", r, hours === null ? "waiting for review" : `waiting ${hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} days`}`);
  }

  // ── Workload ──
  const workload = new Map<string, { userId: string; responsible: number; contributing: number; overdue: number; dueSoon: number; reviewing: number }>();
  const person = (id: string) => workload.get(id) ?? workload.set(id, { userId: id, responsible: 0, contributing: 0, overdue: 0, dueSoon: 0, reviewing: 0 }).get(id)!;
  for (const r of rows.filter(open)) {
    const reviewing = r.item.state === "NEEDS_REVIEW" ? r.item.reviewerIds : [];
    for (const id of new Set([...r.team, ...reviewing])) {
      const p = person(id);
      const notes: string[] = [];
      if (r.owners.includes(id)) {
        p.responsible += 1;
        notes.push("responsible");
      } else if (r.contributors.includes(id)) {
        p.contributing += 1;
        notes.push("contributing");
      }
      if (r.team.includes(id) && r.due && r.due < at) {
        p.overdue += 1;
        notes.push("overdue");
      } else if (r.team.includes(id) && r.due && r.due.getTime() <= at.getTime() + DUE_SOON_DAYS * DAY) {
        p.dueSoon += 1;
        notes.push("due soon");
      }
      if (reviewing.includes(id)) {
        p.reviewing += 1;
        notes.push("to review");
      }
      add(`person:${id}`, r, notes.join(" · "));
    }
  }

  // ── Milestones ──
  const milestoneRows = await db
    .select()
    .from(milestones)
    .where(and(eq(milestones.projectId, access.project.id), isNull(milestones.archivedAt)))
    .orderBy(asc(milestones.position), asc(milestones.createdAt));
  const recentApprovals = new Map<string, number>();
  for (const [id, events] of byDeliverable) {
    if (events.some((e) => e.action === "APPROVED" && e.createdAt.getTime() >= at.getTime() - FORECAST_DAYS * DAY)) recentApprovals.set(id, 1);
  }
  const milestoneDtos = milestoneRows
    .filter((m) => !filters.milestoneId || m.id === filters.milestoneId)
    .map((m) => {
      const required = rows.filter((r) => r.milestoneId === m.id && r.item.required);
      const approved = required.filter((r) => !open(r)).length;
      for (const r of required.filter(open)) add(`milestone:${m.id}`, r, r.blockedNames.length ? `waiting on ${r.blockedNames.join(", ")}` : null);
      const rate = required.filter((r) => !open(r) && recentApprovals.has(r.item.deliverableId)).length / FORECAST_DAYS;
      const remaining = required.length - approved;
      const projected = remaining > 0 && rate > 0 ? new Date(at.getTime() + (remaining / rate) * DAY) : null;
      let forecast: ProjectDashboardDTO["milestones"][number]["forecast"];
      if (m.releasedAt || remaining === 0) forecast = "done";
      else if (m.dueAt && m.dueAt < at) forecast = "late";
      else if (!m.dueAt) forecast = rate > 0 ? "no-due-date" : "no-progress";
      else if (!projected) forecast = "no-progress";
      else forecast = projected <= m.dueAt ? "on-track" : "at-risk";
      return {
        id: m.id,
        name: m.name,
        dueAt: m.dueAt?.toISOString() ?? null,
        released: Boolean(m.releasedAt),
        required: required.length,
        approved,
        ratePerDay: Math.round(rate * 100) / 100,
        projectedAt: projected?.toISOString() ?? null,
        forecast,
      };
    });

  const boardRows = await db.select({ id: boards.id, number: boards.number, name: boards.name }).from(boards).where(and(eq(boards.projectId, access.project.id), isNull(boards.archivedAt))).orderBy(asc(boards.position));
  const required = rows.filter((r) => r.item.required);
  return {
    lists,
    dto: {
      project: { id: access.project.id, slug: access.project.slug, name: access.project.name, icon: access.project.icon, key: access.project.key },
      boards: boardRows,
      milestoneOptions: milestoneRows.map((m) => ({ id: m.id, name: m.name })),
      range: { from: start.toISOString(), to: end.toISOString() },
      generatedAt: at.toISOString(),
      historySince: first?.at.toISOString() ?? null,
      status: { byState, total: rows.length, required: required.length, requiredApproved: required.filter((r) => !open(r)).length },
      risk: {
        overdue: lists.get("overdue")?.length ?? 0,
        dueSoon: lists.get("dueSoon")?.length ?? 0,
        blocked: lists.get("blocked")?.length ?? 0,
        unassigned: lists.get("unassigned")?.length ?? 0,
        stale: lists.get("stale")?.length ?? 0,
      },
      review: {
        queue: lists.get("queue")?.length ?? 0,
        oldestWaitingHours: oldestWaiting === null ? null : Math.round(oldestWaiting),
        firstReview: stat(firstReview),
        toApproval: stat(toApproval),
        decisions,
        changesRequested,
        approvals,
        approvalsAfterChanges,
      },
      throughput: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([w, n]) => ({ weekStart: new Date(w).toISOString(), approved: n })),
      cycleTime: stat(cycle),
      workloadIds: workload,
      milestones: milestoneDtos,
    },
  };
}

async function dashboardAccess(actor: Actor, projectId: string) {
  // Archived projects stay readable (project.view is allowed there) — reports are read-only too.
  const access = await requireProject(actor.userId, projectId, "project.view");
  if (!roleHas(access.role, "reports.view")) throw forbidden("The dashboard is for Managers, Admins and the Owner.");
  return access;
}

export async function projectDashboard(actor: Actor, filters: DashboardFilters): Promise<ProjectDashboardDTO> {
  const access = await dashboardAccess(actor, filters.projectId);
  const { dto } = await compute(access, filters);
  const members = new Map((await listProjectMembers(access.project)).map((m) => [m.id, m]));
  const { workloadIds, ...rest } = dto;
  const workload = [...workloadIds.values()]
    .filter((w) => members.has(w.userId))
    .map((w) => {
      const m = members.get(w.userId)!;
      return { ...w, displayName: m.displayName, avatarUrl: m.avatarUrl, avatarColor: m.avatarColor };
    })
    .sort((a, b) => b.overdue - a.overdue || b.responsible + b.contributing + b.reviewing - (a.responsible + a.contributing + a.reviewing) || a.displayName.localeCompare(b.displayName));
  return { ...rest, workload };
}

/** The deliverables behind one dashboard number (same filters, same computation). */
export async function dashboardList(actor: Actor, input: DashboardFilters & { key: DashboardListKey }): Promise<DashboardItemDTO[]> {
  const access = await dashboardAccess(actor, input.projectId);
  const { lists } = await compute(access, input);
  return lists.get(input.key) ?? [];
}

/** Studio overview: one row per project the person can see reports for. */
export async function studioDashboard(actor: Actor, input: { studioId: string }): Promise<StudioDashboardRowDTO[]> {
  await requireStudio(actor.userId, input.studioId, "reports.view");
  const at = now();
  const rowsOut: StudioDashboardRowDTO[] = [];
  for (const id of await accessibleProjectIds(actor.userId, input.studioId)) {
    const access = await getProjectAccess(actor.userId, id);
    if (!access || access.project.archivedAt || !roleHas(access.role, "reports.view")) continue;
    const { dto } = await compute(access, { projectId: id, from: new Date(at.getTime() - 7 * DAY).toISOString(), to: at.toISOString() });
    rowsOut.push({
      project: { id, slug: access.project.slug, name: access.project.name, icon: access.project.icon },
      open: dto.status.total - dto.status.byState.APPROVED,
      required: dto.status.required,
      requiredApproved: dto.status.requiredApproved,
      overdue: dto.risk.overdue,
      blocked: dto.risk.blocked,
      queue: dto.review.queue,
      approvedThisWeek: dto.review.approvals,
    });
  }
  return rowsOut.sort((a, b) => b.overdue - a.overdue || a.project.name.localeCompare(b.project.name));
}
