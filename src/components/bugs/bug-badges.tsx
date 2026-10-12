"use client";

import { ChevronDown, ChevronsUp, ChevronUp, CircleAlert, CircleCheck, CircleDot, Eye, Flame, XCircle, type LucideIcon } from "lucide-react";
import { BUG_PRIORITY_META, BUG_RESOLUTION_META, BUG_STATUS_META } from "@/lib/bug-meta";
import type { BugPriority, BugResolution, BugStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const BUG_STATUS_ICONS: Record<BugStatus, LucideIcon> = {
  OPEN: CircleAlert,
  IN_PROGRESS: CircleDot,
  FIXED: Eye,
  VERIFIED: CircleCheck,
  CLOSED: XCircle,
};

/** A bug's status, always icon + text with its own hue (like a card's review state). */
export function BugStatusPill({
  status,
  resolution,
  size = "md",
  short,
  className,
}: {
  status: BugStatus;
  /** Shown beside "Closed". */
  resolution?: BugResolution | null;
  size?: "sm" | "md" | "lg";
  /** The one-word form ("Fixed" rather than "Fixed · to verify"). */
  short?: boolean;
  className?: string;
}) {
  const meta = BUG_STATUS_META[status];
  const Icon = BUG_STATUS_ICONS[status];
  const sizes = {
    sm: "h-5 gap-1 px-1.5 text-[11px] [&_svg]:size-3",
    md: "h-6 gap-1.5 px-2 text-xs [&_svg]:size-3.5",
    lg: "h-8 gap-2 px-3 text-[13px] [&_svg]:size-4",
  };
  const extra = status === "CLOSED" && resolution ? BUG_RESOLUTION_META[resolution].label : null;
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-md font-semibold tracking-tight", sizes[size], meta.bg, meta.text, className)} title={meta.description}>
      <Icon strokeWidth={2.4} aria-hidden />
      <span>{short ? meta.short : meta.label}</span>
      {extra && !short ? <span className="font-medium opacity-80">· {extra}</span> : null}
    </span>
  );
}

const PRIORITY_ICONS: Record<BugPriority, LucideIcon> = {
  GAME_BREAKING: Flame,
  HIGH: ChevronsUp,
  MEDIUM: ChevronUp,
  LOW: ChevronDown,
};

export function BugPriorityIcon({ priority, withLabel, className }: { priority: BugPriority; withLabel?: boolean; className?: string }) {
  const Icon = PRIORITY_ICONS[priority];
  const meta = BUG_PRIORITY_META[priority];
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", meta.className, className)} title={`${meta.label} priority`}>
      <Icon className="size-3.5" aria-hidden strokeWidth={2.4} />
      {withLabel ? <span className="text-fg">{meta.label}</span> : <span className="sr-only">{meta.label} priority</span>}
    </span>
  );
}
