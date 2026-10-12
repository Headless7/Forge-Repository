"use client";

import { Check, Search, UserRound } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { getRecentPeople, rememberPerson } from "@/lib/recent-people";
import type { MemberDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./avatar";
import { Checkbox } from "../ui/controls";
import { DiscordHandle } from "./discord-icon";
import { MemberPopover } from "./member-popover";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";

/** Name, title, username or Discord handle contains the query. */
export function matchesPerson(m: MemberDTO, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [m.displayName, m.title, m.username, m.discord?.username, m.discord?.displayName].some((v) => v?.toLowerCase().includes(q));
}

/** The search box every people list starts with. Opening it focuses the box — except on touch screens, where that would throw up the keyboard. */
export function PeopleSearch({ value, onChange, onEnter, placeholder = "Search people…", className, autoFocus = true }: { value: string; onChange: (value: string) => void; onEnter?: () => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus && typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full rounded-md border border-border-strong bg-surface-3 pl-7 pr-2 text-[13px] outline-none focus:border-accent"
      />
    </div>
  );
}

/**
 * The body of a people picker: a search box and the matching people, each with a check (single
 * choice) or a checkbox (several). Callers own the Popover and its trigger.
 */
export function PeopleMenu({
  people,
  selectedIds,
  onToggle,
  single,
  nobody,
  canToggle,
  label,
  hint,
  emptyText = "No one matches.",
  recentKey,
}: {
  people: MemberDTO[];
  selectedIds: readonly string[];
  onToggle: (userId: string, selected: boolean) => void;
  /** One person at a time: picking shows a check mark rather than checkboxes. */
  single?: boolean;
  /** A "Nobody" row (single choice): what the empty choice is called, and whether it's current. */
  nobody?: { label: string; selected: boolean; onSelect: () => void };
  /** Rows the viewer may not change show dimmed. */
  canToggle?: (m: MemberDTO) => boolean;
  /** Heading inside the menu ("Assignees"). */
  label?: string;
  /** A line under the heading explaining the choice. */
  hint?: ReactNode;
  emptyText?: string;
  /** Where picks are remembered (lib/recent-people): the people picked last show first while nothing is typed. */
  recentKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState(() => getRecentPeople(recentKey));
  const shown = useMemo(() => people.filter((m) => matchesPerson(m, query)), [people, query]);
  const q = query.trim().toLowerCase();
  const recent = !q ? recentIds.map((id) => people.find((m) => m.id === id)).filter((m): m is MemberDTO => Boolean(m)) : [];
  const rest = recent.length ? shown.filter((m) => !recent.includes(m)) : shown;
  const pick = (userId: string, selected: boolean) => {
    if (selected && recentKey) {
      rememberPerson(recentKey, userId);
      setRecentIds(getRecentPeople(recentKey));
    }
    onToggle(userId, selected);
  };
  const showNobody = nobody && (!q || nobody.label.toLowerCase().includes(q));
  const enter = () => {
    const first = shown[0];
    if (!q || !first || (canToggle && !canToggle(first))) return;
    pick(first.id, !selectedIds.includes(first.id));
  };
  const renderRow = (m: MemberDTO) => {
    const on = selectedIds.includes(m.id);
    const allowed = canToggle ? canToggle(m) : true;
    const row = (
      <>
        {!single ? <Checkbox checked={on} disabled={!allowed} aria-label={m.displayName} onCheckedChange={() => allowed && pick(m.id, !on)} /> : null}
        <UserAvatar user={m} size="xs" online={m.online} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{m.displayName}</span>
          {m.title ? <span className="block truncate text-[11px] text-fg-subtle">{m.title}</span> : null}
          {m.discord ? <DiscordHandle username={m.discord.username} className="text-[11px]" /> : null}
        </span>
        {single && on ? <Check className="size-4 text-accent" aria-label="Selected" /> : null}
      </>
    );
    return (
      <li key={m.id}>
        {single ? (
          <button type="button" disabled={!allowed} onClick={() => pick(m.id, !on)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", allowed ? "hover:bg-surface-4" : "opacity-50")}>
            {row}
          </button>
        ) : (
          <label className={cn("flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]", allowed ? "cursor-pointer hover:bg-surface-4" : "opacity-50")}>{row}</label>
        )}
      </li>
    );
  };
  return (
    <div className="flex min-h-0 flex-col gap-1">
      {label ? <p className="px-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</p> : null}
      {hint ? <p className="px-1 pb-1 text-[11px] text-fg-subtle">{hint}</p> : null}
      <PeopleSearch value={query} onChange={setQuery} onEnter={enter} className="mb-1" />
      <ul className="scrollbar-thin max-h-64 overflow-y-auto overscroll-contain" aria-label="People">
        {showNobody ? (
          <li>
            <button type="button" onClick={nobody.onSelect} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-4">
              <UserRound className="size-5 text-fg-subtle" aria-hidden />
              <span className="flex-1">{nobody.label}</span>
              {nobody.selected ? <Check className="size-4 text-accent" aria-label="Selected" /> : null}
            </button>
          </li>
        ) : null}
        {recent.length ? (
          <>
            <li className="px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle" aria-hidden>
              Recent
            </li>
            {recent.map(renderRow)}
            {rest.length ? (
              <li className="px-2 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle" aria-hidden>
                Everyone else
              </li>
            ) : null}
          </>
        ) : null}
        {rest.map(renderRow)}
        {q && !shown.length && !showNobody ? <li className="px-2 py-1.5 text-[12.5px] text-fg-muted">{emptyText}</li> : null}
      </ul>
    </div>
  );
}

/** One person (an assignee, a reviewer): a trigger plus the searchable menu, or just the person when read-only. */
export function PersonPicker({
  value,
  members,
  canEdit,
  onChange,
  emptyLabel = "Nobody",
  label,
  filter,
  className,
  variant = "inline",
  disabled,
  recentKey,
}: {
  value: string | null;
  members: MemberDTO[];
  canEdit: boolean;
  onChange: (userId: string | null) => void;
  emptyLabel?: string;
  /** Heading inside the menu ("Assignee"). */
  label: string;
  filter?: (m: MemberDTO) => boolean;
  className?: string;
  /** "inline": a text row that highlights on hover (sidebars). "field": a bordered control like a select (forms). */
  variant?: "inline" | "field";
  disabled?: boolean;
  /** Where picks are remembered, so the people picked last show first (lib/recent-people). */
  recentKey?: string;
}) {
  const person = value ? (members.find((m) => m.id === value) ?? null) : null;
  const summary = value ? (
    <span className="flex min-w-0 items-center gap-2">
      {person ? <UserAvatar user={person} size="xs" online={person.online} /> : <UserRound className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
      <span className="truncate">{person?.displayName ?? "Former member"}</span>
    </span>
  ) : (
    <span className="truncate text-fg-subtle">{emptyLabel}</span>
  );
  const fieldClass = "flex h-7 w-full min-w-0 items-center rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-left text-[12.5px] hover:border-border-strong disabled:opacity-60";

  if (!canEdit) {
    if (variant === "field") return <span className={cn(fieldClass, "opacity-60", className)}>{summary}</span>;
    return person ? (
      <MemberPopover user={person} member={person} className={cn("touch-target max-w-full gap-2", className)}>
        <UserAvatar user={person} size="xs" online={person.online} />
        <span className="truncate">{person.displayName}</span>
      </MemberPopover>
    ) : (
      <span className={className}>{summary}</span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${label}: ${person?.displayName ?? emptyLabel}`}
          className={cn(variant === "field" ? fieldClass : "-mx-1.5 w-[calc(100%+12px)] rounded-md px-1.5 py-1 text-left hover:bg-surface-3", className)}
        >
          {summary}
        </button>
      </PopoverTrigger>
      <PopoverContent className="flex max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-16px)] flex-col overflow-y-auto p-2" onOpenAutoFocus={(e) => window.matchMedia("(pointer: coarse)").matches && e.preventDefault()}>
        <PeopleMenu
          people={members.filter((m) => (filter ? filter(m) : true))}
          selectedIds={value ? [value] : []}
          single
          label={label}
          nobody={{ label: emptyLabel, selected: !value, onSelect: () => value !== null && onChange(null) }}
          onToggle={(id, on) => on && id !== value && onChange(id)}
          recentKey={recentKey}
        />
      </PopoverContent>
    </Popover>
  );
}
