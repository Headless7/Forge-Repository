import type { CardDisplayMode, CardState, ColumnDTO, Priority, ProjectDTO, VersionStatus } from "./types";

export const CARD_STATE_ORDER: CardState[] = ["NOT_SUBMITTED", "IN_PROGRESS", "NEEDS_REVIEW", "CHANGES_REQUESTED", "APPROVED"];

export const CARD_STATE_META: Record<
  CardState,
  { label: string; short: string; description: string; color: string; text: string; bg: string; border: string }
> = {
  NOT_SUBMITTED: {
    label: "Not submitted",
    short: "Not started",
    description: "Work hasn't been submitted yet.",
    color: "var(--state-draft)",
    text: "text-state-draft",
    bg: "bg-state-draft/15",
    border: "border-state-draft",
  },
  IN_PROGRESS: {
    label: "In progress",
    short: "In progress",
    description: "Someone is actively working on this.",
    color: "var(--state-progress)",
    text: "text-state-progress",
    bg: "bg-state-progress/15",
    border: "border-state-progress",
  },
  NEEDS_REVIEW: {
    label: "Needs review",
    short: "Review",
    description: "Submitted and waiting for a reviewer.",
    color: "var(--state-review)",
    text: "text-state-review",
    bg: "bg-state-review/15",
    border: "border-state-review",
  },
  CHANGES_REQUESTED: {
    label: "Changes requested",
    short: "Changes",
    description: "A reviewer asked for changes.",
    color: "var(--state-changes)",
    text: "text-state-changes",
    bg: "bg-state-changes/15",
    border: "border-state-changes",
  },
  APPROVED: {
    label: "Approved",
    short: "Approved",
    description: "Reviewed and approved.",
    color: "var(--state-approved)",
    text: "text-state-approved",
    bg: "bg-state-approved/15",
    border: "border-state-approved",
  },
};

export const VERSION_STATUS_META: Record<VersionStatus, { label: string; state: CardState }> = {
  DRAFT: { label: "Draft", state: "IN_PROGRESS" },
  IN_REVIEW: { label: "In review", state: "NEEDS_REVIEW" },
  CHANGES_REQUESTED: { label: "Changes requested", state: "CHANGES_REQUESTED" },
  APPROVED: { label: "Approved", state: "APPROVED" },
};

export const PRIORITY_META: Record<Priority, { label: string; rank: number; className: string }> = {
  URGENT: { label: "Urgent", rank: 4, className: "text-state-changes" },
  HIGH: { label: "High", rank: 3, className: "text-state-review" },
  NORMAL: { label: "Normal", rank: 2, className: "text-fg-subtle" },
  LOW: { label: "Low", rank: 1, className: "text-fg-subtle" },
};

export const PRIORITY_ORDER: Priority[] = ["URGENT", "HIGH", "NORMAL", "LOW"];

/** Card layout: explicit card setting → column default → project default. */
export function resolveDisplayMode(
  card: { displayMode: CardDisplayMode | null },
  column: Pick<ColumnDTO, "defaultCardMode"> | undefined,
  project: Pick<ProjectDTO, "defaultCardMode">,
): CardDisplayMode {
  return card.displayMode ?? column?.defaultCardMode ?? project.defaultCardMode;
}
