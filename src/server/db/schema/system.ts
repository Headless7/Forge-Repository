import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { cards } from "./cards";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { comments } from "./feedback";
import { projects, studios } from "./studio";

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
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    readAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
    index("notifications_user_unread_idx").on(t.userId, t.readAt),
  ],
);

/** Opt-outs per notification type and delivery channel (in-app today; Discord/email later). */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    channel: text({ enum: ["IN_APP", "EMAIL", "DISCORD"] }).notNull(),
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
    status: text({ enum: ["QUEUED", "SENT", "LOGGED", "FAILED"] }).notNull().default("QUEUED"),
    attempts: integer().notNull().default(0),
    error: text(),
    sentAt: tsz(),
    createdAt: createdAt(),
  },
  (t) => [index("email_outbox_status_idx").on(t.status, t.createdAt)],
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
