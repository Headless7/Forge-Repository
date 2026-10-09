"use client";

import { CalendarDays, CalendarX } from "lucide-react";
import { useLocalDay } from "@/hooks/use-local-day";
import { checklistDueState, formatDueDay } from "@/lib/checklist";
import { cn } from "@/lib/utils";

/** A checklist item's due day: red once the day has passed, amber on the day itself; grey once ticked. */
export function ChecklistDue({ dueOn, isDone = false, className }: { dueOn: string; isDone?: boolean; className?: string }) {
  const today = useLocalDay();
  const state = today ? checklistDueState(dueOn, isDone, today) : null;
  const day = formatDueDay(dueOn, today);
  const Icon = state === "overdue" ? CalendarX : CalendarDays;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium",
        state === "overdue" ? "text-state-changes" : state === "today" ? "text-state-review" : "text-fg-subtle",
        className,
      )}
      title={state === "overdue" ? `Overdue — was due ${day}` : `Due ${day}`}
    >
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{state === "overdue" ? "Overdue, due " : "Due "}</span>
      {state === "today" ? "Today" : day}
    </span>
  );
}
