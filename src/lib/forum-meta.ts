import type { ForumKind, ItemPriority, ItemResolution, ItemStatus } from "./types";

export const ITEM_STATUS_ORDER: ItemStatus[] = ["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED", "CLOSED"];

/** Open, in progress and done-but-unverified items still need someone's attention. */
export const UNRESOLVED_ITEM_STATUSES: readonly ItemStatus[] = ["OPEN", "IN_PROGRESS", "FIXED"];

export function isResolvedItem(status: ItemStatus): boolean {
  return status === "VERIFIED" || status === "CLOSED";
}

/** Colours per status (the wording depends on the forum kind: see statusLabel). */
export const ITEM_STATUS_STYLE: Record<ItemStatus, { color: string; text: string; bg: string }> = {
  OPEN: { color: "var(--state-changes)", text: "text-state-changes", bg: "bg-state-changes/15" },
  IN_PROGRESS: { color: "var(--state-progress)", text: "text-state-progress", bg: "bg-state-progress/15" },
  FIXED: { color: "var(--state-review)", text: "text-state-review", bg: "bg-state-review/15" },
  VERIFIED: { color: "var(--state-approved)", text: "text-state-approved", bg: "bg-state-approved/15" },
  CLOSED: { color: "var(--state-draft)", text: "text-state-draft", bg: "bg-state-draft/15" },
};

interface StatusWording {
  label: string;
  short: string;
  description: string;
}

interface KindWording {
  /** What one item is called by default ("bug"); forums can change it. */
  noun: string;
  statuses: Record<ItemStatus, StatusWording>;
  actions: {
    /** The assignee says it's done. */
    done: string;
    /** The reviewer confirms it. */
    verify: string;
    /** The reviewer sends it back. */
    sendBack: string;
    /** The verb for creating an item: "Report a bug", "Log an issue". */
    create: string;
  };
  /** The top priority: "Game breaking" for bugs, "Blocker" elsewhere. */
  topPriority: string;
}

const generic: KindWording = {
  noun: "issue",
  statuses: {
    OPEN: { label: "Open", short: "Open", description: "Logged; nobody has started on it." },
    IN_PROGRESS: { label: "In progress", short: "Doing", description: "The assignee is working on it." },
    FIXED: { label: "Done · to verify", short: "Done", description: "Marked done; waiting to be verified." },
    VERIFIED: { label: "Verified", short: "Verified", description: "Confirmed done." },
    CLOSED: { label: "Closed", short: "Closed", description: "Resolved without doing it." },
  },
  actions: { done: "Mark done", verify: "Verify", sendBack: "Send back", create: "Log" },
  topPriority: "Blocker",
};

export const FORUM_KIND_META: Record<ForumKind, KindWording> = {
  BUGS: {
    noun: "bug",
    statuses: {
      OPEN: { label: "Open", short: "Open", description: "Reported; nobody has started on it." },
      IN_PROGRESS: { label: "In progress", short: "Fixing", description: "The assignee is working on a fix." },
      FIXED: { label: "Fixed · to verify", short: "Fixed", description: "Marked fixed; waiting to be verified in game." },
      VERIFIED: { label: "Verified", short: "Verified", description: "The fix was confirmed in game." },
      CLOSED: { label: "Closed", short: "Closed", description: "Resolved without a fix." },
    },
    actions: { done: "Mark fixed", verify: "Verify fix", sendBack: "Not fixed", create: "Report" },
    topPriority: "Game breaking",
  },
  QA: {
    ...generic,
    noun: "issue",
    statuses: {
      ...generic.statuses,
      OPEN: { label: "Open", short: "Open", description: "Found in testing; nobody has started on it." },
      FIXED: { label: "Done · to verify", short: "Done", description: "Marked done; waiting for QA to confirm it passes." },
      VERIFIED: { label: "Passed", short: "Passed", description: "QA confirmed it passes." },
    },
    actions: { done: "Mark done", verify: "Pass", sendBack: "Failed", create: "Log" },
  },
  CUSTOM: generic,
};

export function statusLabel(kind: ForumKind, status: ItemStatus): StatusWording {
  return FORUM_KIND_META[kind].statuses[status];
}

