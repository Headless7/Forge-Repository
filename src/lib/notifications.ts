/**
 * Notification types, their preference labels, and the plain-text wording used by email and
 * device notifications. Each type has its own switch per channel: in-app (inbox and unread count),
 * device (operating-system push to the person's subscribed browsers) and, where the server can
 * send it, email. The channels are independent: turning one off never changes another.
 */
export const NOTIFICATION_TYPES = [
  "ASSIGNED",
  "UNASSIGNED",
  "REVIEWER_ASSIGNED",
  "MENTIONED",
  "COMMENT",
  "REPLY",
  "REVIEW_REQUESTED",
  "CHANGES_REQUESTED",
  "APPROVED",
  "FEEDBACK_RESOLVED",
  "PREREQUISITE_APPROVED",
  "UNBLOCKED",
  "BLOCKED",
  "DUE_SOON",
  "OVERDUE",
  "DUE_CHANGED",
  "WORK_ARCHIVED",
  "WATCHED_CARD",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

type Meta = {
  label: string;
  description: string;
  group: "Work" | "Review" | "Dependencies" | "Deadlines" | "Conversation" | "Following";
  /** Sent to subscribed devices unless switched off (the routine/noisy types are opt-in). */
  push: boolean;
};

export const NOTIFICATION_TYPE_META: Record<NotificationType, Meta> = {
  ASSIGNED: { group: "Work", push: true, label: "Assignments", description: "You're made responsible for, or a contributor to, a card or deliverable." },
  UNASSIGNED: { group: "Work", push: false, label: "Removed from work", description: "Someone takes you off a card or deliverable." },
  WORK_ARCHIVED: { group: "Work", push: false, label: "Restored work", description: "Work you're on is brought back from the archive." },
  REVIEWER_ASSIGNED: { group: "Review", push: true, label: "Reviewer assignments", description: "You're made the reviewer of a card or deliverable." },
  REVIEW_REQUESTED: { group: "Review", push: true, label: "Review requests", description: "Work is submitted (or resubmitted) for your review." },
  CHANGES_REQUESTED: { group: "Review", push: true, label: "Changes requested", description: "A reviewer requests changes on your work." },
  APPROVED: { group: "Review", push: true, label: "Approvals", description: "A reviewer approves your work." },
  FEEDBACK_RESOLVED: { group: "Review", push: false, label: "Feedback resolved", description: "Feedback you left is resolved or reopened." },
  PREREQUISITE_APPROVED: { group: "Dependencies", push: true, label: "Prerequisite approved", description: "Something your deliverable waits on is approved, but it still waits on more." },
  UNBLOCKED: { group: "Dependencies", push: true, label: "Ready to start", description: "Everything your deliverable waits on is approved." },
  BLOCKED: { group: "Dependencies", push: true, label: "Blocked again", description: "A change makes your deliverable wait on unfinished work again." },
  DUE_SOON: { group: "Deadlines", push: true, label: "Due soon", description: "A card or deliverable you're on is due within 24 hours." },
  OVERDUE: { group: "Deadlines", push: true, label: "Overdue", description: "A card or deliverable you're on is past its deadline." },
  DUE_CHANGED: { group: "Deadlines", push: false, label: "Deadline changes", description: "The deadline of your work is moved or removed." },
  MENTIONED: { group: "Conversation", push: true, label: "Mentions", description: "Someone @mentions you in a comment." },
  REPLY: { group: "Conversation", push: true, label: "Replies", description: "Someone replies to your comment or feedback." },
  COMMENT: { group: "Conversation", push: false, label: "Comments on your work", description: "New comments and feedback on work you're responsible for." },
  WATCHED_CARD: { group: "Following", push: false, label: "Watched cards", description: "Significant updates on cards you watch (new revisions, status changes)." },
};

/** In-app: the inbox and its unread count. Push: the person's subscribed devices. Email: when the server can send it. */
export const NOTIFICATION_CHANNELS = ["IN_APP", "PUSH", "EMAIL"] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];

/** A channel's setting when the person hasn't chosen: in-app on, device per type, email off. */
export function channelDefault(type: NotificationType, channel: NotificationChannelId): boolean {
  if (channel === "IN_APP") return true;
  if (channel === "PUSH") return NOTIFICATION_TYPE_META[type].push;
  return false;
}

type Data = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** What the notification is about: "D2 Rig" on "UTD-4 Sword", or just the card. */
export function notificationSubject(data: Data): string {
  const card = [str(data.cardKey), str(data.cardTitle)].filter(Boolean).join(" ");
  const deliverable = str(data.deliverable);
  return deliverable ? `${deliverable} on ${card}` : card;
}

function dueText(data: Data) {
  const due = str(data.dueAt);
  return due ? new Date(due).toUTCString().replace(/:\d\d GMT$/, " UTC") : null;
}

/** One-line plain-text wording (email subjects and bodies); the app renders richer text itself. */
export function notificationText(type: NotificationType, data: Data, actorName: string | null): string {
  const who = actorName ?? "Someone";
  const what = notificationSubject(data);
  const role = data.role === "contributor" ? "a contributor to" : data.role === "reviewer" ? "the reviewer of" : "responsible for";
  switch (type) {
    case "ASSIGNED":
      return `${who} made you ${role} ${what}.`;
    case "UNASSIGNED":
      return `${who} took you off ${what}.`;
    case "REVIEWER_ASSIGNED":
      return `${who} made you the reviewer of ${what}.`;
    case "MENTIONED":
      return `${who} mentioned you on ${what}.`;
    case "COMMENT":
      return `${who} ${data.kind === "FEEDBACK" ? "left feedback" : "commented"} on ${what}.`;
    case "REPLY":
      return `${who} replied to you on ${what}.`;
    case "REVIEW_REQUESTED":
      return `${who} ${data.resubmission ? "resubmitted" : "submitted"} ${what}${data.versionNumber ? ` (V${data.versionNumber})` : ""} for your review.`;
    case "CHANGES_REQUESTED":
      return `${who} requested changes on ${what}${data.versionNumber ? ` (V${data.versionNumber})` : ""}.`;
    case "APPROVED":
      return `${who} approved ${what}${data.versionNumber ? ` (V${data.versionNumber})` : ""}.`;
    case "FEEDBACK_RESOLVED":
      return `${who} ${data.resolved === false ? "reopened" : "resolved"} your feedback on ${what}.`;
    case "PREREQUISITE_APPROVED":
      return `${str(data.prerequisite) ?? "A prerequisite"} was approved. ${what} still waits on ${Number(data.remaining) || 1} more.`;
    case "UNBLOCKED":
      return `${what} is ready to start: everything it waits on is approved.`;
    case "BLOCKED":
      return `${what} is waiting again: ${str(data.prerequisite) ?? "a prerequisite"} is no longer approved.`;
    case "DUE_SOON":
      return `${what} is due ${dueText(data) ?? "soon"}.`;
    case "OVERDUE":
      return `${what} is overdue (it was due ${dueText(data) ?? "earlier"}).`;
    case "DUE_CHANGED":
      return data.dueAt ? `${who} moved the deadline of ${what} to ${dueText(data)}.` : `${who} removed the deadline of ${what}.`;
    case "WORK_ARCHIVED":
      return `${who} ${data.restored ? "restored" : "archived"} ${what}.`;
    case "WATCHED_CARD":
      return `${who} ${str(data.change) ?? "updated"} ${what}.`;
  }
}
