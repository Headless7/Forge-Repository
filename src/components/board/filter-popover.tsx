"use client";

import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { CARD_STATE_META, CARD_STATE_ORDER, PRIORITY_META, PRIORITY_ORDER } from "@/lib/card-meta";
import type { BoardDTO, CardState, Priority } from "@/lib/types";
import { PRODUCTION_META } from "@/lib/deliverables";
import { cn } from "@/lib/utils";
import { ColumnIcon } from "../domain/column-icon";
import { PRODUCTION_COLOR, PRODUCTION_ICONS, PRODUCTION_ORDER } from "../domain/production";
import { UserAvatar } from "../domain/avatar";
import { LabelChip, PriorityIcon, STATE_ICONS } from "../domain/state";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { activeFilterCount, EMPTY_FILTERS, type BoardFilters, type DueFilter, type MediaFilter } from "./filters";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-2.5 last:border-b-0">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}

function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1 text-[13px] hover:bg-surface-3">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {children}
    </label>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Segmented<V extends string>({ value, options, onChange }: { value: V | null; options: Array<[V | null, string]>; onChange: (v: V | null) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([v, label]) => (
        <button
          key={label}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={cn("h-7 rounded-md border px-2 text-[12px]", value === v ? "border-accent bg-accent-soft text-fg" : "border-border-strong text-fg-muted hover:bg-surface-3")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function FilterPopover({
  board,
  filters,
  onChange,
  open,
  onOpenChange,
}: {
  board: BoardDTO;
  filters: BoardFilters;
  onChange: (f: BoardFilters) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const count = activeFilterCount(filters);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={count ? "outline" : "ghost"} className={cn(count && "border-accent/60 text-fg")}>
          <ListFilter /> Filters
          {count ? <span className="rounded-full bg-accent px-1.5 text-[10.5px] font-semibold leading-4 text-accent-fg">{count}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(560px,calc(100vw-24px))] p-0">
        <div className="grid sm:grid-cols-2">
          <div className="border-border sm:border-r">
            <Section title="People">
              <CheckRow checked={filters.mine} onChange={(v) => onChange({ ...filters, mine: v })}>
                Assigned to me
              </CheckRow>
              <div className="scrollbar-thin max-h-40 overflow-y-auto">
                {board.members.map((m) => (
                  <CheckRow key={m.id} checked={filters.assignees.includes(m.id)} onChange={() => onChange({ ...filters, assignees: toggle(filters.assignees, m.id) })}>
                    <UserAvatar user={m} size="xs" online={m.online} />
                    <span className="truncate">{m.displayName}</span>
                  </CheckRow>
                ))}
              </div>
            </Section>
            <Section title="Review status">
              {CARD_STATE_ORDER.map((state: CardState) => {
                const Icon = STATE_ICONS[state];
                return (
                  <CheckRow key={state} checked={filters.states.includes(state)} onChange={() => onChange({ ...filters, states: toggle(filters.states, state) })}>
                    <Icon className="size-3.5" style={{ color: CARD_STATE_META[state].color }} />
                    {CARD_STATE_META[state].label}
                  </CheckRow>
                );
              })}
            </Section>
          </div>
          <div>
            <Section title="Category">
              <div className="scrollbar-thin max-h-36 overflow-y-auto">
                {[...board.columns]
                  .sort((a, b) => a.position - b.position)
                  .map((c) => (
                    <CheckRow key={c.id} checked={filters.categories.includes(c.id)} onChange={() => onChange({ ...filters, categories: toggle(filters.categories, c.id) })}>
                      <ColumnIcon name={c.icon} color={c.color} className="size-3.5" />
                      <span className="truncate">{c.name}</span>
                    </CheckRow>
                  ))}
              </div>
            </Section>
            <Section title="Production stage">
              <div className="flex flex-wrap gap-1">
                {PRODUCTION_ORDER.map((s) => {
                  const Icon = PRODUCTION_ICONS[s];
                  const on = filters.stages.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onChange({ ...filters, stages: toggle(filters.stages, s) })}
                      className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px]", on ? "border-accent bg-accent-soft text-fg" : "border-border-strong text-fg-muted hover:bg-surface-3")}
                    >
                      <Icon className="size-3.5" style={{ color: PRODUCTION_COLOR[s] }} /> {PRODUCTION_META[s].label}
                    </button>
                  );
                })}
              </div>
            </Section>
            <Section title="Priority">
              <div className="grid grid-cols-2">
                {PRIORITY_ORDER.map((p: Priority) => (
                  <CheckRow key={p} checked={filters.priorities.includes(p)} onChange={() => onChange({ ...filters, priorities: toggle(filters.priorities, p) })}>
                    <PriorityIcon priority={p} /> {PRIORITY_META[p].label}
                  </CheckRow>
                ))}
              </div>
            </Section>
            {board.labels.length ? (
              <Section title="Labels">
                <div className="flex flex-wrap gap-1.5">
                  {board.labels.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      aria-pressed={filters.labels.includes(l.id)}
                      onClick={() => onChange({ ...filters, labels: toggle(filters.labels, l.id) })}
                      className={cn("rounded-md p-0.5", filters.labels.includes(l.id) ? "ring-2 ring-accent" : "opacity-70 hover:opacity-100")}
                    >
                      <LabelChip label={l} />
                    </button>
                  ))}
                </div>
              </Section>
            ) : null}
            <Section title="Due date">
              <Segmented<DueFilter>
                value={filters.due}
                onChange={(due) => onChange({ ...filters, due })}
                options={[
                  [null, "Any"],
                  ["overdue", "Overdue"],
                  ["today", "Due today"],
                  ["week", "Next 7 days"],
                  ["none", "No date"],
                ]}
              />
            </Section>
            <Section title="Media & activity">
              <Segmented<MediaFilter>
                value={filters.media}
                onChange={(media) => onChange({ ...filters, media })}
                options={[
                  [null, "Any"],
                  ["video", "Video"],
                  ["image", "Image"],
                  ["audio", "Audio"],
                  ["roblox", "Roblox file"],
                ]}
              />
              <div className="mt-2">
                <CheckRow checked={filters.unread} onChange={(v) => onChange({ ...filters, unread: v })}>
                  Has unread activity
                </CheckRow>
              </div>
            </Section>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <span className="text-xs text-fg-subtle">{count ? `${count} filter${count === 1 ? "" : "s"} active` : "No filters"}</span>
          <Button size="xs" variant="ghost" disabled={!count} onClick={() => onChange({ ...EMPTY_FILTERS, q: filters.q, milestone: filters.milestone })}>
            Reset filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
