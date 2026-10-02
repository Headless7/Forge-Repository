import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Eye,
  Flame,
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  CalendarDays,
  type LucideIcon,
} from "lucide-react";
import { CARD_STATE_META, PRIORITY_META } from "@/lib/card-meta";
import type { CardState, LabelDTO, Priority } from "@/lib/types";
import { cn, dueStatus, formatShortDate } from "@/lib/utils";

export const STATE_ICONS: Record<CardState, LucideIcon> = {
  NOT_SUBMITTED: CircleDashed,
  IN_PROGRESS: CircleDot,
  NEEDS_REVIEW: Eye,
  CHANGES_REQUESTED: CircleAlert,
  APPROVED: CircleCheck,
};

/**
 * The review state is the most important signal on every card, so it is always
 * rendered as icon + text (never colour alone) with a dedicated hue per state.
 */
export function StatePill({
  state,
  size = "md",
  variant = "soft",
  extra,
  className,
}: {
  state: CardState;
  size?: "sm" | "md" | "lg";
  variant?: "soft" | "solid";
  extra?: string | null;
  className?: string;
}) {
  const meta = CARD_STATE_META[state];
  const Icon = STATE_ICONS[state];
  const sizes = {
    sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-3",
    md: "h-6 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
    lg: "h-8 gap-2 px-3 text-[13px] [&_svg]:size-4",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-semibold tracking-tight transition-colors duration-200",
        sizes[size],
        variant === "soft" ? [meta.bg, meta.text] : "text-white shadow-sm",
        className,
      )}
      style={variant === "solid" ? { backgroundColor: meta.color } : undefined}
    >
      <Icon strokeWidth={2.4} aria-hidden />
      <span>{meta.label}</span>
      {extra ? <span className={cn("font-medium", variant === "soft" ? "opacity-80" : "opacity-90")}>· {extra}</span> : null}
    </span>
  );
}

export function StateDot({ state, className }: { state: CardState; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: CARD_STATE_META[state].color }} />;
}

const PRIORITY_ICONS: Record<Priority, LucideIcon> = {
  URGENT: Flame,
  HIGH: ChevronsUp,
  NORMAL: ChevronUp,
  LOW: ChevronDown,
};

export function PriorityIcon({ priority, withLabel, className }: { priority: Priority; withLabel?: boolean; className?: string }) {
  const Icon = PRIORITY_ICONS[priority];
  const meta = PRIORITY_META[priority];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", meta.className, className)} title={`${meta.label} priority`}>
      <Icon className="size-3.5" aria-hidden strokeWidth={2.4} />
      {withLabel ? <span className="text-fg">{meta.label}</span> : <span className="sr-only">{meta.label} priority</span>}
    </span>
  );
}

export function DueChip({ dueAt, done, className }: { dueAt: string | null; done?: boolean; className?: string }) {
  if (!dueAt) return null;
  const status = dueStatus(dueAt, done);
  const styles = {
    overdue: "text-state-changes",
    today: "text-state-review",
    soon: "text-state-review/90",
    upcoming: "text-fg-subtle",
  } as const;
  const label = status === "overdue" ? "Overdue" : status === "today" ? "Due today" : null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", styles[status ?? "upcoming"], className)} title={`Due ${new Date(dueAt).toLocaleString()}`}>
      <CalendarDays className="size-3" aria-hidden />
      {label ?? formatShortDate(dueAt)}
    </span>
  );
}

export function LabelChip({ label, className }: { label: LabelDTO; className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[18px] max-w-32 items-center gap-1 truncate rounded px-1.5 text-[10.5px] font-semibold", className)}
      style={{ backgroundColor: `color-mix(in oklab, ${label.color} 22%, transparent)`, color: `color-mix(in oklab, ${label.color} 85%, var(--fg))` }}
    >
      {label.name}
    </span>
  );
}
