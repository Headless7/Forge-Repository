import { doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ForumSettings } from "@/lib/types";
import { users } from "./auth";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { milestones, projects } from "./studio";

/**
 * BUGS and QA are created with every project (bug reports and QA checks); CUSTOM forums are made
 * by managers for whatever else needs tracking (a playtest round, an update's polish list…).
 * The kind only picks default wording — every forum has the same workflow.
 */
export const FORUM_KINDS = ["BUGS", "QA", "CUSTOM"] as const;

/**
 * OPEN: reported, nobody on it yet · IN_PROGRESS: the assignee is on it · FIXED: the assignee says
 * it's done, waiting for the reviewer to verify · VERIFIED: the reviewer confirmed it ·
 * CLOSED: resolved without a fix (see ITEM_RESOLUTIONS). Open, in progress and fixed are "unresolved".
 */
export const ITEM_STATUSES = ["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED", "CLOSED"] as const;
export const ITEM_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "GAME_BREAKING"] as const;
export const ITEM_RESOLUTIONS = ["WONT_FIX", "CANNOT_REPRODUCE", "DUPLICATE", "NOT_A_BUG"] as const;

/**
 * A tracker beside the boards: a list of items (bugs, QA checks…) that each have a priority,
 * tags, one assignee who fixes them and one reviewer who verifies, grouped by update.
 */
export const forums = pgTable(
  "forums",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Stable address inside the project: /studio/project/f/<slug>. */
    slug: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    /** Emoji shown in the sidebar. */
    icon: text().notNull().default("📋"),
    kind: text({ enum: FORUM_KINDS }).notNull().default("CUSTOM"),
    /** Letters between the project key and the number: "B" → UTD-B12. Unique in the project. */
    keyPrefix: text().notNull(),
    /** What one item is called ("bug", "issue"), used in buttons and notifications. */
    itemLabel: text().notNull().default("issue"),
    position: doublePrecision().notNull().default(0),
    /** Last item number handed out (numbers are per forum, never reused). */
    counter: integer().notNull().default(0),
    settings: jsonb().$type<ForumSettings>().notNull().default({ defaultReviewerId: null }),
    archivedAt: tsz(),
    archivedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("forums_project_slug_uq").on(t.projectId, t.slug), uniqueIndex("forums_project_prefix_uq").on(t.projectId, t.keyPrefix), index("forums_project_idx").on(t.projectId, t.position)],
);

/** One report in a forum. Belongs to the project (and optionally to one update / milestone), never to a card. */
export const forumItems = pgTable(
  "forum_items",
  {
    id: pk(),
    forumId: uuid()
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Sequential per forum; with the project key and the forum's prefix it forms "UTD-B12". */
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: text({ enum: ITEM_STATUSES }).notNull().default("OPEN"),
    priority: text({ enum: ITEM_PRIORITIES }).notNull().default("MEDIUM"),
    /** Why it was closed without a fix (CLOSED only). */
    resolution: text({ enum: ITEM_RESOLUTIONS }),
    /** The update (milestone) it belongs to; null = not tied to an update. Unresolved items show in the global list regardless. */
    milestoneId: uuid().references(() => milestones.id, { onDelete: "set null" }),
    /** The one person fixing it. */
    assigneeId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** The one person verifying the fix (null: anyone on the team may verify; nobody is notified). */
    reviewerId: uuid().references(() => users.id, { onDelete: "set null" }),
    reportedById: uuid().references(() => users.id, { onDelete: "set null" }),
    /** When it should be done by (null: no deadline). Reminders go to whoever has to act next (see due-dates). */
    dueAt: tsz(),
    fixedAt: tsz(),
    fixedById: uuid().references(() => users.id, { onDelete: "set null" }),
    verifiedAt: tsz(),
    verifiedById: uuid().references(() => users.id, { onDelete: "set null" }),
    closedAt: tsz(),
    closedById: uuid().references(() => users.id, { onDelete: "set null" }),
    lastActivityAt: tsz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("forum_items_forum_number_uq").on(t.forumId, t.number),
    index("forum_items_forum_status_idx").on(t.forumId, t.status),
    index("forum_items_project_idx").on(t.projectId),
    index("forum_items_milestone_idx").on(t.milestoneId),
    index("forum_items_assignee_idx").on(t.assigneeId),
    index("forum_items_reviewer_idx").on(t.reviewerId),
    index("forum_items_due_idx").on(t.dueAt),
  ],
);

/** Where an item happens (Lobby, Play Area, UI…). Per forum, separate from card labels. */
export const forumTags = pgTable(
  "forum_tags",
  {
    id: pk(),
    forumId: uuid()
      .notNull()
      .references(() => forums.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    color: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("forum_tags_forum_name_uq").on(t.forumId, t.name)],
);

export const forumItemTags = pgTable(
  "forum_item_tags",
  {
    itemId: uuid()
      .notNull()
      .references(() => forumItems.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => forumTags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] }), index("forum_item_tags_tag_idx").on(t.tagId)],
);

/** Discussion on an item (repro notes, questions). Flat: no threading. */
export const forumComments = pgTable(
  "forum_comments",
  {
    id: pk(),
    itemId: uuid()
      .notNull()
      .references(() => forumItems.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    body: text().notNull(),
    editedAt: tsz(),
    deletedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("forum_comments_item_idx").on(t.itemId, t.createdAt)],
);
