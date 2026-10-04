import { CalendarDays, Flag, Folder, LayoutGrid, Lightbulb, ListChecks, SquareKanban, Star, type LucideIcon } from "lucide-react";
import { isBoardIcon, type BoardIconName } from "@/lib/board-icons";
import { cn } from "@/lib/utils";
import { COLUMN_ICON_COMPONENTS } from "./column-icon";

export const BOARD_ICON_COMPONENTS: Record<BoardIconName, LucideIcon> = {
  "square-kanban": SquareKanban,
  "layout-grid": LayoutGrid,
  "list-checks": ListChecks,
  "calendar-days": CalendarDays,
  folder: Folder,
  flag: Flag,
  star: Star,
  lightbulb: Lightbulb,
  ...COLUMN_ICON_COMPONENTS,
};

/** A board's icon wherever the board appears (sidebar, switcher, settings, menus). Null → the default. */
export function BoardIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  const Icon = isBoardIcon(name) ? BOARD_ICON_COMPONENTS[name] : SquareKanban;
  return <Icon className={cn("shrink-0", className)} aria-hidden />;
}
