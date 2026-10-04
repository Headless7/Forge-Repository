"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Flag, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { CARD_STATE_META } from "@/lib/card-meta";
import { qk } from "@/lib/queries";
import { errorMessage, rpc } from "@/lib/rpc-client";
import type { ScheduleCardDTO, ScheduleDeliverableDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { TipAnchor } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Agenda } from "./agenda";
import { ScheduleItemDialog, type ScheduleSelection } from "./schedule-item-dialog";
import { addDays, calendarEntries, DAY, isDueSoon, isOverdue, openTargetOf, sameDay, shiftIso, startOfDay, useBoardSchedule, type OpenTarget } from "./schedule-utils";

type Zoom = "day" | "week" | "month";
const ZOOMS: Record<Zoom, { px: number; days: number; step: number; label: string }> = {
  day: { px: 44, days: 42, step: 14, label: "Days" },
  week: { px: 14, days: 126, step: 28, label: "Weeks" },
  month: { px: 4, days: 371, step: 91, label: "Months" },
};
const ROW_H = 36;
const HEADER_H = 46;
const ZOOM_KEY = "forge:timeline-zoom";

interface Row {
  card: ScheduleCardDTO;
  d: ScheduleDeliverableDTO | null;
  top: number;
}

interface Drag {
  key: string;
  card: ScheduleCardDTO;
  d: ScheduleDeliverableDTO | null;
  mode: "move" | "start" | "end";
  x0: number;
  delta: number;
}

function anchorFor(zoom: Zoom) {
  return addDays(startOfDay(new Date()), -Math.round(ZOOMS[zoom].days * 0.2));
}

/**
 * A board's work over time: cards (and, nested, their deliverables) as bars from start to
 * deadline, dependencies as arrows, milestones and today as lines. People who may edit an item drag
 * its bar to move it or its ends to change the start/deadline (whole days; the time of day is
 * kept); the dates dialog does the same by keyboard or touch. Phones get an agenda list.
 */
