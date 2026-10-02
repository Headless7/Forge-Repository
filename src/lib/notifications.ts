export const NOTIFICATION_TYPES = [
  "ASSIGNED",
  "MENTIONED",
  "COMMENT",
  "REPLY",
  "REVIEW_REQUESTED",
  "CHANGES_REQUESTED",
  "APPROVED",
  "WATCHED_CARD",
  "DUE_SOON",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_META: Record<NotificationType, { label: string; description: string }> = {
  ASSIGNED: { label: "Assignments", description: "Someone assigns you to a card." },
  MENTIONED: { label: "Mentions", description: "Someone @mentions you in a comment." },
  COMMENT: { label: "Comments on your cards", description: "New comments on cards you created or are assigned to." },
  REPLY: { label: "Replies", description: "Someone replies to your comment or feedback." },
  REVIEW_REQUESTED: { label: "Review requests", description: "Work is submitted for your review." },
  CHANGES_REQUESTED: { label: "Changes requested", description: "A reviewer requests changes on your work." },
  APPROVED: { label: "Approvals", description: "A reviewer approves your work." },
  WATCHED_CARD: { label: "Watched cards", description: "Significant updates on cards you watch (new versions, status changes)." },
  DUE_SOON: { label: "Due dates", description: "A card assigned to you is due within 24 hours." },
};

export const NOTIFICATION_CHANNELS = ["IN_APP", "DISCORD", "EMAIL"] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];
