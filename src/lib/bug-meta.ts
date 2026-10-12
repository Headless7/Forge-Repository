import type { BugPriority, BugResolution, BugStatus } from "./types";

export const BUG_STATUS_ORDER: BugStatus[] = ["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED", "CLOSED"];

/** Open, in progress and fixed-but-unverified bugs still need someone's attention. */
export const UNRESOLVED_BUG_STATUSES: readonly BugStatus[] = ["OPEN", "IN_PROGRESS", "FIXED"];

export function isResolvedBug(status: BugStatus): boolean {
  return status === "VERIFIED" || status === "CLOSED";
}

export const BUG_STATUS_META: Record<BugStatus, { label: string; short: string; description: string; color: string; text: string; bg: string }> = {
  OPEN: {
    label: "Open",
    short: "Open",
    description: "Reported; nobody has started on it.",
    color: "var(--state-changes)",
    text: "text-state-changes",
    bg: "bg-state-changes/15",
  },
  IN_PROGRESS: {
    label: "In progress",
    short: "Fixing",
    description: "The assignee is working on a fix.",
    color: "var(--state-progress)",
    text: "text-state-progress",
    bg: "bg-state-progress/15",
  },
  FIXED: {
    label: "Fixed · to verify",
    short: "Fixed",
    description: "Marked fixed; waiting for the reviewer to verify it in game.",
    color: "var(--state-review)",
    text: "text-state-review",
    bg: "bg-state-review/15",
  },
  VERIFIED: {
    label: "Verified",
    short: "Verified",
    description: "The reviewer confirmed the fix.",
    color: "var(--state-approved)",
    text: "text-state-approved",
    bg: "bg-state-approved/15",
  },
  CLOSED: {
    label: "Closed",
    short: "Closed",
    description: "Resolved without a fix.",
    color: "var(--state-draft)",
    text: "text-state-draft",
    bg: "bg-state-draft/15",
  },
};

export const BUG_PRIORITY_ORDER: BugPriority[] = ["GAME_BREAKING", "HIGH", "MEDIUM", "LOW"];

export const BUG_PRIORITY_META: Record<BugPriority, { label: string; rank: number; className: string; description: string }> = {
  GAME_BREAKING: { label: "Game breaking", rank: 4, className: "text-danger", description: "Players can't play, lose progress or exploit it. Fix first." },
  HIGH: { label: "High", rank: 3, className: "text-state-changes", description: "A main feature is broken or clearly wrong." },
  MEDIUM: { label: "Medium", rank: 2, className: "text-state-review", description: "Noticeable, with a workaround." },
  LOW: { label: "Low", rank: 1, className: "text-fg-subtle", description: "Cosmetic or rare." },
};

export const BUG_RESOLUTION_META: Record<BugResolution, { label: string; description: string }> = {
  WONT_FIX: { label: "Won't fix", description: "Intended, or not worth changing." },
  CANNOT_REPRODUCE: { label: "Can't reproduce", description: "Nobody could make it happen again." },
  DUPLICATE: { label: "Duplicate", description: "Already reported as another bug." },
  NOT_A_BUG: { label: "Not a bug", description: "Works as designed." },
};

export const BUG_RESOLUTION_ORDER: BugResolution[] = ["WONT_FIX", "CANNOT_REPRODUCE", "DUPLICATE", "NOT_A_BUG"];

/** "UTD-B12": the project key plus a B-numbered counter, distinct from card keys. */
export function bugKey(projectKey: string, number: number): string {
  return `${projectKey}-B${number}`;
}

/** Default tag suggestions offered while a project has no bug tags yet. */
export const SUGGESTED_BUG_TAGS: Array<{ name: string; color: string }> = [
  { name: "Lobby", color: "#60a5fa" },
  { name: "Play Area", color: "#34d399" },
  { name: "UI", color: "#a78bfa" },
];
