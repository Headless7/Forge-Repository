/**
 * The forum list's filters and sorting, kept apart from the page so they can be tested. Every
 * filter narrows the list and they all combine: an item shows only when it passes each one.
 */
import { ITEM_PRIORITY_META, isResolvedItem } from "./forum-meta";
import type { ForumItemSummaryDTO, ItemPriority } from "./types";

/** "all": every update · "none": items without one · otherwise a milestone id. */
export type ItemScope = "all" | "none" | (string & {});
export type ItemStatusFilter = "open" | "resolved" | "all";
export type ItemSort = "newest" | "priority" | "updated" | "due";
/** Anyone · "none": unassigned · "me": the viewer · otherwise a member id. */
export type AssigneeFilter = "any" | "none" | "me" | (string & {});
/** Anyone · "me": the viewer · otherwise a member id. */
export type ReporterFilter = "any" | "me" | (string & {});

export interface ItemFilters {
  scope: ItemScope;
  status: ItemStatusFilter;
  priority: ItemPriority | "any";
  tagId: "any" | (string & {});
  assignee: AssigneeFilter;
  reporter: ReporterFilter;
  /** Items the viewer is on in any way: assignee, reviewer or reporter. */
  mine: boolean;
  query: string;
}

export const DEFAULT_ITEM_FILTERS: ItemFilters = { scope: "all", status: "open", priority: "any", tagId: "any", assignee: "any", reporter: "any", mine: false, query: "" };

type Item = Pick<ForumItemSummaryDTO, "key" | "title" | "status" | "priority" | "milestoneId" | "tagIds" | "assigneeId" | "reviewerId" | "reportedById" | "dueAt" | "createdAt" | "lastActivityAt">;

export function matchesItemFilters(item: Item, f: ItemFilters, viewerId: string): boolean {
  if (f.scope === "none" ? item.milestoneId : f.scope !== "all" && item.milestoneId !== f.scope) return false;
  if (f.status === "open" ? isResolvedItem(item.status) : f.status === "resolved" && !isResolvedItem(item.status)) return false;
  if (f.priority !== "any" && item.priority !== f.priority) return false;
  if (f.tagId !== "any" && !item.tagIds.includes(f.tagId)) return false;
  if (f.assignee !== "any") {
    const wanted = f.assignee === "none" ? null : f.assignee === "me" ? viewerId : f.assignee;
    if (item.assigneeId !== wanted) return false;
  }
  if (f.reporter !== "any" && item.reportedById !== (f.reporter === "me" ? viewerId : f.reporter)) return false;
  if (f.mine && item.assigneeId !== viewerId && item.reviewerId !== viewerId && item.reportedById !== viewerId) return false;
  const needle = f.query.trim().toLowerCase();
  if (needle && !`${item.key} ${item.title}`.toLowerCase().includes(needle)) return false;
  return true;
}

/** Filters that narrow the list beyond the scope and status tabs (what "Try clearing a filter" is about). */
export function hasNarrowingFilters(f: ItemFilters): boolean {
  return Boolean(f.query.trim()) || f.priority !== "any" || f.tagId !== "any" || f.assignee !== "any" || f.reporter !== "any" || f.mine;
}

/** Newest first · priority (highest first) · recently updated · due date (soonest first, no date last). Ties: newest first. */
export function compareItems(sort: ItemSort) {
  const rank = (b: Item) => ITEM_PRIORITY_META[b.priority].rank;
  return (a: Item, b: Item): number => {
    const newest = b.createdAt.localeCompare(a.createdAt);
    if (sort === "priority") return rank(b) - rank(a) || newest;
    if (sort === "updated") return b.lastActivityAt.localeCompare(a.lastActivityAt) || newest;
    if (sort === "due") {
      if (a.dueAt && b.dueAt) return Date.parse(a.dueAt) - Date.parse(b.dueAt) || newest;
      if (a.dueAt || b.dueAt) return a.dueAt ? -1 : 1;
      return newest;
    }
    return newest;
  };
}

export function filterItems<T extends Item>(items: readonly T[], f: ItemFilters, viewerId: string, sort: ItemSort): T[] {
  return items.filter((item) => matchesItemFilters(item, f, viewerId)).sort(compareItems(sort));
}
