/**
 * Discord team feeds: which Forge events a channel can receive. Shared by the server (validation,
 * queueing) and the settings UI. Feeds carry who did what and a link back; never comment or
 * feedback text, and never files.
 */
export const DISCORD_EVENTS = ["REVIEW_SUBMITTED", "CHANGES_REQUESTED", "APPROVED", "COMPLETED", "PUBLISHED", "DUE_DIGEST"] as const;

export type DiscordEventType = (typeof DISCORD_EVENTS)[number];

export const DISCORD_EVENT_META: Record<DiscordEventType, { label: string; hint: string }> = {
  REVIEW_SUBMITTED: { label: "Submitted for review", hint: "A revision is waiting for a reviewer." },
  CHANGES_REQUESTED: { label: "Changes requested", hint: "A reviewer sent work back." },
  APPROVED: { label: "Approved", hint: "A revision was approved." },
  COMPLETED: { label: "Completed", hint: "A card was marked completed." },
  PUBLISHED: { label: "Published", hint: "A card was marked published (released)." },
  DUE_DIGEST: { label: "Daily deadline summary", hint: "Once a day: overdue work and work due in the next two days." },
};

/** What a new feed gets unless someone changes it. */
export const DEFAULT_DISCORD_EVENTS: DiscordEventType[] = [...DISCORD_EVENTS];

export function isDiscordEvent(value: string): value is DiscordEventType {
  return (DISCORD_EVENTS as readonly string[]).includes(value);
}

/** The daily summary goes out at this hour (UTC) or the first check after it. */
export const DISCORD_DIGEST_HOUR_UTC = 9;

/**
 * Direct messages: the notifications Forge sends as a Discord DM to everyone who has connected
 * their Discord account (no per-type settings; disconnecting Discord stops them). Like device
 * notifications they say who did what, never comment or feedback text.
 */
export const DISCORD_DM_TYPES = [
  "DUE_SOON",
  "OVERDUE",
  "REVIEW_REQUESTED",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REVIEWER_ASSIGNED",
  "ASSIGNED",
  "UNBLOCKED",
  "BLOCKED",
  "MENTIONED",
  "REPLY",
] as const;

export function isDiscordDmType(type: string): boolean {
  return (DISCORD_DM_TYPES as readonly string[]).includes(type);
}
