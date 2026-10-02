import { clsx, type ClassValue } from "clsx";
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isThisYear, isToday, isYesterday } from "date-fns";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 4730 → "00:04.73" (minutes:seconds.hundredths), with hours when needed. */
export function formatTimecode(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 10));
  const hundredths = total % 100;
  const seconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6000) % 60;
  const hours = Math.floor(total / 360000);
  const core = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${core}` : core;
}

export function formatDuration(ms: number | null | undefined): string {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function timeAgo(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const diff = Date.now() - date.getTime();
  if (diff < 45_000) return "just now";
  return `${formatDistanceToNowStrict(date)} ago`;
}

export function formatDateTime(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (isToday(date)) return `Today, ${format(date, "HH:mm")}`;
  if (isYesterday(date)) return `Yesterday, ${format(date, "HH:mm")}`;
  return format(date, isThisYear(date) ? "MMM d, HH:mm" : "MMM d yyyy, HH:mm");
}

export function formatShortDate(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return format(date, isThisYear(date) ? "MMM d" : "MMM d, yyyy");
}

export type DueStatus = "overdue" | "today" | "soon" | "upcoming";

export function dueStatus(iso: string | null, done = false): DueStatus | null {
  if (!iso || done) return iso ? "upcoming" : null;
  const due = new Date(iso);
  const now = new Date();
  if (due.getTime() < now.getTime()) return "overdue";
  const days = differenceInCalendarDays(due, now);
  if (days === 0) return "today";
  if (days <= 2) return "soon";
  return "upcoming";
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(type);
  }
  return Boolean(target.closest("[role='textbox'], [contenteditable='true']"));
}
