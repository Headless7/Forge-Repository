"use client";

import { ChevronDown, ChevronsUp, ChevronUp, CircleAlert, CircleCheck, CircleDot, Eye, Flame, XCircle, type LucideIcon } from "lucide-react";
import { ITEM_PRIORITY_META, ITEM_RESOLUTION_META, ITEM_STATUS_STYLE, priorityLabel, statusLabel } from "@/lib/forum-meta";
import type { ForumKind, ItemPriority, ItemResolution, ItemStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const ITEM_STATUS_ICONS: Record<ItemStatus, LucideIcon> = {
  OPEN: CircleAlert,
  IN_PROGRESS: CircleDot,
  FIXED: Eye,
  VERIFIED: CircleCheck,
  CLOSED: XCircle,
};

/** An item's status, always icon + text with its own hue; the wording follows the forum's kind. */
export function ItemStatusPill({
  kind,
  status,
  resolution,
  size = "md",
  short,
  className,
}: {
  kind: ForumKind;
  status: ItemStatus;
  /** Shown beside "Closed". */
  resolution?: ItemResolution | null;
  size?: "sm" | "md" | "lg";
  /** The one-word form ("Fixed" rather than "Fixed · to verify"). */
  short?: boolean;
  className?: string;
}) {
  const style = ITEM_STATUS_STYLE[status];
  const wording = statusLabel(kind, status);
  const Icon = ITEM_STATUS_ICONS[status];
  const sizes = {
    sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-3",
    md: "h-6 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
    lg: "h-8 gap-2 px-3 text-[13px] [&_svg]:size-4",
  };
  const extra = status === "CLOSED" && resolution ? ITEM_RESOLUTION_META[resolution].label : null;
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-semibold tracking-tight", sizes[size], style.bg, style.text, className)} title={wording.description}>
      <Icon strokeWidth={2.4} aria-hidden />
      <span>{short ? wording.short : wording.label}</span>
      {extra && !short ? <span className="font-medium opacity-80">· {extra}</span> : null}
    </span>
  );
}

const PRIORITY_ICONS: Record<ItemPriority, LucideIcon> = {
  GAME_BREAKING: Flame,
  HIGH: ChevronsUp,
  MEDIUM: ChevronUp,
  LOW: ChevronDown,
};

export function ItemPriorityIcon({ kind, priority, withLabel, className }: { kind: ForumKind; priority: ItemPriority; withLabel?: boolean; className?: string }) {
  const Icon = PRIORITY_ICONS[priority];
  const meta = ITEM_PRIORITY_META[priority];
  const label = priorityLabel(kind, priority);
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", meta.className, className)} title={`${label} priority`}>
      <Icon className="size-3.5" aria-hidden strokeWidth={2.4} />
      {withLabel ? <span className="text-fg">{label}</span> : <span className="sr-only">{label} priority</span>}
    </span>
  );
}
