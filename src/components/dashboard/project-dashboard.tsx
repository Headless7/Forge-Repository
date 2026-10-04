"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, CalendarX, CircleAlert, CircleCheck, CircleDashed, Clock, Download, Hourglass, Link2Off, Lock, TriangleAlert, UserX } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { CARD_STATE_META } from "@/lib/card-meta";
import { rpc } from "@/lib/rpc-client";
import type { CardState, DashboardItemDTO, DashboardListKey, DurationStatDTO, ProjectDashboardDTO } from "@/lib/types";
import { cn, formatShortDate } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { StatePill } from "../domain/state";
import { TipAnchor, useTipOnOpen } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Select, Skeleton } from "../ui/controls";
import { Dialog, DialogContent } from "../ui/dialog";

const DAY = 86_400_000;
/** Approved first; red and green never side by side (checked for colour-vision deficiencies). */
const STATE_ORDER: CardState[] = ["APPROVED", "NEEDS_REVIEW", "IN_PROGRESS", "CHANGES_REQUESTED", "NOT_SUBMITTED"];
const RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "28", label: "Last 4 weeks", days: 28 },
  { id: "90", label: "Last 3 months", days: 90 },
  { id: "365", label: "Last year", days: 365 },
] as const;

export function hours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return "< 1 h";
  if (h < 48) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(h < 240 ? 1 : 0)} days`;
}

function pct(n: number, of: number) {
  return of ? Math.round((n / of) * 100) : 0;
}

/** Downloads rows as a CSV file (Excel/Sheets friendly). */
export function downloadCsv(filename: string, rows: Array<Array<string | number | null>>) {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(",")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Card({ title, description, children, className, action }: { title: string; description?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border bg-surface-2 p-4", className)} aria-label={title}>
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {description ? <p className="mt-0.5 text-[12px] text-fg-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A number that opens the list behind it. */
function Tile({ label, value, sub, icon, onClick }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[12px] text-fg-muted">
        {icon}
        {label}
      </span>
      <span className="mt-1 block text-[26px] font-semibold leading-none tracking-tight">{value}</span>
      {sub ? <span className="mt-1.5 block text-[11.5px] text-fg-subtle">{sub}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="min-h-24 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent">
      {body}
    </button>
  ) : (
    <div className="min-h-24 rounded-lg border border-border bg-surface p-3">{body}</div>
  );
}

function Meter({ value, of, label }: { value: number; of: number; label: string }) {
  const p = pct(value, of);
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-accent/20" role="meter" aria-valuemin={0} aria-valuemax={of} aria-valuenow={value} aria-label={label}>
        <div className="h-full rounded-full bg-accent" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

/** Part-to-whole of deliverables by state: one stacked bar, 2px surface gaps, and a labelled legend. */
function StateBar({ byState, total, onOpen }: { byState: Record<CardState, number>; total: number; onOpen: (state: CardState) => void }) {
  const [hover, setHover] = useState<CardState | null>(null);
  const parts = STATE_ORDER.filter((s) => byState[s] > 0);
  return (
    <div>
      <div className="relative">
        <div className="flex h-6 gap-0.5">
          {parts.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-label={`${CARD_STATE_META[s].label}: ${byState[s]} (${pct(byState[s], total)}%)`}
              onPointerEnter={() => setHover(s)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(s)}
              onBlur={() => setHover(null)}
              onClick={() => onOpen(s)}
              className={cn("h-full min-w-1.5 transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", i === 0 && "rounded-l", i === parts.length - 1 && "rounded-r")}
              style={{ flexGrow: byState[s], flexBasis: 0, background: CARD_STATE_META[s].color }}
            />
          ))}
          {!parts.length ? <div className="h-full flex-1 rounded bg-surface-3" /> : null}
        </div>
        {hover ? (
          <div role="tooltip" className="pointer-events-none absolute -top-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border-strong bg-surface-2 px-2 py-1 text-[12px] shadow-md">
            <strong>{byState[hover]}</strong> <span className="text-fg-muted">{CARD_STATE_META[hover].label} · {pct(byState[hover], total)}%</span>
          </div>
        ) : null}
      </div>
      <ul className="mt-3 grid gap-1 sm:grid-cols-2 xl:grid-cols-3" aria-label="Deliverables by state">
        {STATE_ORDER.map((s) => (
          <li key={s}>
            <button type="button" onClick={() => onOpen(s)} className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12.5px] hover:bg-surface-3">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CARD_STATE_META[s].color }} aria-hidden />
              <span className="flex-1 text-fg-muted">{CARD_STATE_META[s].label}</span>
              <span className="font-semibold tabular-nums">{byState[s]}</span>
              <span className="w-10 text-right text-[11.5px] tabular-nums text-fg-subtle">{pct(byState[s], total)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Approvals per week: one series, columns ≤ 24px with rounded caps, hairline grid, hover/focus readout. */
function Throughput({ weeks }: { weeks: ProjectDashboardDTO["throughput"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...weeks.map((w) => w.approved));
  const top = max <= 4 ? max : Math.ceil(max / 5) * 5;
  const peak = weeks.reduce((best, w, i) => (w.approved > (weeks[best]?.approved ?? -1) ? i : best), 0);
  const labelEvery = Math.ceil(weeks.length / 8);
  return (
    <div>
      <div className="relative h-40 border-b border-border pl-8">
        {[0, 0.5, 1].map((f) => (
          <div key={f} className="absolute left-8 right-0 border-t border-border/70" style={{ bottom: `${f * 100}%` }}>
            <span className="absolute -left-8 -top-2 w-7 text-right text-[10.5px] tabular-nums text-fg-subtle">{Math.round(top * f)}</span>
          </div>
        ))}
        <div className="absolute inset-0 left-8 flex items-end gap-0.5">
          {weeks.map((w, i) => (
            <div key={w.weekStart} className="relative flex h-full min-w-0 flex-1 items-end justify-center">
              <button
                type="button"
                aria-label={`Week of ${formatShortDate(w.weekStart)}: ${w.approved} approved`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="flex h-full w-full max-w-6 items-end justify-center focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className={cn("block w-full rounded-t bg-accent transition-[filter]", hover === i && "brightness-125")} style={{ height: `${(w.approved / top) * 100}%`, minHeight: w.approved ? 2 : 0 }} />
              </button>
              {(i === peak && w.approved > 0) || (i === weeks.length - 1 && w.approved > 0) ? (
                <span className="pointer-events-none absolute text-[10.5px] font-semibold tabular-nums" style={{ bottom: `calc(${(w.approved / top) * 100}% + 2px)` }}>
                  {w.approved}
                </span>
              ) : null}
              {hover === i ? (
                <div role="tooltip" className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-border-strong bg-surface-2 px-2 py-1 text-[12px] shadow-md">
                  <strong>{w.approved}</strong> <span className="text-fg-muted">approved · week of {formatShortDate(w.weekStart)}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-0.5 pl-8 pt-1">
        {weeks.map((w, i) => (
          <span key={w.weekStart} className="min-w-0 flex-1 truncate text-center text-[10px] text-fg-subtle">
            {i % labelEvery === 0 ? formatShortDate(w.weekStart) : ""}
          </span>
        ))}
      </div>
      <details className="mt-2 text-[12px]">
        <summary className="cursor-pointer text-fg-muted">Show as table</summary>
        <table className="mt-1 w-full text-left">
          <thead>
            <tr className="text-fg-subtle">
              <th className="py-0.5 font-medium">Week of</th>
              <th className="py-0.5 text-right font-medium">Approved</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart} className="border-t border-border/60">
                <td className="py-0.5">{formatShortDate(w.weekStart)}</td>
                <td className="py-0.5 text-right tabular-nums">{w.approved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const FORECAST: Record<ProjectDashboardDTO["milestones"][number]["forecast"], { label: string; icon: ReactNode; className: string }> = {
  done: { label: "Done", icon: <CircleCheck />, className: "text-state-approved" },
  "on-track": { label: "On track", icon: <CalendarCheck />, className: "text-state-approved" },
  "at-risk": { label: "At risk", icon: <TriangleAlert />, className: "text-warning" },
  late: { label: "Late", icon: <CircleAlert />, className: "text-danger" },
  "no-progress": { label: "No recent progress", icon: <CircleDashed />, className: "text-warning" },
  "no-due-date": { label: "No due date", icon: <CalendarX />, className: "text-fg-muted" },
};

const duration = (s: DurationStatDTO) => (s.n ? `${hours(s.median)}` : "—");
const durationSub = (s: DurationStatDTO, what: string) => (s.n ? `p75 ${hours(s.p75)} · ${s.n} ${what}` : `no ${what} in this period`);

function Drilldown({ open, title, items, loading, studioSlug, projectSlug, onClose, filename }: { open: boolean; title: string; items: DashboardItemDTO[] | undefined; loading: boolean; studioSlug: string; projectSlug: string; onClose: () => void; filename: string }) {
  const href = (i: DashboardItemDTO) => `/${studioSlug}/${projectSlug}/b/${i.board.number}?card=${encodeURIComponent(i.cardKey)}&d=${i.number}`;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={title} description={items ? `${items.length} deliverable${items.length === 1 ? "" : "s"}` : undefined} size="lg">
        <div className="scrollbar-thin max-h-[60vh] overflow-y-auto pr-1">
          {loading || !items ? (
            <Skeleton className="h-24" />
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-fg-muted">Nothing here — nice.</p>
          ) : (
            <ul className="grid gap-1">
              {items.map((i) => (
                <li key={i.deliverableId}>
                  <Link href={href(i)} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border px-3 py-2 text-[13px] hover:border-border-strong">
                    <span className="font-mono text-[11px] text-fg-subtle">
                      {i.cardKey} · D{i.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {i.name} <span className="font-normal text-fg-muted">· {i.cardTitle}</span>
                    </span>
                    <StatePill state={i.state} size="sm" />
                    <span className="w-full text-[11.5px] text-fg-subtle sm:w-auto">
                      {i.board.name}
                      {i.dueAt ? ` · due ${formatShortDate(i.dueAt)}${i.dueInherited ? " (card's)" : ""}` : ""}
                      {i.note ? ` · ${i.note}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {items?.length ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                downloadCsv(filename, [
                  ["Card", "Card title", "Deliverable", "State", "Required", "Board", "Due", "Due is the card's", "Note"],
                  ...items.map((i) => [i.cardKey, i.cardTitle, `D${i.number} ${i.name}`, CARD_STATE_META[i.state].label, i.required ? "yes" : "no", i.board.name, i.dueAt, i.dueInherited ? "yes" : "no", i.note]),
                ])
              }
            >
              <Download /> Export CSV
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectDashboard({ projectId, studioSlug, projectSlug, projectName, projectIcon }: { projectId: string; studioSlug: string; projectSlug: string; projectName: string; projectIcon: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("28");
  const [boardId, setBoardId] = useState<string>("all");
  const [milestoneId, setMilestoneId] = useState<string>("all");
  // Stable range for the session (recomputed when the preset changes).
  const period = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGES.find((r) => r.id === range)!.days * DAY).toISOString(), to: to.toISOString() };
  }, [range]);
  const filters = { projectId, boardId: boardId === "all" ? null : boardId, milestoneId: milestoneId === "all" ? null : milestoneId, ...period };
  const data = useQuery({ queryKey: ["dashboard", filters], queryFn: () => rpc("dashboard.project", filters), placeholderData: (prev) => prev, staleTime: 30_000 });
  const [drill, setDrill] = useState<{ key: DashboardListKey; title: string } | null>(null);
  const list = useQuery({ queryKey: ["dashboard-list", filters, drill?.key], queryFn: () => rpc("dashboard.list", { ...filters, key: drill!.key }), enabled: Boolean(drill) });
  const open = (key: DashboardListKey, title: string) => setDrill({ key, title });
  const d = data.data;
  // Opening the dashboard is opening the feature (once its numbers are there to point at).
  useTipOnOpen("dashboard.reading", Boolean(d));

  const exportSummary = () => {
    if (!d) return;
    const rows: Array<Array<string | number | null>> = [
      ["Section", "Metric", "Value"],
      ["Period", "From", d.range.from],
      ["Period", "To", d.range.to],
      ...STATE_ORDER.map((s) => ["Status", CARD_STATE_META[s].label, d.status.byState[s]] as Array<string | number | null>),
      ["Status", "Required approved", `${d.status.requiredApproved} of ${d.status.required}`],
      ["Risk", "Overdue", d.risk.overdue],
      ["Risk", "Due in 7 days", d.risk.dueSoon],
      ["Risk", "Blocked", d.risk.blocked],
      ["Risk", "Unassigned", d.risk.unassigned],
      ["Risk", "No activity for 14+ days", d.risk.stale],
      ["Review", "In review now", d.review.queue],
      ["Review", "Time to first review (median h)", d.review.firstReview.median],
      ["Review", "Submission to approval (median h)", d.review.toApproval.median],
      ["Review", "Changes requested", `${d.review.changesRequested} of ${d.review.decisions} decisions`],
      ["Review", "Approved after changes", `${d.review.approvalsAfterChanges} of ${d.review.approvals}`],
      ["Flow", "Cycle time, created to approved (median h)", d.cycleTime.median],
      ...d.throughput.map((w) => ["Approved per week", w.weekStart.slice(0, 10), w.approved] as Array<string | number | null>),
      [],
      ["Person", "Responsible", "Contributing", "Overdue", "Due in 7 days", "To review"],
      ...d.workload.map((w) => [w.displayName, w.responsible, w.contributing, w.overdue, w.dueSoon, w.reviewing]),
      [],
      ["Milestone", "Due", "Required approved", "Forecast", "Projected finish"],
      ...d.milestones.map((m) => [m.name, m.dueAt, `${m.approved} of ${m.required}`, FORECAST[m.forecast].label, m.projectedAt]),
    ];
    downloadCsv(`forge-${projectSlug}-dashboard-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-4 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-fg-subtle">
              <Link href={`/${studioSlug}/${projectSlug}`} className="hover:text-fg">
                {projectIcon} {projectName}
              </Link>
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Dashboard</h1>
          </div>
          <Button size="sm" variant="secondary" onClick={exportSummary} disabled={!d}>
            <Download /> Export CSV
          </Button>
        </div>

        {/* Filters: one row, scoping everything below. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40">
            <Select aria-label="Period" value={range} onValueChange={(v) => setRange(v as typeof range)} options={RANGES.map((r) => ({ value: r.id, label: r.label }))} className="h-8" />
          </div>
          <div className="w-48">
            <Select aria-label="Board" value={boardId} onValueChange={setBoardId} options={[{ value: "all", label: "All boards" }, ...(d?.boards ?? []).map((b) => ({ value: b.id, label: b.name }))]} className="h-8" />
          </div>
          <div className="w-48">
            <Select aria-label="Milestone" value={milestoneId} onValueChange={setMilestoneId} options={[{ value: "all", label: "All milestones" }, ...(d?.milestoneOptions ?? []).map((m) => ({ value: m.id, label: m.name }))]} className="h-8" />
          </div>
          <span className="text-[11.5px] text-fg-subtle">Status and risk are as of now; review flow and approvals cover the period.</span>
        </div>

        {!d ? (
          <div className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        ) : (
          <div className={cn("grid gap-4 transition-opacity", data.isFetching && "opacity-60")}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Card title="Where things stand" description={`${d.status.total} deliverable${d.status.total === 1 ? "" : "s"} on live work`}>
                <StateBar byState={d.status.byState} total={d.status.total} onOpen={(s) => open(`state:${s}`, CARD_STATE_META[s].label)} />
              </Card>
              <Card title="Required work approved" description="What completing the cards depends on">
                <p className="mb-2 text-[28px] font-semibold leading-none tracking-tight">
                  {pct(d.status.requiredApproved, d.status.required)}%
                </p>
                <Meter value={d.status.requiredApproved} of={d.status.required} label="Required deliverables approved" />
                <p className="mt-2 text-[12px] text-fg-muted">
                  {d.status.requiredApproved} of {d.status.required} required deliverables approved
                </p>
              </Card>
            </div>

            <Card title="Needs attention" description="Unapproved work, as of now">
              <TipAnchor tip="dashboard.reading" facts={{}}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  <Tile label="Overdue" value={d.risk.overdue} icon={<CircleAlert className="size-3.5 text-danger" />} onClick={() => open("overdue", "Overdue")} />
                  <Tile label="Due in 7 days" value={d.risk.dueSoon} icon={<Clock className="size-3.5 text-warning" />} onClick={() => open("dueSoon", "Due in the next 7 days")} />
                  <Tile label="Blocked" value={d.risk.blocked} icon={<Lock className="size-3.5 text-state-review" />} onClick={() => open("blocked", "Blocked by unfinished work")} />
                  <Tile label="Unassigned" value={d.risk.unassigned} icon={<UserX className="size-3.5 text-fg-muted" />} onClick={() => open("unassigned", "Nobody responsible")} />
                  <Tile label="Stale (14+ days)" value={d.risk.stale} icon={<Link2Off className="size-3.5 text-fg-muted" />} onClick={() => open("stale", "No activity for 14+ days")} />
                </div>
              </TipAnchor>
            </Card>

            <Card
              title="Review health"
              description={d.historySince ? `From the review log (kept since ${formatShortDate(d.historySince)}).` : "No reviews recorded yet."}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <Tile label="In review now" value={d.review.queue} sub={d.review.oldestWaitingHours !== null ? `oldest waiting ${hours(d.review.oldestWaitingHours)}` : undefined} icon={<Hourglass className="size-3.5 text-state-review" />} onClick={() => open("queue", "Waiting for review")} />
                <Tile label="Time to first review" value={duration(d.review.firstReview)} sub={durationSub(d.review.firstReview, "submissions")} />
                <Tile label="Submission to approval" value={duration(d.review.toApproval)} sub={durationSub(d.review.toApproval, "approvals")} />
                <Tile label="Changes requested" value={d.review.decisions ? `${pct(d.review.changesRequested, d.review.decisions)}%` : "—"} sub={`${d.review.changesRequested} of ${d.review.decisions} decisions`} />
                <Tile label="Approved after changes" value={d.review.approvals ? `${pct(d.review.approvalsAfterChanges, d.review.approvals)}%` : "—"} sub={`${d.review.approvalsAfterChanges} of ${d.review.approvals} approvals`} />
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Card title="Approved per week" description="Deliverables approved in each week of the period">
                <Throughput weeks={d.throughput} />
              </Card>
              <Card title="Cycle time" description="From a deliverable being added to its first approval, for those first approved in the period">
                <p className="text-[28px] font-semibold leading-none tracking-tight">{d.cycleTime.n ? hours(d.cycleTime.median) : "—"}</p>
                <p className="mt-2 text-[12px] text-fg-muted">{d.cycleTime.n ? `median · p75 ${hours(d.cycleTime.p75)} · ${d.cycleTime.n} deliverable${d.cycleTime.n === 1 ? "" : "s"}` : "Nothing was first approved in this period."}</p>
              </Card>
            </div>

            <Card title="Workload" description="Unapproved work per person (deliverables following the card count for its assignees)">
              {d.workload.length ? (
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-[13px]">
                    <thead>
                      <tr className="text-[11.5px] text-fg-subtle">
                        <th className="py-1.5 font-medium">Person</th>
                        <th className="py-1.5 text-right font-medium">Responsible</th>
                        <th className="py-1.5 text-right font-medium">Contributing</th>
                        <th className="py-1.5 text-right font-medium">Overdue</th>
                        <th className="py-1.5 text-right font-medium">Due in 7 days</th>
                        <th className="py-1.5 text-right font-medium">To review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.workload.map((w) => (
                        <tr key={w.userId} className="border-t border-border/70">
                          <td className="py-1">
                            <button type="button" onClick={() => open(`person:${w.userId}`, `${w.displayName}'s work`)} className="flex min-h-8 items-center gap-2 text-left hover:underline">
                              <UserAvatar user={{ displayName: w.displayName, avatarUrl: w.avatarUrl, avatarColor: w.avatarColor }} size="sm" />
                              {w.displayName}
                            </button>
                          </td>
                          <td className="py-1 text-right tabular-nums">{w.responsible}</td>
                          <td className="py-1 text-right tabular-nums">{w.contributing}</td>
                          <td className="py-1 text-right tabular-nums">
                            {w.overdue ? (
                              <span className="inline-flex items-center gap-1 font-semibold">
                                <CircleAlert className="size-3.5 text-danger" aria-label="overdue" />
                                {w.overdue}
                              </span>
                            ) : (
                              0
                            )}
                          </td>
                          <td className="py-1 text-right tabular-nums">{w.dueSoon}</td>
                          <td className="py-1 text-right tabular-nums">{w.reviewing}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[13px] text-fg-muted">Nobody has unapproved work here.</p>
              )}
            </Card>

            <Card title="Milestones" description="Required deliverables on each milestone's cards. Forecasts extend the last 4 weeks' approval rate — an estimate, not a promise.">
              {d.milestones.length ? (
                <ul className="grid gap-2">
                  {d.milestones.map((m) => {
                    const f = FORECAST[m.forecast];
                    return (
                      <li key={m.id}>
                        <button type="button" onClick={() => open(`milestone:${m.id}`, `${m.name}: remaining required work`)} className="grid w-full gap-1.5 rounded-lg border border-border p-3 text-left hover:border-border-strong">
                          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{m.name}</span>
                            <span className={cn("inline-flex items-center gap-1 text-[12px] font-medium [&_svg]:size-3.5", f.className)}>
                              {f.icon}
                              {f.label}
                            </span>
                          </span>
                          <Meter value={m.approved} of={m.required} label={`${m.name}: required work approved`} />
                          <span className="text-[11.5px] text-fg-muted">
                            {m.approved} of {m.required} required approved
                            {m.dueAt ? ` · due ${formatShortDate(m.dueAt)}` : ""}
                            {m.projectedAt && m.forecast !== "done" ? ` · at the current pace, done around ${formatShortDate(m.projectedAt)}` : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-muted">No milestones yet. Add them in project settings.</p>
              )}
            </Card>
            <p className="text-[11.5px] text-fg-subtle">Updated {new Date(d.generatedAt).toLocaleTimeString()}. Archived cards, columns, boards and deliverables are left out.</p>
          </div>
        )}
      </div>
      <Drilldown
        open={Boolean(drill)}
        title={drill?.title ?? ""}
        items={list.data}
        loading={list.isLoading}
        studioSlug={studioSlug}
        projectSlug={projectSlug}
        onClose={() => setDrill(null)}
        filename={`forge-${projectSlug}-${drill?.key.replace(/[^a-z0-9]+/gi, "-") ?? "list"}-${new Date().toISOString().slice(0, 10)}.csv`}
      />
    </div>
  );
}
