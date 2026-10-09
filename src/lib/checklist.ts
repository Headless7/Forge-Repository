/**
 * Checklist item rules shared by the server (enforcement) and the client (what to offer): who can
 * tick an item off, who items can be given to, and how a due day reads in the viewer's calendar.
 */
import { roleHas } from "./permissions";

/** Anyone who can edit the card, or the item's own person while they can work on the card. */
export function canTickChecklistItem(perms: { canEdit: boolean; canComment: boolean }, item: { assigneeId: string | null }, userId: string): boolean {
  return perms.canEdit || (item.assigneeId === userId && perms.canComment);
}

/** Items go to people who can work on cards — not Viewers. */
export function canTakeChecklistItems(role: string): boolean {
  return roleHas(role, "card.create");
}

/** Today as "YYYY-MM-DD" in the viewer's own calendar. */
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Overdue once its day has passed; "today" on the day itself. Ticked items are never late. */
export function checklistDueState(dueOn: string | null, isDone: boolean, today = localDay()): "overdue" | "today" | "upcoming" | null {
  if (!dueOn || isDone) return null;
  return dueOn < today ? "overdue" : dueOn === today ? "today" : "upcoming";
}

/** A due day at local midnight (so it sits on that day in calendars). */
export function dayToDate(dueOn: string): Date {
  const [y, m, d] = dueOn.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Fri 16 Oct" — the same on the server and in every browser (no locale or time zone involved), so
 * pages render identically on both. The year is added when `today` is known and in another year.
 */
export function formatDueDay(dueOn: string, today: string | null = null): string {
  const [y, m, d] = dueOn.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[weekday]} ${d} ${MONTHS[m - 1]}${today && today.slice(0, 4) !== String(y) ? ` ${y}` : ""}`;
}
