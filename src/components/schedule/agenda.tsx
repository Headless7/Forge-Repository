"use client";

import { CheckSquare, Flag, Play } from "lucide-react";
import { CARD_STATE_META } from "@/lib/card-meta";
import type { ScheduleChecklistItemDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ScheduleSelection } from "./schedule-item-dialog";
import { dateKey, formatDayHeading, formatTime, sameDay, startOfDay, type CalendarEntry } from "./schedule-utils";

/** Starts, deadlines, checklist items and milestones as a day-by-day list (phones, and anywhere a grid is too wide). */
export function Agenda({
  entries,
  onSelect,
  onOpenItem,
  emptyText = "Nothing scheduled in this period.",
}: {
  entries: CalendarEntry[];
  onSelect: (selection: ScheduleSelection) => void;
  /** Opens a checklist item's card (calendars list items; the timeline doesn't). */
  onOpenItem?: (item: ScheduleChecklistItemDTO) => void;
  emptyText?: string;
}) {
  if (!entries.length) return <p className="px-4 py-10 text-center text-[13px] text-fg-muted">{emptyText}</p>;
  const days: Array<{ day: Date; items: CalendarEntry[] }> = [];
  for (const e of entries) {
    const day = startOfDay(e.at);
    const last = days.at(-1);
    if (last && dateKey(last.day) === dateKey(day)) last.items.push(e);
    else days.push({ day, items: [e] });
  }
  const today = new Date();
  return (
    <ol className="grid grid-cols-1 gap-4 p-3" aria-label="Agenda">
      {days.map(({ day, items }) => (
        <li key={dateKey(day)}>
          <h3 className={cn("sticky top-0 z-[1] bg-board/90 py-1 text-[12px] font-semibold uppercase tracking-wide backdrop-blur", sameDay(day, today) ? "text-accent" : "text-fg-subtle")}>
            {sameDay(day, today) ? "Today · " : ""}
            {formatDayHeading(day)}
          </h3>
          <ul className="mt-1 grid grid-cols-1 gap-1">
            {items.map((e) => (
              <li key={e.key}>
                {e.item ? (
                  <button
                    type="button"
                    onClick={() => onOpenItem?.(e.item!)}
                    className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-[13px] hover:border-border-strong", e.overdue && "border-danger/50")}
                  >
                    <CheckSquare className="size-4 shrink-0 text-fg-subtle" aria-label="Checklist item" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-medium">{e.title}</span>
                      <span className="block truncate text-[11.5px] text-fg-subtle">
                        <span className="font-mono">{e.ref}</span> · {e.item.card.title} · {e.item.card.project.name}
                      </span>
                    </span>
                    <span className={cn("shrink-0 text-right text-[11.5px]", e.overdue ? "font-semibold text-danger" : "text-fg-muted")}>{e.overdue ? "overdue" : "checklist"}</span>
                  </button>
                ) : e.milestone ? (
                  <div className="flex min-h-11 items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-[13px]">
                    <Flag className="size-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate font-medium">{e.title}</span>
                    <span className="shrink-0 text-[11.5px] text-fg-subtle">{e.milestone.released ? "released" : "milestone"}</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => e.card && onSelect({ card: e.card, deliverable: e.deliverable })}
                    className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-[13px] hover:border-border-strong", e.overdue && "border-danger/50")}
                  >
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: e.state ? CARD_STATE_META[e.state].color : undefined }} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{e.title}</span>
                      <span className="block truncate text-[11.5px] text-fg-subtle">
                        <span className="font-mono">{e.ref}</span>
                        {e.card ? ` · ${e.card.project.name} · ${e.card.board.name}` : ""}
                      </span>
                    </span>
                    <span className={cn("shrink-0 text-right text-[11.5px]", e.overdue ? "font-semibold text-danger" : "text-fg-muted")}>
                      {e.type === "start" ? (
                        <span className="inline-flex items-center gap-0.5">
                          <Play className="size-3" /> starts
                        </span>
                      ) : e.overdue ? (
                        "overdue"
                      ) : (
                        `due ${formatTime(e.at)}`
                      )}
                      {e.inherited ? <span className="block text-fg-subtle">card&apos;s deadline</span> : null}
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
