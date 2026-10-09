"use client";

import { CheckSquare, Flag, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { CARD_STATE_META } from "@/lib/card-meta";
import type { ScheduleChecklistItemDTO, ScheduleDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { TipAnchor } from "../tutorial/tutorial";
import { Agenda } from "./agenda";
import { ScheduleItemDialog, type ScheduleSelection } from "./schedule-item-dialog";
import { addDays, calendarEntries, dateKey, formatTime, openTargetOf, openTargetOfItem, sameDay, startOfDay, startOfWeek, useBoardSchedule, useStudioSchedule, type CalendarEntry, type OpenTarget } from "./schedule-utils";
import { RangeBar } from "./timeline";

type Mode = "month" | "week";

function gridRange(anchor: Date, mode: Mode) {
  if (mode === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7), title: `Week of ${from.toLocaleDateString(undefined, { day: "numeric", month: "long" })}` };
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const from = startOfWeek(first);
  return { from, to: addDays(from, 42), title: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

type OpenItem = (item: ScheduleChecklistItemDTO) => void;

function Chip({ entry, onSelect, onOpenItem }: { entry: CalendarEntry; onSelect: (s: ScheduleSelection) => void; onOpenItem: OpenItem }) {
  if (entry.item) {
    const item = entry.item;
    return (
      <button
        type="button"
        onClick={() => onOpenItem(item)}
        title={`${entry.ref} ${item.card.title} — checklist item${entry.overdue ? ", overdue" : ""}: ${entry.title}`}
        className={cn("flex min-h-6 w-full items-center gap-1 truncate rounded px-1.5 text-left text-[11px] hover:bg-surface-4", entry.overdue ? "bg-danger/10 text-danger" : "bg-surface-3/70")}
      >
        <CheckSquare className="size-3 shrink-0 text-fg-subtle" aria-label="Checklist item" />
        <span className="hidden shrink-0 font-mono text-[10px] text-fg-subtle @min-[150px]:inline">{entry.ref}</span>
        <span className="truncate">{entry.title}</span>
      </button>
    );
  }
  if (entry.milestone) {
    return (
      <span className="flex min-h-6 items-center gap-1 truncate rounded bg-accent-soft px-1.5 text-[11px] font-medium text-accent" title={`Milestone: ${entry.title}`}>
        <Flag className="size-3 shrink-0" />
        <span className="truncate">{entry.title}</span>
      </span>
    );
  }
  const color = entry.state ? CARD_STATE_META[entry.state].color : undefined;
  return (
    <button
      type="button"
      onClick={() => entry.card && onSelect({ card: entry.card, deliverable: entry.deliverable })}
      title={`${entry.ref} ${entry.title}${entry.type === "start" ? " — starts" : " — due"} ${formatTime(entry.at)}`}
      className={cn("flex min-h-6 w-full items-center gap-1 truncate rounded px-1.5 text-left text-[11px] hover:bg-surface-4", entry.overdue ? "bg-danger/10 text-danger" : "bg-surface-3/70")}
    >
      {entry.type === "start" ? <Play className="size-3 shrink-0 text-fg-subtle" aria-label="starts" /> : <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />}
      {/* Narrow days show the title; the key joins it when there's room. */}
      <span className="hidden shrink-0 font-mono text-[10px] text-fg-subtle @min-[150px]:inline">{entry.ref}</span>
      <span className="truncate">{entry.title}</span>
    </button>
  );
}

/** The grid itself, given entries. Days show up to three items, then "+N more". */
function CalendarGrid({ entries, from, to, mode, onSelect, onOpenItem }: { entries: CalendarEntry[]; from: Date; to: Date; mode: Mode; onSelect: (s: ScheduleSelection) => void; onOpenItem: OpenItem }) {
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) map.set(dateKey(e.at), [...(map.get(dateKey(e.at)) ?? []), e]);
    return map;
  }, [entries]);
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const today = new Date();
  const month = addDays(from, 7).getMonth();
  const limit = mode === "month" ? 3 : 50;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto] auto-rows-[minmax(min-content,1fr)] overflow-y-auto border-l border-t border-border" role="grid" aria-label="Calendar">
      {days.slice(0, 7).map((d) => (
        <div key={`h-${dateKey(d)}`} role="columnheader" className="border-b border-r border-border bg-surface px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          {d.toLocaleDateString(undefined, { weekday: "short" })}
        </div>
      ))}
      {days.map((d) => {
        const items = byDay.get(dateKey(d)) ?? [];
        const outside = mode === "month" && d.getMonth() !== month;
        return (
          <div key={dateKey(d)} role="gridcell" aria-label={d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} className={cn("@container flex min-h-24 min-w-0 flex-col gap-0.5 border-b border-r border-border p-1", outside && "bg-surface/40", mode === "week" && "min-h-64")}>
            <span className={cn("mb-0.5 inline-flex size-6 items-center justify-center self-end rounded-full text-[11.5px] tabular-nums", sameDay(d, today) ? "bg-accent font-bold text-white" : outside ? "text-fg-subtle/60" : "text-fg-muted")}>{d.getDate()}</span>
            {items.slice(0, limit).map((e) => (
              <Chip key={e.key} entry={e} onSelect={onSelect} onOpenItem={onOpenItem} />
            ))}
            {items.length > limit ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="min-h-6 rounded px-1.5 text-left text-[11px] font-medium text-accent hover:bg-surface-3">
                    +{items.length - limit} more
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="@container grid w-72 gap-1 p-2">
                  <p className="px-1 text-[12px] font-semibold">{d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
                  {items.map((e) => (
                    <Chip key={e.key} entry={e} onSelect={onSelect} onOpenItem={onOpenItem} />
                  ))}
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Toolbar({ title, mode, setMode, showStarts, setShowStarts, children, onPrev, onNext, onToday, from, to, canEditAny, ready }: {
  canEditAny: boolean;
  ready: boolean;
  title: string;
  mode: Mode;
  setMode: (m: Mode) => void;
  showStarts: boolean;
  setShowStarts: (v: boolean) => void;
  children?: React.ReactNode;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  from: Date;
  to: Date;
}) {
  return (
    <TipAnchor tip="schedule.dates" facts={{ view: "calendar", canEditAny, ready }}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-3 py-1.5">
      <RangeBar inline from={from} to={to} onPrev={onPrev} onNext={onNext} onToday={onToday} />
      <h2 className="sr-only">{title}</h2>
      <div role="radiogroup" aria-label="Calendar view" className="flex h-7 items-center rounded-md border border-border-strong bg-surface-3/60 p-0.5">
        {(["month", "week"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("h-6 rounded px-2 text-[12px] font-medium capitalize", mode === m ? "bg-surface-4 text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
            {m}
          </button>
        ))}
      </div>
      <label className="inline-flex min-h-7 items-center gap-1.5 text-[12px] text-fg-muted">
        <input type="checkbox" checked={showStarts} onChange={(e) => setShowStarts(e.target.checked)} className="accent-[var(--accent)]" />
        Show start dates
      </label>
      <span className="flex-1" />
      {children}
    </div>
    </TipAnchor>
  );
}

function useCalendarState() {
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [showStarts, setShowStarts] = useState(false);
  const { from, to, title } = gridRange(anchor, mode);
  const move = (dir: -1 | 1) => setAnchor(mode === "week" ? addDays(anchor, 7 * dir) : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
  return { mode, setMode, anchor, setAnchor, showStarts, setShowStarts, from, to, title, move };
}

function CalendarBody({ schedule, entries, state, onOpenCard, toolbarExtra, emptyText }: {
  schedule: { data?: ScheduleDTO; isLoading: boolean };
  entries: CalendarEntry[];
  state: ReturnType<typeof useCalendarState>;
  onOpenCard: (target: OpenTarget) => void;
  toolbarExtra?: React.ReactNode;
  emptyText?: string;
}) {
  const narrow = useMediaQuery("(max-width: 767px)");
  const [selection, setSelection] = useState<ScheduleSelection | null>(null);
  // A checklist item has nothing to reschedule here: it opens its card.
  const openItem: OpenItem = (item) => onOpenCard(openTargetOfItem(item));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        canEditAny={Boolean(schedule.data?.cards.some((c) => c.canEdit))}
        ready={Boolean(schedule.data)}
        title={state.title}
        mode={state.mode}
        setMode={state.setMode}
        showStarts={state.showStarts}
        setShowStarts={state.setShowStarts}
        onPrev={() => state.move(-1)}
        onNext={() => state.move(1)}
        onToday={() => state.setAnchor(startOfDay(new Date()))}
        from={state.mode === "month" ? new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1) : state.from}
        to={state.mode === "month" ? new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1) : state.to}
      >
        {toolbarExtra}
      </Toolbar>
      {narrow ? (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <Agenda entries={entries} onSelect={setSelection} onOpenItem={openItem} emptyText={emptyText} />
        </div>
      ) : (
        <CalendarGrid entries={entries} from={state.from} to={state.to} mode={state.mode} onSelect={setSelection} onOpenItem={openItem} />
      )}
      <ScheduleItemDialog selection={selection} onClose={() => setSelection(null)} onOpenCard={(s) => onOpenCard(openTargetOf(s.card, s.deliverable))} />
    </div>
  );
}

/** A board's calendar, or (toggle) the whole project's with each item's board. */
export function BoardCalendar({ projectId, boardId, visibleCardIds, onOpenCard }: { projectId: string; boardId: string; visibleCardIds: Set<string> | null; onOpenCard: (target: OpenTarget) => void }) {
  const state = useCalendarState();
  const [allBoards, setAllBoards] = useState(false);
  const schedule = useBoardSchedule(projectId, allBoards ? null : boardId, state.from, state.to);
  // Board filters apply to this board's cards; across boards everything is shown.
  const entries = calendarEntries(schedule.data, { showStarts: state.showStarts, visibleCardIds: allBoards ? null : visibleCardIds, withItems: true });
  return (
    <CalendarBody
      schedule={schedule}
      entries={entries}
      state={state}
      onOpenCard={onOpenCard}
      toolbarExtra={
        <div role="radiogroup" aria-label="Which boards" className="flex h-7 items-center rounded-md border border-border-strong bg-surface-3/60 p-0.5">
          {(
            [
              [false, "This board"],
              [true, "All boards"],
            ] as const
          ).map(([value, label]) => (
            <button key={label} type="button" role="radio" aria-checked={allBoards === value} onClick={() => setAllBoards(value)} className={cn("h-6 rounded px-2 text-[12px] font-medium", allBoards === value ? "bg-surface-4 text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
              {label}
            </button>
          ))}
        </div>
      }
    />
  );
}

/** "My calendar": the person's work (or everything they can see) across the studio. */
export function StudioCalendar({ studioId, viewerId, onOpenCard, toolbarExtra }: { studioId: string; viewerId: string; onOpenCard: (target: OpenTarget) => void; toolbarExtra?: React.ReactNode }) {
  const state = useCalendarState();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const schedule = useStudioSchedule(studioId, scope, state.from, state.to);
  const entries = calendarEntries(schedule.data, { showStarts: state.showStarts, mineOnly: scope === "mine", viewerId, withItems: true });
  return (
    <CalendarBody
      schedule={schedule}
      entries={entries}
      state={state}
      onOpenCard={onOpenCard}
      emptyText={scope === "mine" ? "Nothing of yours is due in this period." : "Nothing is due in this period."}
      toolbarExtra={
        <>
          <div role="radiogroup" aria-label="Whose work" className="flex h-7 items-center rounded-md border border-border-strong bg-surface-3/60 p-0.5">
            {(
              [
                ["mine", "My work"],
                ["all", "Everything"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={scope === value} onClick={() => setScope(value)} className={cn("h-6 rounded px-2 text-[12px] font-medium", scope === value ? "bg-surface-4 text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
                {label}
              </button>
            ))}
          </div>
          {toolbarExtra}
        </>
      }
    />
  );
}
