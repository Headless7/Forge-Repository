import { index, pgTable, primaryKey, text, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { cards } from "./cards";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { deliverables } from "./deliverables";
import { assetVersions, attachments } from "./media";
import { projects } from "./studio";

export const REVIEW_ACTIONS = ["SUBMITTED", "APPROVED", "CHANGES_REQUESTED", "WITHDRAWN", "REOPENED"] as const;

/** Append-only review history: submissions and review decisions per version. */
export const reviews = pgTable(
  "reviews",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    deliverableId: uuid().references((): AnyPgColumn => deliverables.id, { onDelete: "cascade" }),
    versionId: uuid().references(() => assetVersions.id, { onDelete: "set null" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text({ enum: REVIEW_ACTIONS }).notNull(),
    note: text().notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("reviews_card_idx").on(t.cardId, t.createdAt),
    index("reviews_version_idx").on(t.versionId),
    index("reviews_deliverable_idx").on(t.deliverableId, t.createdAt),
  ],
);

/**
 * Comments cover both general DISCUSSION and actionable FEEDBACK.
 * Feedback can be resolved, anchored to media (see media_annotations) and grouped under a review.
 * Replies reference their parent via parentId (one level of threading).
 */
export const comments = pgTable(
  "comments",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid().references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    kind: text({ enum: ["DISCUSSION", "FEEDBACK"] }).notNull().default("DISCUSSION"),
    body: text().notNull(),
    /** Scope: null = the card as a whole; otherwise one deliverable (file feedback also sets versionId/attachmentId). */
    deliverableId: uuid().references((): AnyPgColumn => deliverables.id, { onDelete: "cascade" }),
    versionId: uuid().references((): AnyPgColumn => assetVersions.id, { onDelete: "set null" }),
    attachmentId: uuid().references((): AnyPgColumn => attachments.id, { onDelete: "set null" }),
    reviewId: uuid().references(() => reviews.id, { onDelete: "set null" }),
    resolvedAt: tsz(),
    resolvedById: uuid().references(() => users.id, { onDelete: "set null" }),
    editedAt: tsz(),
    deletedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("comments_card_idx").on(t.cardId, t.createdAt),
    index("comments_parent_idx").on(t.parentId),
    index("comments_version_idx").on(t.versionId),
    index("comments_review_idx").on(t.reviewId),
    index("comments_deliverable_idx").on(t.deliverableId),
  ],
);

export const commentMentions = pgTable(
  "comment_mentions",
  {
    commentId: uuid()
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId] })],
);

export const commentReactions = pgTable(
  "comment_reactions",
  {
    commentId: uuid()
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId, t.emoji] })],
);
