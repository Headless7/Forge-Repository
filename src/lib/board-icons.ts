import { COLUMN_ICONS } from "./column-icons";

/**
 * Icons a board can show (lucide names). Stored per board and independent of the project's emoji
 * and its columns' icons; null means the default kanban icon every board starts with.
 */
export const DEFAULT_BOARD_ICON = "square-kanban";

export const BOARD_ICONS = [DEFAULT_BOARD_ICON, "layout-grid", "list-checks", "calendar-days", "folder", "flag", "star", "lightbulb", ...COLUMN_ICONS] as const;

export type BoardIconName = (typeof BOARD_ICONS)[number];

export function isBoardIcon(value: string | null | undefined): value is BoardIconName {
  return typeof value === "string" && (BOARD_ICONS as readonly string[]).includes(value);
}

/** "person-standing" → "Person standing", for accessible labels. */
export function iconLabel(name: string) {
  const words = name.replace(/-\d+$/, "").split("-");
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}
