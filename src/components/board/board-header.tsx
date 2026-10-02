"use client";

import {
  Activity,
  Archive,
  ChevronDown,
  CircleAlert,
  Columns3,
  CircleCheck,
  Eye,
  Flag,
  Plus,
  Search,
  Settings,
  UserRound,
  Users,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ROLE_LABELS } from "@/lib/permissions";
import type { BoardDTO, BoardView, CardState } from "@/lib/types";
import { cn, formatShortDate } from "@/lib/utils";
import { useRealtimeStatus } from "../realtime";
import { AvatarStack, UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "../ui/menu";
import { FilterPopover } from "./filter-popover";
import type { BoardFilters } from "./filters";

function Toggle({
  active,
  onClick,
  icon,
  label,
  count,
  tone,
  shortcut,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
  tone?: string;
  shortcut?: string;
}) {
  return (
    <Tooltip content={active ? `${label} — click to clear` : label} shortcut={shortcut}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        aria-label={label}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12.5px] font-medium transition-colors [&_svg]:size-3.5",
          active ? "border-transparent bg-surface-4 text-fg shadow-sm" : "border-transparent text-fg-muted hover:bg-surface-3 hover:text-fg",
        )}
      >
        {icon}
        <span className="hidden @min-[1500px]:inline">{label}</span>
        {count !== undefined && count > 0 ? (
          <span className={cn("rounded px-1 text-[10.5px] font-semibold tabular-nums", tone ?? "bg-surface-4 text-fg-muted")}>{count}</span>
        ) : null}
      </button>
    </Tooltip>
  );
}