export function TimelineView({
  projectId,
  projectSlug,
  studioSlug,
  boardId,
  visibleCardIds,
  onOpenCard,
}: {
  projectId: string;
  projectSlug: string;
  studioSlug: string;
  boardId: string;
  /** Cards passing the board's filters (null = all). */
  visibleCardIds: Set<string> | null;
  onOpenCard: (target: OpenTarget) => void;
}) {
  const narrow = useMediaQuery("(max-width: 767px)");
  // Short bars stay at least a fingertip wide on touch screens.
  const coarse = useMediaQuery("(pointer: coarse)");
  const queryClient = useQueryClient();
  const [zoom, setZoomState] = useState<Zoom>("week");
  const [anchor, setAnchor] = useState(() => anchorFor("week"));
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ZOOM_KEY) as Zoom | null;
      if (saved && saved in ZOOMS) {
        setZoomState(saved);
        setAnchor(anchorFor(saved));
      }
    } catch {
      // storage unavailable — keep the default
    }
  }, []);
  const setZoom = (z: Zoom) => {
    setZoomState(z);
    setAnchor(anchorFor(z));
    try {
      localStorage.setItem(ZOOM_KEY, z);
    } catch {
      // ignore
    }
  };
  const { px, days, step } = ZOOMS[zoom];
  const from = useMemo(() => startOfDay(anchor), [anchor]);
  const to = useMemo(() => addDays(from, days), [from, days]);
  const schedule = useBoardSchedule(projectId, boardId, from, to);
  const canEditAny = Boolean(schedule.data?.cards.some((c) => c.canEdit));
  const [selection, setSelection] = useState<ScheduleSelection | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pending, setPending] = useState<Map<string, { startAt: string | null; dueAt: string | null }>>(new Map());
  const dragged = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  const x = (iso: string | Date) => ((new Date(iso).getTime() - from.getTime()) / DAY) * px;
  const width = days * px;
  const cards = useMemo(() => (schedule.data?.cards ?? []).filter((c) => !visibleCardIds || visibleCardIds.has(c.id)), [schedule.data, visibleCardIds]);

  const rows: Row[] = [];
  for (const card of cards) {
    rows.push({ card, d: null, top: rows.length * ROW_H });
    if (card.deliverables.length > 1 && !collapsed.has(card.id)) {
      for (const d of card.deliverables) rows.push({ card, d, top: rows.length * ROW_H });
    }
  }
  const rowOf = new Map(rows.filter((r) => r.d).map((r) => [r.d!.id, r]));

  /** The dates shown for an item: while dragging, the dragged ones; then any unsaved ones. */
  const datesOf = (key: string, card: ScheduleCardDTO, d: ScheduleDeliverableDTO | null) => {
    let start = d ? d.startAt : card.startAt;
    let due = d ? d.dueAt : card.dueAt;
    const saved = pending.get(key);
    if (saved) ({ startAt: start, dueAt: due } = saved);
    if (drag && drag.key === key && drag.delta) {
      if (drag.mode !== "end") start = shiftIso(start, drag.delta);
      if (drag.mode !== "start") due = shiftIso(due, drag.delta);
      if (start && due && start > due) {
        if (drag.mode === "start") start = due;
        else due = start;
      }
    }
    return { start, due };
  };

  const commit = async (g: Drag) => {
    const { start, due } = datesOf(g.key, g.card, g.d);
    const key = g.key;
    setPending((m) => new Map(m).set(key, { startAt: start, dueAt: due }));
    try {
      if (g.d) {
        await rpc("deliverable.update", { deliverableId: g.d.id, startAt: start, dueAt: due });
        if (!g.d.ownStartAt && !g.d.ownDueAt) toast(`${g.d.name} now has its own dates (it no longer follows the card's).`);
      } else {
        await rpc("card.update", { cardId: g.card.id, startAt: start, dueAt: due });
      }
      await queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.card(g.card.id) });
    } catch (error) {
      toast.error(`Couldn't change the dates — ${errorMessage(error)}`);
    } finally {
      setPending((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
    }
  };

  const startDrag = (e: ReactPointerEvent, key: string, card: ScheduleCardDTO, d: ScheduleDeliverableDTO | null, mode: Drag["mode"]) => {
    // Touch scrolls the timeline; a tap opens the dates dialog instead.
    if (!card.canEdit || e.pointerType === "touch" || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragged.current = false;
    setDrag({ key, card, d, mode, x0: e.clientX, delta: 0 });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / px);
    if (delta !== drag.delta) {
      dragged.current = true;
      setDrag({ ...drag, delta });
    }
  };
  const endDrag = () => {
    if (!drag) return;
    const g = drag;
    setDrag(null);
    if (g.delta) void commit(g);
  };

  if (narrow) {
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        {/* Phones get the day list, so the calendar wording applies. */}
        <TipAnchor tip="schedule.dates" facts={{ view: "calendar", canEditAny, ready: Boolean(schedule.data) }}>
          <div>
            <RangeBar from={from} to={to} onPrev={() => setAnchor(addDays(anchor, -step))} onNext={() => setAnchor(addDays(anchor, step))} onToday={() => setAnchor(anchorFor(zoom))} />
          </div>
        </TipAnchor>
        <Agenda entries={calendarEntries(schedule.data, { showStarts: true, visibleCardIds })} onSelect={setSelection} />
        <ScheduleItemDialog selection={selection} onClose={() => setSelection(null)} onOpenCard={(s) => onOpenCard(openTargetOf(s.card, s.deliverable))} />
      </div>
    );
  }

  const today = new Date();
  const ticks: Array<{ at: Date; label: string; major: boolean; weekend: boolean }> = [];
  for (let i = 0; i <= days; i++) {
    const d = addDays(from, i);
    const monthStart = d.getDate() === 1;
    if (zoom === "day") ticks.push({ at: d, label: String(d.getDate()), major: monthStart, weekend: d.getDay() === 0 || d.getDay() === 6 });
    else if (zoom === "week" && d.getDay() === 1) ticks.push({ at: d, label: String(d.getDate()), major: monthStart, weekend: false });
    else if (zoom === "month" && monthStart) ticks.push({ at: d, label: "", major: true, weekend: false });
  }
  const months: Array<{ at: Date; label: string }> = [];
  for (let i = 0; i <= days; i++) {
    const d = addDays(from, i);
    if (i === 0 || d.getDate() === 1) months.push({ at: d, label: d.toLocaleDateString(undefined, { month: zoom === "month" ? "short" : "long", year: d.getMonth() === 0 || i === 0 ? "numeric" : undefined }) });
  }
  const milestones = schedule.data?.milestones ?? [];
  const totalHeight = Math.max(rows.length * ROW_H, 120);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TipAnchor tip="schedule.dates" facts={{ view: "timeline", canEditAny, ready: Boolean(schedule.data) }}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-3 py-1.5">
        <RangeBar inline from={from} to={to} onPrev={() => setAnchor(addDays(anchor, -step))} onNext={() => setAnchor(addDays(anchor, step))} onToday={() => setAnchor(anchorFor(zoom))} />
        <div role="radiogroup" aria-label="Zoom" className="flex h-7 items-center rounded-md border border-border-strong bg-surface-3/60 p-0.5">
          {(Object.keys(ZOOMS) as Zoom[]).map((z) => (
            <button key={z} type="button" role="radio" aria-checked={zoom === z} onClick={() => setZoom(z)} className={cn("h-6 rounded px-2 text-[12px] font-medium", zoom === z ? "bg-surface-4 text-fg shadow-sm" : "text-fg-muted hover:text-fg")}>
              {ZOOMS[z].label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span className="hidden items-center gap-3 text-[11.5px] text-fg-muted lg:inline-flex">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-4 rounded-sm ring-2 ring-danger" /> overdue
          </span>
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3" /> blocked
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-px border-l border-dashed border-accent" /> milestone
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-0.5 bg-danger" /> today
          </span>
        </span>
      </div>
      </TipAnchor>

      <div ref={scroller} className="scrollbar-thin relative min-h-0 flex-1 overflow-auto" onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
        <div className="relative" style={{ width: `calc(var(--tl-label) + ${width}px)`, ["--tl-label" as string]: "clamp(170px, 22vw, 260px)" }}>
          {/* Scale */}
          <div className="sticky top-0 z-20 flex border-b border-border bg-surface" style={{ height: HEADER_H }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-end border-r border-border bg-surface px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle" style={{ width: "var(--tl-label)" }}>
              Work
            </div>
            <div className="relative shrink-0" style={{ width }}>
              {months.map((m) => (
                <span key={m.at.toISOString()} className="absolute top-1 whitespace-nowrap pl-1.5 text-[11.5px] font-semibold" style={{ left: x(m.at) }}>
                  {m.label}
                </span>
              ))}
              {ticks.map((t) => (
                <span key={t.at.toISOString()} className={cn("absolute bottom-1 -translate-x-1/2 text-[10.5px] tabular-nums", sameDay(t.at, today) ? "font-bold text-danger" : t.weekend ? "text-fg-subtle/60" : "text-fg-subtle")} style={{ left: x(t.at) + (zoom === "day" ? px / 2 : 0) }}>
                  {t.label}
                </span>
              ))}
              {milestones.map((m) => (
                <span key={m.id} title={m.name} className="absolute top-[18px] z-10 inline-flex max-w-32 -translate-x-1/2 items-center gap-0.5 truncate rounded bg-accent-soft px-1 text-[10.5px] font-medium text-accent" style={{ left: x(m.dueAt) }}>
                  <Flag className="size-3 shrink-0" />
                  <span className="truncate">{m.name}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Rows */}
          <div className="relative" style={{ height: totalHeight }}>
            <div className="pointer-events-none absolute inset-y-0" style={{ left: "var(--tl-label)", width }}>
              {ticks.map((t) => (
                <span key={t.at.toISOString()} className={cn("absolute inset-y-0 border-l", t.major ? "border-border-strong/70" : "border-border/60", t.weekend && "bg-surface-3/30")} style={{ left: x(t.at), width: zoom === "day" ? px : undefined }} />
              ))}
              {milestones.map((m) => (
                <span key={m.id} className="absolute inset-y-0 border-l-2 border-dashed border-accent/70" style={{ left: x(m.dueAt) }} />
              ))}
              {today >= from && today <= to ? <span className="absolute inset-y-0 z-[5] w-0.5 bg-danger" style={{ left: x(today) }} aria-label="Today" /> : null}
              {/* Dependency arrows between the deliverables of expanded cards */}
              <svg className="absolute inset-0 z-[6] overflow-visible" width={width} height={totalHeight} aria-hidden>
                <defs>
                  <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                  </marker>
                </defs>
                {cards.flatMap((card) =>
                  card.links
                    .filter((l) => l.type === "DEPENDENCY" && rowOf.has(l.fromId) && rowOf.has(l.toId))
                    .map((l) => {
                      const a = rowOf.get(l.fromId)!;
                      const b = rowOf.get(l.toId)!;
                      const ad = datesOf(a.d!.id, card, a.d);
                      const bd = datesOf(b.d!.id, card, b.d);
                      const x1 = x(ad.due ?? ad.start ?? from);
                      const x2 = x(bd.start ?? bd.due ?? from);
                      const y1 = a.top + ROW_H / 2;
                      const y2 = b.top + ROW_H / 2;
                      const done = a.d!.state === "APPROVED";
                      return (
                        <path
                          key={`${l.fromId}-${l.toId}`}
                          d={`M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`}
                          fill="none"
                          strokeWidth={1.5}
                          className={done ? "text-state-approved" : "text-state-review"}
                          stroke="currentColor"
                          markerEnd="url(#tl-arrow)"
                        />
                      );
                    }),
                )}
              </svg>
            </div>

            {rows.map((row) => {
              const { card, d } = row;
              const key = d ? d.id : card.id;
              const { start, due } = datesOf(key, card, d);
              const state = d ? d.state : card.state;
              const overdue = isOverdue(due, state);
              const soon = isDueSoon(due, state);
              const blocked = Boolean(d?.blockedBy.length);
              const inherited = Boolean(d && !d.ownStartAt && !d.ownDueAt);
              const color = CARD_STATE_META[state].color;
              const label = `${d ? `D${d.number} ${d.name}` : `${card.key} ${card.title}`}: ${start ? `starts ${new Date(start).toLocaleDateString()}` : "no start"}, ${due ? `due ${new Date(due).toLocaleDateString()}` : "no deadline"}, ${CARD_STATE_META[state].label}${blocked ? ", blocked" : ""}${overdue ? ", overdue" : ""}`;
              const open = () => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                setSelection({ card, deliverable: d });
              };
              // A card without its own dates spans its deliverables (not draggable).
              const span = !d && !start && !due && card.deliverables.length ? spanOf(card) : null;
              return (
                <div key={key} className={cn("absolute flex w-full border-b border-border/50", d ? "bg-surface/20" : "bg-surface/40")} style={{ top: row.top, height: ROW_H }}>
                  <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-border bg-surface px-2 text-[12.5px]" style={{ width: "var(--tl-label)" }}>
                    {d ? (
                      <span className="flex min-w-0 items-center gap-1.5 pl-5">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                        <span className="shrink-0 font-mono text-[10.5px] text-fg-subtle">D{d.number}</span>
                        <span className="truncate">{d.name}</span>
                        {blocked ? <Lock className="size-3 shrink-0 text-state-review" aria-label="blocked" /> : null}
                      </span>
                    ) : (
                      <>
                        {card.deliverables.length > 1 ? (
                          <button
                            type="button"
                            aria-label={collapsed.has(card.id) ? `Show ${card.key}'s deliverables` : `Hide ${card.key}'s deliverables`}
                            aria-expanded={!collapsed.has(card.id)}
                            onClick={() => setCollapsed((s) => (s.has(card.id) ? new Set([...s].filter((x) => x !== card.id)) : new Set([...s, card.id])))}
                            className="touch-target flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3"
                          >
                            <ChevronDown className={cn("size-3.5 transition-transform", collapsed.has(card.id) && "-rotate-90")} />
                          </button>
                        ) : (
                          <span className="w-5 shrink-0" />
                        )}
                        <button type="button" onClick={() => onOpenCard(openTargetOf(card))} className="flex min-h-8 min-w-0 items-center gap-1.5 text-left hover:underline">
                          <span className="shrink-0 font-mono text-[10.5px] text-fg-subtle">{card.key}</span>
                          <span className="truncate font-medium">{card.title}</span>
                        </button>
                      </>
                    )}
                  </div>
                  <div className="relative shrink-0" style={{ width }}>
                    {span ? (
                      <span className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fg-subtle/40" style={{ left: x(span.start), width: Math.max(4, x(span.end) - x(span.start)) }} title="Spans its deliverables" />
                    ) : start && due ? (
                      <button
                        type="button"
                        aria-label={label}
                        onClick={open}
                        onPointerDown={(e) => startDrag(e, key, card, d, "move")}
                        className={cn(
                          "absolute top-1.5 flex items-center overflow-hidden rounded-md border text-left text-[11px] font-medium text-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent",
                          card.canEdit && "cursor-grab active:cursor-grabbing",
                          overdue ? "ring-2 ring-danger" : soon && "ring-2 ring-warning",
                          inherited && "border-dashed opacity-80",
                          drag?.key === key && "z-10 opacity-90 shadow-lg",
                        )}
                        style={{
                          left: x(start),
                          width: Math.max(coarse ? 24 : 10, x(due) - x(start)),
                          height: ROW_H - 12,
                          background: blocked ? `repeating-linear-gradient(135deg, ${color}, ${color} 6px, color-mix(in srgb, ${color} 70%, black) 6px, color-mix(in srgb, ${color} 70%, black) 12px)` : color,
                          borderColor: `color-mix(in srgb, ${color} 70%, black)`,
                        }}
                      >
                        {card.canEdit ? <span onPointerDown={(e) => startDrag(e, key, card, d, "start")} className="h-full w-2 shrink-0 cursor-ew-resize hover:bg-black/20" aria-hidden /> : null}
                        <span className="min-w-0 flex-1 truncate px-1 drop-shadow">{x(due) - x(start) > 60 ? (d ? d.name : card.title) : ""}</span>
                        {card.canEdit ? <span onPointerDown={(e) => startDrag(e, key, card, d, "end")} className="h-full w-2 shrink-0 cursor-ew-resize hover:bg-black/20" aria-hidden /> : null}
                      </button>
                    ) : start || due ? (
                      // A 24px hit area around the diamond marker (touch and pointer alike).
                      <button
                        type="button"
                        aria-label={label}
                        onClick={open}
                        onPointerDown={(e) => startDrag(e, key, card, d, "move")}
                        className={cn("absolute top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent", card.canEdit && "cursor-grab")}
                        style={{ left: x((due ?? start)!) }}
                        title={due ? "Deadline (no start date)" : "Start (no deadline)"}
                      >
                        <span className={cn("size-3.5 rotate-45 rounded-[3px] border-2", overdue && "ring-2 ring-danger")} style={{ background: due ? color : "transparent", borderColor: color }} aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {!rows.length && schedule.data ? <p className="sticky left-0 px-4 py-8 text-[13px] text-fg-muted">Nothing on this board is scheduled in this period. Give cards a start date or deadline to see them here.</p> : null}
        </div>
      </div>

      {schedule.data && (schedule.data.unscheduledTotal > 0 || schedule.data.truncated) ? (
        <details className="shrink-0 border-t border-border bg-surface/80 px-3 py-1.5 text-[12.5px]">
          <summary className="cursor-pointer select-none py-1 text-fg-muted">
            {schedule.data.unscheduledTotal} card{schedule.data.unscheduledTotal === 1 ? " has" : "s have"} no dates
            {schedule.data.truncated ? " · this period is very busy: some cards aren't shown — zoom in" : ""}
          </summary>
          <ul className="scrollbar-thin flex max-h-28 flex-wrap gap-1 overflow-y-auto pb-1">
            {schedule.data.unscheduled
              .filter((u) => !visibleCardIds || visibleCardIds.has(u.id))
              .map((u) => (
                <li key={u.id}>
                  <button type="button" onClick={() => onOpenCard({ key: u.key, projectSlug, studioSlug, boardNumber: u.boardNumber })} className="inline-flex min-h-7 items-center gap-1 rounded-md border border-border px-2 hover:border-border-strong">
                    <span className="font-mono text-[10.5px] text-fg-subtle">{u.key}</span>
                    <span className="max-w-48 truncate">{u.title}</span>
                  </button>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      <ScheduleItemDialog selection={selection} onClose={() => setSelection(null)} onOpenCard={(s) => onOpenCard(openTargetOf(s.card, s.deliverable))} />
    </div>
  );
}

function spanOf(card: ScheduleCardDTO): { start: string; end: string } | null {
  const dates = card.deliverables.flatMap((d) => [d.startAt, d.dueAt]).filter((v): v is string => Boolean(v)).sort();
  return dates.length ? { start: dates[0]!, end: dates.at(-1)! } : null;
}

/** Previous / Today / Next with the visible range. */
export function RangeBar({ from, to, onPrev, onNext, onToday, inline }: { from: Date; to: Date; onPrev: () => void; onNext: () => void; onToday: () => void; inline?: boolean }) {
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: from.getFullYear() !== to.getFullYear() ? "numeric" : undefined });
  return (
    <div className={cn("flex items-center gap-1", !inline && "border-b border-border px-3 py-1.5")}>
      <Button size="icon-sm" variant="ghost" aria-label="Earlier" onClick={onPrev}>
        <ChevronLeft />
      </Button>
      <Button size="sm" variant="secondary" onClick={onToday}>
        Today
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Later" onClick={onNext}>
        <ChevronRight />
      </Button>
      <span className="ml-1 whitespace-nowrap text-[12.5px] font-medium">
        {fmt(from)} – {fmt(addDays(to, -1))}
      </span>
    </div>
  );
}