export const ITEM_PRIORITY_ORDER: ItemPriority[] = ["GAME_BREAKING", "HIGH", "MEDIUM", "LOW"];

export const ITEM_PRIORITY_META: Record<ItemPriority, { label: string; rank: number; className: string; description: string }> = {
  GAME_BREAKING: { label: "Game breaking", rank: 4, className: "text-danger", description: "Players can't play, lose progress or exploit it. Fix first." },
  HIGH: { label: "High", rank: 3, className: "text-state-changes", description: "A main feature is broken or clearly wrong." },
  MEDIUM: { label: "Medium", rank: 2, className: "text-state-review", description: "Noticeable, with a workaround." },
  LOW: { label: "Low", rank: 1, className: "text-fg-subtle", description: "Cosmetic or rare." },
};

/** The top priority reads "Game breaking" in a bug forum and "Blocker" elsewhere. */
export function priorityLabel(kind: ForumKind, priority: ItemPriority): string {
  return priority === "GAME_BREAKING" ? FORUM_KIND_META[kind].topPriority : ITEM_PRIORITY_META[priority].label;
}

export const ITEM_RESOLUTION_META: Record<ItemResolution, { label: string; description: string }> = {
  WONT_FIX: { label: "Won't fix", description: "Intended, or not worth changing." },
  CANNOT_REPRODUCE: { label: "Can't reproduce", description: "Nobody could make it happen again." },
  DUPLICATE: { label: "Duplicate", description: "Already reported as another item." },
  NOT_A_BUG: { label: "Not an issue", description: "Works as designed." },
};

export const ITEM_RESOLUTION_ORDER: ItemResolution[] = ["WONT_FIX", "CANNOT_REPRODUCE", "DUPLICATE", "NOT_A_BUG"];

/** "UTD-B12": the project key, the forum's prefix and the item's number. */
export function itemKey(projectKey: string, keyPrefix: string, number: number): string {
  return `${projectKey}-${keyPrefix}${number}`;
}

/** Default tag suggestions offered while a forum has no tags yet. */
export const SUGGESTED_FORUM_TAGS: Array<{ name: string; color: string }> = [
  { name: "Lobby", color: "#60a5fa" },
  { name: "Play Area", color: "#34d399" },
  { name: "UI", color: "#a78bfa" },
];

/** The two forums every project starts with. */
export const DEFAULT_FORUMS: Array<{ slug: string; name: string; description: string; icon: string; kind: ForumKind; keyPrefix: string; itemLabel: string }> = [
  { slug: "bugs", name: "Bugs", description: "Things that are broken in the game: what happens, where, and who fixes and verifies it.", icon: "🐞", kind: "BUGS", keyPrefix: "B", itemLabel: "bug" },
  { slug: "qa", name: "QA", description: "Checks before an update ships: what to test, what was found, and whether it passed.", icon: "✅", kind: "QA", keyPrefix: "Q", itemLabel: "issue" },
];

export const FORUM_ICONS = ["📋", "🐞", "✅", "🧪", "🎮", "🗺️", "🎨", "🔊", "⚙️", "📱", "🚀", "🎃", "🔥", "💡", "🛠️", "🧩", "📝", "🎯", "⚠️", "🌟"];

/** Letters for item keys, from a forum's name: "Playtest round 2" → "PR". */
export function keyPrefixFrom(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "F").slice(0, 2);
  const prefix = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  return prefix || "F";
}

/** "a bug", "an issue". */
export function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/** "issue" → "issues"; "bug" → "bugs". Good enough for the nouns people pick. */
export function plural(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/**
 * Who has to act before a forum item's deadline: the assignee while it's open or in progress, the
 * reviewer once it's done and waiting to be verified. Nobody named, nobody reminded.
 */
export function itemDeadlineRecipients(item: { status: string; assigneeId: string | null; reviewerId: string | null }): string[] {
  const who = item.status === "FIXED" ? item.reviewerId : item.status === "OPEN" || item.status === "IN_PROGRESS" ? item.assigneeId : null;
  return who ? [who] : [];
}
