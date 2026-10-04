import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sessions, users } from "./auth";
import { cards } from "./cards";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { deliverables } from "./deliverables";
import { comments } from "./feedback";
import { assetVersions } from "./media";
import { boards, projects, studios } from "./studio";

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    /** Recipient. */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    cardId: uuid().references(() => cards.id, { onDelete: "cascade" }),
    commentId: uuid().references(() => comments.id, { onDelete: "set null" }),
    /** The deliverable / revision the notification is about, so it opens exactly there. */
    deliverableId: uuid().references((): AnyPgColumn => deliverables.id, { onDelete: "cascade" }),
    versionId: uuid().references((): AnyPgColumn => assetVersions.id, { onDelete: "set null" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Set for notifications that must reach someone at most once (deadline reminders): the same
     * key for the same person is ignored, whichever worker or retry produces it.
     */
    dedupeKey: text(),
    /**
     * Shown in the in-app inbox (and its unread count). False when the person only wants this kind
     * of notification on their devices or by email: the row still drives (and de-duplicates) those.
     */
    inbox: boolean().notNull().default(true),
    readAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
    index("notifications_card_idx").on(t.cardId),
    index("notifications_user_unread_idx").on(t.userId, t.readAt),
    uniqueIndex("notifications_user_dedupe_uq").on(t.userId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

/** Choices per notification type and delivery channel; a missing row means the channel's default. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    channel: text({ enum: ["IN_APP", "EMAIL", "PUSH", "DISCORD"] }).notNull(),
    enabled: boolean().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type, t.channel] })],
);

/** Human-readable history of what happened in a project and on each card. */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: pk(),
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cardId: uuid().references(() => cards.id, { onDelete: "set null" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_project_created_idx").on(t.projectId, t.createdAt),
    index("activity_card_created_idx").on(t.cardId, t.createdAt),
    index("activity_studio_created_idx").on(t.studioId, t.createdAt),
  ],
);

/** Security-relevant actions (roles, invitations, deletions, settings). */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    studioId: uuid().references(() => studios.id, { onDelete: "set null" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_studio_created_idx").on(t.studioId, t.createdAt)],
);

/** Transactional outbox for email; delivered by SMTP when configured, otherwise logged. */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: pk(),
    to: text().notNull(),
    subject: text().notNull(),
    textBody: text().notNull(),
    htmlBody: text().notNull(),
    template: text().notNull(),
    /** SKIPPED: a notification email whose recipient lost access before it could be sent. */
    status: text({ enum: ["QUEUED", "SENT", "LOGGED", "FAILED", "SKIPPED"] }).notNull().default("QUEUED"),
    attempts: integer().notNull().default(0),
    /** Retries back off; a row is picked up again only after this time. */
    nextAttemptAt: tsz().notNull().default(sql`now()`),
    /** For notification emails: whose they are and which project, re-checked before sending. */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    /** The notification it delivers: re-checked too (archived work, removed notification). */
    notificationId: uuid().references((): AnyPgColumn => notifications.id, { onDelete: "cascade" }),
    error: text(),
    sentAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [index("email_outbox_status_idx").on(t.status, t.createdAt)],
);

/**
 * Durable, retried removal of stored files. A deletion enqueues the attachment folders it freed
 * (an original plus its thumbnails, previews and transcodes) in the same transaction; a worker
 * removes each folder only once nothing references it any more, retrying failures.
 */
export const storageDeletions = pgTable(
  "storage_deletions",
  {
    prefix: text().primaryKey(),
    reason: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: tsz().notNull().default(sql`now()`),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [index("storage_deletions_next_idx").on(t.nextAttemptAt)],
);

/**
 * Shared rate-limit budgets for security-sensitive actions (sign-in, sign-up, password
 * resets, invitations), so every app instance counts against the same window.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text().primaryKey(),
    count: integer().notNull(),
    resetAt: tsz().notNull(),
  },
  (t) => [index("rate_limits_reset_idx").on(t.resetAt)],
);

/**
 * A browser/device that asked for operating-system notifications (Web Push). Tied to the sign-in
 * session that created it: signing out (or the session expiring) stops delivery to that device,
 * so someone else using the browser later never sees the previous person's notifications.
 * The endpoint is a capability URL — treat it like a secret.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    /** "Edge on Windows" — so people can tell their devices apart. */
    label: text().notNull().default(""),
    userAgent: text(),
    lastSuccessAt: tsz(),
    /** Consecutive failed deliveries; reset on success. */
    failures: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
);

/**
 * Durable queue of device notifications: one row per notification and device, written in the
 * same transaction as the event (so nothing is sent for work that rolled back) and re-checked —
 * access, archived work, the person's current choices — just before sending.
 */
export const pushDeliveries = pgTable(
  "push_deliveries",
  {
    id: pk(),
    notificationId: uuid()
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    subscriptionId: uuid()
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SKIPPED: no longer appropriate when its turn came (access, archive, preference, device gone). */
    status: text({ enum: ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"] }).notNull().default("QUEUED"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: tsz().notNull().default(sql`now()`),
    error: text(),
    sentAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("push_deliveries_notification_device_uq").on(t.notificationId, t.subscriptionId),
    index("push_deliveries_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

/**
 * A person's private calendar subscription (ICS): the URL carries a random token, of which only a
 * hash is stored. Calendar apps fetch it without signing in, so it shows only that person's work,
 * re-checked against their current access on every fetch. Regenerating replaces (revokes) it.
 */
export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    lastUsedAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("calendar_feeds_token_uq").on(t.tokenHash), uniqueIndex("calendar_feeds_user_uq").on(t.userId)],
);

/**
 * Contextual tutorial progress: one row per tip a person has dismissed, so dismissals from several
 * devices at once can't overwrite each other. `version` only ever grows (a reworded tip keeps its
 * id and version; a changed workflow bumps the version so it shows again).
 */
export const tutorialProgress = pgTable(
  "tutorial_progress",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tipId: text().notNull(),
    version: integer().notNull().default(1),
    dismissedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tipId] })],
);

/** Per-person tutorial preference. No row means tips are on. */
export const tutorialSettings = pgTable("tutorial_settings", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  tipsEnabled: boolean().notNull().default(true),
  resetAt: tsz(),
  updatedAt: updatedAt(),
});

/**
 * A studio's connected Discord server (one per studio). The Forge bot was added to it through
 * Discord's install screen by an Admin or Owner. `lostAt`: Discord says the bot is no longer there.
 */
export const discordConnections = pgTable(
  "discord_connections",
  {
    studioId: uuid()
      .primaryKey()
      .references(() => studios.id, { onDelete: "cascade" }),
    guildId: text().notNull(),
    guildName: text().notNull(),
    guildIcon: text(),
    connectedById: uuid().references(() => users.id, { onDelete: "set null" }),
    connectedAt: createdAt(),
    lostAt: tsz(),
  },
  (t) => [index("discord_connections_guild_idx").on(t.guildId)],
);

/**
 * A team feed: which of a project's events (all boards, or one) go to which Discord channel.
 * Private projects only post once someone confirmed who can read the channel.
 */
export const discordRoutes = pgTable(
  "discord_routes",
  {
    id: pk(),
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null: every board of the project. */
    boardId: uuid().references(() => boards.id, { onDelete: "cascade" }),
    channelId: text().notNull(),
    channelName: text().notNull(),
    events: text().array().notNull(),
    privateConfirmedAt: tsz(),
    privateConfirmedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    lastSentAt: tsz(),
    lastError: text(),
    lastErrorAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("discord_routes_project_idx").on(t.projectId), index("discord_routes_studio_idx").on(t.studioId)],
);

/**
 * Discord messages waiting to go out (one per feed and event). Queued in the same transaction as
 * the change they describe; the content is built and access re-checked when it's sent.
 */
export const discordDeliveries = pgTable(
  "discord_deliveries",
  {
    id: pk(),
    routeId: uuid()
      .notNull()
      .references(() => discordRoutes.id, { onDelete: "cascade" }),
    /** What happened (ids and small facts); see services/discord. */
    event: jsonb().notNull(),
    /** One message per feed per occurrence (e.g. "review:<id>", "digest:2026-10-05"). */
    dedupeKey: text().notNull(),
    status: text({ enum: ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"] }).notNull().default("QUEUED"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: tsz().notNull().default(sql`now()`),
    error: text(),
    messageId: text(),
    sentAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("discord_deliveries_route_key_uq").on(t.routeId, t.dedupeKey), index("discord_deliveries_due_idx").on(t.status, t.nextAttemptAt)],
);

/**
 * Discord direct messages, per person: the DM channel Forge opened with their connected Discord
 * account, and whether messaging them currently works. Discord refuses DMs unless the person shares
 * a server with the Forge bot and allows DMs from its members; then DMs pause (with the reason)
 * until a retry or a reconnect succeeds.
 */
export const discordDmRecipients = pgTable("discord_dm_recipients", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The Discord account the channel and pause belong to (reset when another account is connected). */
  discordUserId: text().notNull(),
  channelId: text(),
  welcomedAt: tsz(),
  pausedAt: tsz(),
  pausedReason: text(),
  updatedAt: updatedAt(),
});

/**
 * Queued direct messages: one per notification (or the welcome after connecting). Content is built
 * and access re-checked when sent; deadline reminders that are due together go out as one message.
 */
export const discordDmDeliveries = pgTable(
  "discord_dm_deliveries",
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    notificationId: uuid().references(() => notifications.id, { onDelete: "cascade" }),
    kind: text({ enum: ["NOTIFICATION", "WELCOME"] }).notNull().default("NOTIFICATION"),
    /** "notification:<id>" or "welcome:<n>". */
    dedupeKey: text().notNull(),
    status: text({ enum: ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"] }).notNull().default("QUEUED"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: tsz().notNull().default(sql`now()`),
    error: text(),
    messageId: text(),
    sentAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("discord_dm_deliveries_user_key_uq").on(t.userId, t.dedupeKey), index("discord_dm_deliveries_due_idx").on(t.status, t.nextAttemptAt)],
);
