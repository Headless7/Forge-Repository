import { differenceInCalendarDays } from "date-fns";
import type { CardState, CardSummaryDTO, LabelDTO, MemberDTO, Priority, ProductionStatus } from "@/lib/types";

export type DueFilter = "overdue" | "today" | "week" | "none";
export type MediaFilter = "video" | "image" | "audio" | "roblox";

export interface BoardFilters {
  q: string;
  mine: boolean;
  states: CardState[];
  /** Category (column) ids. */
  categories: string[];
  /** Production stages. */
  stages: ProductionStatus[];
  assignees: string[];
  labels: string[];
  priorities: Priority[];
  /** Milestone id, "none" for cards without one, or null for all. */
  milestone: string | null;
  due: DueFilter | null;
  media: MediaFilter | null;
  unread: boolean;
}

export const EMPTY_FILTERS: BoardFilters = {
  q: "",
  mine: false,
  states: [],
  categories: [],
  stages: [],
  assignees: [],
  labels: [],
  priorities: [],
  milestone: null,
  due: null,
  media: null,
  unread: false,
};

const list = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);

export function parseFilters(params: URLSearchParams): BoardFilters {
  const due = params.get("due");
  const media = params.get("media");
  return {
    q: params.get("q") ?? "",
    mine: params.get("mine") === "1",
    states: list(params.get("state")) as CardState[],
    categories: list(params.get("category")),
    stages: list(params.get("stage")).filter((s): s is ProductionStatus => s === "TODO" || s === "COMPLETED" || s === "PUBLISHED"),
    assignees: list(params.get("assignee")),
    labels: list(params.get("label")),
    priorities: list(params.get("priority")) as Priority[],
    milestone: params.get("milestone"),
    due: due === "overdue" || due === "today" || due === "week" || due === "none" ? due : null,
    media: media === "video" || media === "image" || media === "audio" || media === "roblox" ? media : null,
    unread: params.get("unread") === "1",
  };
}

/** Writes filters into the URL params, preserving unrelated keys (e.g. `card`). */
export function writeFilters(filters: BoardFilters, base: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base);
  const set = (key: string, value: string | null | undefined) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  set("q", filters.q.trim() || null);
  set("mine", filters.mine ? "1" : null);
  set("state", filters.states.join(","));
  set("category", filters.categories.join(","));
  set("stage", filters.stages.join(","));
  set("assignee", filters.assignees.join(","));
  set("label", filters.labels.join(","));
  set("priority", filters.priorities.join(","));
  set("milestone", filters.milestone);
  set("due", filters.due);
  set("media", filters.media);
  set("unread", filters.unread ? "1" : null);
  return params;
}

/** Number of active filters, excluding the text query and milestone (shown separately). */
export function activeFilterCount(f: BoardFilters): number {
  return (
    (f.mine ? 1 : 0) +
    f.states.length +
    f.categories.length +
    f.stages.length +
    f.assignees.length +
    f.labels.length +
    f.priorities.length +
    (f.due ? 1 : 0) +
    (f.media ? 1 : 0) +
    (f.unread ? 1 : 0)
  );
}

export function hasAnyFilter(f: BoardFilters): boolean {
  return activeFilterCount(f) > 0 || Boolean(f.q.trim()) || Boolean(f.milestone);
}

export interface FilterContext {
  userId: string;
  members: Map<string, MemberDTO>;
  labels: Map<string, LabelDTO>;
}

export function matchesFilters(card: CardSummaryDTO, f: BoardFilters, ctx: FilterContext): boolean {
  if (f.mine && !card.assigneeIds.includes(ctx.userId)) return false;
  if (f.states.length && !f.states.includes(card.state)) return false;
  if (f.categories.length && !f.categories.includes(card.columnId)) return false;
  if (f.stages.length && !f.stages.includes(card.productionStatus)) return false;
  if (f.assignees.length && !f.assignees.some((id) => card.assigneeIds.includes(id))) return false;
  if (f.labels.length && !f.labels.some((id) => card.labelIds.includes(id))) return false;
  if (f.priorities.length && !f.priorities.includes(card.priority)) return false;
  if (f.milestone === "none" && card.milestoneId) return false;
  if (f.milestone && f.milestone !== "none" && card.milestoneId !== f.milestone) return false;
  if (f.media === "video" && !card.hasVideo) return false;
  if (f.media === "image" && !card.hasImage) return false;
  if (f.media === "audio" && !card.hasAudio) return false;
  if (f.media === "roblox" && !card.hasRoblox) return false;
  if (f.unread && !card.unread) return false;
  if (f.due) {
    if (f.due === "none") {
      if (card.dueAt) return false;
    } else {
      if (!card.dueAt) return false;
      const due = new Date(card.dueAt);
      const now = new Date();
      if (f.due === "overdue" && !(due.getTime() < now.getTime() && card.state !== "APPROVED" && card.productionStatus === "TODO")) return false;
      if (f.due === "today" && differenceInCalendarDays(due, now) !== 0) return false;
      if (f.due === "week") {
        const days = differenceInCalendarDays(due, now);
        if (days < 0 || days > 7) return false;
      }
    }
  }
  const q = f.q.trim().toLowerCase();
  if (q) {
    const haystack = [
      card.title,
      card.key,
      ...card.labelIds.map((id) => ctx.labels.get(id)?.name ?? ""),
      ...card.assigneeIds.flatMap((id) => {
        const m = ctx.members.get(id);
        return m ? [m.displayName, m.username] : [];
      }),
    ]
      .join(" ")
      .toLowerCase();
    if (!q.split(/\s+/).every((term) => haystack.includes(term))) return false;
  }
  return true;
}
