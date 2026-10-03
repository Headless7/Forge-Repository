"use client";

import { useQuery } from "@tanstack/react-query";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { CardState, ScheduleCardDTO, ScheduleDTO, ScheduleDeliverableDTO } from "@/lib/types";

export const DAY = 86_400_000;

/** Where "open" goes: a card (and deliverable) on a board of the current project or another. */
export interface OpenTarget {
  key: string;
  projectSlug: string;
  studioSlug: string;
  boardNumber: number;
  deliverableNumber?: number;
}

export function openTargetOf(card: ScheduleCardDTO, deliverable?: ScheduleDeliverableDTO | null): OpenTarget {
  return { key: card.key, projectSlug: card.project.slug, studioSlug: card.project.studioSlug, boardNumber: card.board.number, deliverableNumber: deliverable?.number };
}

/** Local midnight of a date (days follow the viewer's own calendar). */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Whole local days from `a` to `b` (calendar days, safe across DST changes). */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
}

/** Moves an ISO date by whole days, keeping its time of day. */
export function shiftIso(iso: string | null, days: number): string | null {
  return iso ? addDays(new Date(iso), days).toISOString() : null;
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7)); // Monday
}

export const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function isOverdue(dueAt: string | null, state: CardState, now = Date.now()) {
  return Boolean(dueAt) && state !== "APPROVED" && new Date(dueAt!).getTime() < now;
}

export function isDueSoon(dueAt: string | null, state: CardState, now = Date.now()) {
  if (!dueAt || state === "APPROVED") return false;
  const t = new Date(dueAt).getTime();
  return t >= now && t - now < 2 * DAY;
}

/** A board's (or the whole project's) schedule. Keyed under the board so realtime refreshes it. */
export function useBoardSchedule(projectId: string, boardId: string | null, from: Date, to: Date) {
  return useQuery({
    queryKey: [...qk.board(projectId), "schedule", boardId ?? "all", from.toISOString(), to.toISOString()],
    queryFn: () => rpc("schedule.board", { projectId, boardId, from: from.toISOString(), to: to.toISOString() }),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useStudioSchedule(studioId: string, scope: "mine" | "all", from: Date, to: Date) {
  return useQuery({
    queryKey: ["schedule", studioId, scope, from.toISOString(), to.toISOString()],
    queryFn: () => rpc("schedule.studio", { studioId, scope, from: from.toISOString(), to: to.toISOString() }),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

/** Something on a calendar day: a start or a deadline of a card or deliverable, or a milestone. */
export interface CalendarEntry {
  key: string;
  type: "start" | "due" | "milestone";
  at: Date;
  title: string;
  /** "UTD-4" or "UTD-4 · D2". */
  ref: string;
  state: CardState | null;
  overdue: boolean;
  /** The deadline is the card's (a deliverable following it). */
  inherited: boolean;
  card: ScheduleCardDTO | null;
  deliverable: ScheduleDeliverableDTO | null;
  milestone: ScheduleDTO["milestones"][number] | null;
}

/**
 * Calendar entries for a schedule. Deliverables appear for their own dates; ones following the
 * card's are covered by the card's entry — except in "mine" mode for people who work on the
 * deliverable but aren't on the card, who'd otherwise miss their deadline.
 */
export function calendarEntries(schedule: ScheduleDTO | undefined, options: { viewerId?: string; mineOnly?: boolean; showStarts?: boolean; visibleCardIds?: Set<string> | null } = {}): CalendarEntry[] {
  if (!schedule) return [];
  const out: CalendarEntry[] = [];
  const now = Date.now();
  for (const card of schedule.cards) {
    if (options.visibleCardIds && !options.visibleCardIds.has(card.id)) continue;
    const cardMine = !options.mineOnly || (options.viewerId ? card.assigneeIds.includes(options.viewerId) : card.mine);
    const base = { card, milestone: null };
    if (cardMine && card.dueAt) {
      out.push({ ...base, key: `c-due-${card.id}`, type: "due", at: new Date(card.dueAt), title: card.title, ref: card.key, state: card.state, overdue: isOverdue(card.dueAt, card.state, now), inherited: false, deliverable: null });
    }
    if (cardMine && options.showStarts && card.startAt) {
      out.push({ ...base, key: `c-start-${card.id}`, type: "start", at: new Date(card.startAt), title: card.title, ref: card.key, state: card.state, overdue: false, inherited: false, deliverable: null });
    }
    for (const d of card.deliverables) {
      if (options.mineOnly && !d.mine) continue;
      const ref = `${card.key} · D${d.number}`;
      const inheritedDue = !d.ownDueAt && Boolean(d.dueAt) && Boolean(options.mineOnly) && !cardMine;
      if (d.ownDueAt || inheritedDue) {
        out.push({ ...base, key: `d-due-${d.id}`, type: "due", at: new Date(d.dueAt!), title: d.name, ref, state: d.state, overdue: isOverdue(d.dueAt, d.state, now), inherited: inheritedDue, deliverable: d });
      }
      if (options.showStarts && d.ownStartAt) {
        out.push({ ...base, key: `d-start-${d.id}`, type: "start", at: new Date(d.ownStartAt), title: d.name, ref, state: d.state, overdue: false, inherited: false, deliverable: d });
      }
    }
  }
  for (const m of schedule.milestones) {
    out.push({ key: `m-${m.id}`, type: "milestone", at: new Date(m.dueAt), title: m.name, ref: m.project.name, state: null, overdue: false, inherited: false, card: null, deliverable: null, milestone: m });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.ref.localeCompare(b.ref));
}

export function formatDayHeading(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function formatTime(d: Date) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
