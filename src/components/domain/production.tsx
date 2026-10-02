"use client";

import { Box, CircleDashed, File as FileIcon, Film, Image as ImageIcon, type LucideIcon, Music, PackageCheck, Rocket } from "lucide-react";
import { CARD_STATE_META } from "@/lib/card-meta";
import { PRODUCTION_META } from "@/lib/deliverables";
import type { AttachmentKind, CardState, DeliverableProgressDTO, ProductionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Tooltip } from "../ui/menu";

export const PRODUCTION_ORDER: ProductionStatus[] = ["TODO", "COMPLETED", "PUBLISHED"];

export const PRODUCTION_ICONS: Record<ProductionStatus, LucideIcon> = {
  TODO: CircleDashed,
  COMPLETED: PackageCheck,
  PUBLISHED: Rocket,
};

export const PRODUCTION_COLOR: Record<ProductionStatus, string> = {
  TODO: "var(--fg-muted)",
  COMPLETED: "var(--stage-completed)",
  PUBLISHED: "var(--stage-published)",
};

export function ProductionPill({ status, size = "sm", className, pending }: { status: ProductionStatus; size?: "sm" | "md"; className?: string; pending?: boolean }) {
  const Icon = PRODUCTION_ICONS[status];
  return (
    <Tooltip content={pending ? `${PRODUCTION_META[status].description} A deliverable has changed since — see the card.` : PRODUCTION_META[status].description}>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md border font-semibold",
          size === "sm" ? "h-5 px-1.5 text-[10.5px] [&_svg]:size-3" : "h-6 px-2 text-[12px] [&_svg]:size-3.5",
          status === "TODO" ? "border-border-strong text-fg-muted" : "border-transparent",
          className,
        )}
        style={status === "TODO" ? undefined : { color: PRODUCTION_COLOR[status], backgroundColor: `color-mix(in srgb, ${PRODUCTION_COLOR[status]} 15%, transparent)` }}
      >
        <Icon aria-hidden />
        {PRODUCTION_META[status].label}
        {pending ? <span className="ml-0.5 size-1.5 rounded-full bg-state-review" aria-label="pending changes" /> : null}
      </span>
    </Tooltip>
  );
}

const SEGMENTS: Array<{ key: keyof DeliverableProgressDTO; state: CardState }> = [
  { key: "approved", state: "APPROVED" },
  { key: "inReview", state: "NEEDS_REVIEW" },
  { key: "changesRequested", state: "CHANGES_REQUESTED" },
  { key: "inProgress", state: "IN_PROGRESS" },
  { key: "notStarted", state: "NOT_SUBMITTED" },
];

/** One segment per deliverable state; "has files" and "approved" are reported separately in the label. */
export function DeliverableProgress({ progress, className, detailed }: { progress: DeliverableProgressDTO; className?: string; detailed?: boolean }) {
  if (progress.total === 0) return null;
  const parts = SEGMENTS.map((s) => ({ ...s, n: progress[s.key] as number })).filter((s) => s.n > 0);
  const summary = [
    `${progress.approvedRequired}/${progress.required} required approved`,
    progress.inReview ? `${progress.inReview} in review` : null,
    progress.changesRequested ? `${progress.changesRequested} with changes requested` : null,
    `${progress.withFiles}/${progress.total} have files`,
    progress.blocked ? `${progress.blocked} blocked` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={cn("grid gap-1", className)}>
      <Tooltip content={summary}>
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-4" role="img" aria-label={summary}>
          {parts.map((p) => (
            <span key={p.key} style={{ width: `${(p.n / progress.total) * 100}%`, backgroundColor: CARD_STATE_META[p.state].color }} />
          ))}
        </div>
      </Tooltip>
      {detailed ? (
        <p className="flex flex-wrap gap-x-2 text-[11px] text-fg-muted">
          <span className="font-semibold text-state-approved">
            {progress.approvedRequired}/{progress.required} approved
          </span>
          {progress.inReview ? <span className="text-state-review">{progress.inReview} in review</span> : null}
          {progress.changesRequested ? <span className="text-state-changes">{progress.changesRequested} changes</span> : null}
          <span>{progress.withFiles}/{progress.total} with files</span>
          {progress.blocked ? <span className="text-fg-subtle">{progress.blocked} blocked</span> : null}
        </p>
      ) : null}
    </div>
  );
}

export const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
  IMAGE: ImageIcon,
  VIDEO: Film,
  AUDIO: Music,
  ROBLOX: Box,
  FILE: FileIcon,
};

export const KIND_LABELS: Record<AttachmentKind, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  AUDIO: "Audio",
  ROBLOX: "Roblox file",
  FILE: "File",
};