function MembersPopover({ board, studioSlug }: { board: BoardDTO; studioSlug: string }) {
  const online = board.members.filter((m) => m.online);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-7 items-center rounded-md px-1.5 hover:bg-surface-3" aria-label={`Project members (${online.length} online)`}>
          <AvatarStack users={board.members} max={4} size="sm" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">
            Members · {board.members.length}
            {online.length ? <span className="ml-1.5 font-normal text-state-approved">{online.length} online</span> : null}
          </span>
          <Link href={`/${studioSlug}/${board.project.slug}/settings#members`} className="text-xs text-accent hover:underline">
            Manage
          </Link>
        </div>
        <ul className="scrollbar-thin max-h-80 overflow-y-auto p-1">
          {board.members.map((m) => (
            <li key={m.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <UserAvatar user={m} size="md" online={m.online} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{m.displayName}</p>
                <p className="truncate text-[11px] text-fg-subtle">
                  @{m.username}
                  {m.title ? ` · ${m.title}` : ""}
                </p>
              </div>
              <span className="text-[11px] text-fg-muted">{ROLE_LABELS[m.role]}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function AddCardPopover({ board, onCreate, disabled }: { board: BoardDTO; onCreate: (columnId: string, title: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [columnId, setColumnId] = useState<string | undefined>(board.columns[0]?.id);
  const target = columnId && board.columns.some((c) => c.id === columnId) ? columnId : board.columns[0]?.id;
  const submit = () => {
    if (!title.trim() || !target) return;
    onCreate(target, title.trim());
    setTitle("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="primary" disabled={disabled || board.columns.length === 0}>
          <Plus /> <span className="hidden sm:inline">Add card</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 text-[13px] font-semibold">New card</p>
        <input
          autoFocus
          value={title}
          maxLength={200}
          placeholder="What needs to be made?"
          aria-label="Card title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="h-8 w-full rounded-md border border-border-strong bg-surface-3 px-2 text-[13px] outline-none focus:border-accent"
        />
        <div className="mt-2">
          <Select
            aria-label="Category"
            value={target}
            onValueChange={setColumnId}
            options={board.columns.map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="primary" onClick={submit} disabled={!title.trim()}>
            Create & open
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Category columns vs production stages — the same cards, grouped differently. */
function ViewSwitch({ view, onChange }: { view: BoardView; onChange: (view: BoardView) => void }) {
  const options: Array<{ value: BoardView; label: string; icon: ReactNode; hint: string }> = [
    { value: "CATEGORY", label: "Categories", icon: <Columns3 />, hint: "Group cards by category (VFX, Animations, UI …)" },
    { value: "PRODUCTION", label: "Production", icon: <Workflow />, hint: "Group cards by production stage: To-do, Completed, Published" },
  ];
  return (
    <div role="radiogroup" aria-label="Board view" className="flex h-7 shrink-0 items-center rounded-md border border-border-strong bg-surface-3/60 p-0.5">
      {options.map((o) => (
        <Tooltip key={o.value} content={o.hint} shortcut="V">
          <button
            type="button"
            role="radio"
            aria-checked={view === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded px-2 text-[12.5px] font-medium transition-colors [&_svg]:size-3.5",
              view === o.value ? "bg-surface-4 text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {o.icon}
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function BoardHeader({
  board,
  studioSlug,
  filters,
  onFiltersChange,
  stateCounts,
  mineCount,
  onCreateCard,
  onOpenArchived,
  filtersOpen,
  onFiltersOpenChange,
  view,
  onViewChange,
}: {
  board: BoardDTO;
  studioSlug: string;
  filters: BoardFilters;
  onFiltersChange: (f: BoardFilters) => void;
  stateCounts: Record<CardState, number>;
  mineCount: number;
  onCreateCard: (columnId: string, title: string) => void;
  onOpenArchived: () => void;
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  view: BoardView;
  onViewChange: (view: BoardView) => void;
}) {
  const status = useRealtimeStatus();
  const project = board.project;
  const milestones = board.milestones.filter((m) => !m.archived);
  const activeMilestone = milestones.find((m) => m.id === filters.milestone);
  const toggleState = (state: CardState) =>
    onFiltersChange({ ...filters, states: filters.states.includes(state) ? filters.states.filter((s) => s !== state) : [...filters.states, state] });
  const canCreate = board.viewer.permissions.includes("card.create") && !project.archived;

  return (
    <header className="@container flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface/80 px-3 py-2 backdrop-blur md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-xl leading-none" aria-hidden>
          {project.icon}
        </span>
        <h1 className="hidden truncate text-[15px] font-semibold tracking-tight md:block">{project.name}</h1>
        {project.archived ? <span className="rounded bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">Archived</span> : null}
        <ViewSwitch view={view} onChange={onViewChange} />
        {milestones.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 max-w-[46vw] items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[12.5px] font-medium md:max-w-none",
                  activeMilestone ? "border-accent/50 bg-accent-soft text-fg" : "border-border-strong text-fg-muted hover:text-fg",
                )}
              >
                <Flag className="size-3.5" />
                {activeMilestone?.name ?? (filters.milestone === "none" ? "No milestone" : "All milestones")}
                <ChevronDown className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuLabel>Milestone / update</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={filters.milestone ?? "all"} onValueChange={(v) => onFiltersChange({ ...filters, milestone: v === "all" ? null : v })}>
                <DropdownMenuRadioItem value="all">All milestones</DropdownMenuRadioItem>
                {milestones.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id}>
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.releasedAt ? <span className="text-[10.5px] text-state-approved">Released</span> : m.dueAt ? <span className="text-[10.5px] text-fg-subtle">{formatShortDate(m.dueAt)}</span> : null}
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem value="none">No milestone</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Tooltip content={status === "live" ? "Live — changes appear instantly" : status === "connecting" ? "Connecting…" : "Offline — reconnecting"}>
          <span className={cn("size-2 shrink-0 rounded-full", status === "live" ? "bg-state-approved" : status === "connecting" ? "bg-warning animate-pulse" : "bg-danger")} aria-label={`Realtime ${status}`} />
        </Tooltip>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <div className="relative hidden w-40 @min-[1100px]:block @min-[1500px]:w-52">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            value={filters.q}
            onChange={(e) => onFiltersChange({ ...filters, q: e.target.value })}
            placeholder="Filter cards…"
            aria-label="Filter cards on this board"
            className="h-7 w-full rounded-md border border-border-strong/70 bg-surface-3/60 pl-7 pr-6 text-[12.5px] outline-none focus:border-accent"
          />
          {filters.q ? (
            <button type="button" aria-label="Clear filter" onClick={() => onFiltersChange({ ...filters, q: "" })} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg">
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="scrollbar-none flex min-w-0 items-center gap-0.5 overflow-x-auto">
          <Toggle active={filters.mine} onClick={() => onFiltersChange({ ...filters, mine: !filters.mine })} count={mineCount} shortcut="M" icon={<UserRound />} label="My tasks" />
          <Toggle
            active={filters.states.includes("NEEDS_REVIEW")}
            onClick={() => toggleState("NEEDS_REVIEW")}
            count={stateCounts.NEEDS_REVIEW}
            tone="bg-state-review/20 text-state-review"
            shortcut="R"
            icon={<Eye className="text-state-review" />}
            label="Needs review"
          />
          <Toggle
            active={filters.states.includes("CHANGES_REQUESTED")}
            onClick={() => toggleState("CHANGES_REQUESTED")}
            count={stateCounts.CHANGES_REQUESTED}
            tone="bg-state-changes/20 text-state-changes"
            icon={<CircleAlert className="text-state-changes" />}
            label="Changes requested"
          />
          <Toggle
            active={filters.states.includes("APPROVED")}
            onClick={() => toggleState("APPROVED")}
            count={stateCounts.APPROVED}
            tone="bg-state-approved/20 text-state-approved"
            icon={<CircleCheck className="text-state-approved" />}
            label="Approved"
          />
        </div>
        <FilterPopover board={board} filters={filters} onChange={onFiltersChange} open={filtersOpen} onOpenChange={onFiltersOpenChange} />
        <span className="mx-0.5 hidden h-5 w-px bg-border md:block" />
        <div className="hidden md:block">
          <MembersPopover board={board} studioSlug={studioSlug} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Board settings">
              <Settings />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem asChild>
              <Link href={`/${studioSlug}/${project.slug}/settings`}>
                <Settings /> Board settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/${studioSlug}/${project.slug}/activity`}>
                <Activity /> Project activity
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenArchived}>
              <Archive /> Archived items
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={`/${studioSlug}/members`}>
                <Users /> Studio members
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AddCardPopover board={board} onCreate={onCreateCard} disabled={!canCreate} />
      </div>
    </header>
  );
}
