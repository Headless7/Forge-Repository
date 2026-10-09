import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { CardLink, ProductionSnapshotEntry } from "@/lib/types";
import { users } from "./auth";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { attachments } from "./media";
import { CARD_STATES, PRIORITIES, PRODUCTION_STATUSES } from "./enums";
import { boardColumns, boards, labels, milestones, projects } from "./studio";

export { CARD_STATES, PRIORITIES };

export const cards = pgTable(
  "cards",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    boardId: uuid()
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    columnId: uuid()
      .notNull()
      .references(() => boardColumns.id, { onDelete: "restrict" }),
    /** Sequential per project; combined with the project key to form "UTD-42". */
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    position: doublePrecision().notNull(),
    /** Review roll-up of the card's deliverables (see recomputeCardRollup). */
    state: text({ enum: CARD_STATES }).notNull().default("NOT_SUBMITTED"),
    /** Production stage — independent of the category column and of review state. */
    productionStatus: text({ enum: PRODUCTION_STATUSES }).notNull().default("TODO"),
    /** Order inside the production-view column. */
    productionPosition: doublePrecision().notNull().default(0),
    completedAt: tsz(),
    completedById: uuid().references(() => users.id, { onDelete: "set null" }),
    publishedAt: tsz(),
    publishedById: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Deliverable revisions recorded by the latest completion/publication. */
    productionSnapshot: jsonb().$type<ProductionSnapshotEntry[]>().notNull().default([]),
    priority: text({ enum: PRIORITIES }).notNull().default("NORMAL"),
    /** Null → inherit from the column default, then the project default. */
    displayMode: text({ enum: ["VISUAL", "COMPACT"] }),
    /** When work is planned to start (optional; the timeline draws start → due). */
    startAt: tsz(),
    dueAt: tsz(),
    milestoneId: uuid().references(() => milestones.id, { onDelete: "set null" }),
    estimateHours: real(),
    links: jsonb().$type<CardLink[]>().notNull().default([]),
    /** Denormalised pointer to the media shown on the board tile (derived from coverMode — see recomputeCardRollup). */
    coverAttachmentId: uuid().references((): AnyPgColumn => attachments.id, { onDelete: "set null" }),
    /** AUTO: the first deliverable's current file. MANUAL: coverPinnedId (falls back to AUTO while unusable). NONE: no cover. */
    coverMode: text({ enum: ["AUTO", "MANUAL", "NONE"] }).notNull().default("AUTO"),
    /** The image/video someone chose as the cover; survives new revisions, processing and review changes. */
    coverPinnedId: uuid().references((): AnyPgColumn => attachments.id, { onDelete: "set null" }),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Incremented on every change; lets clients detect stale state. */
    revision: integer().notNull().default(1),
    lastActivityAt: tsz().notNull().defaultNow(),
    lastActivityById: uuid().references(() => users.id, { onDelete: "set null" }),
    dueReminderSentAt: tsz(),
    archivedAt: tsz(),
    archivedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cards_project_number_uq").on(t.projectId, t.number),
    index("cards_column_position_idx").on(t.columnId, t.position),
    index("cards_project_state_idx").on(t.projectId, t.state),
    index("cards_project_production_idx").on(t.projectId, t.productionStatus, t.productionPosition),
    index("cards_milestone_idx").on(t.milestoneId),
    index("cards_due_idx").on(t.dueAt),
  ],
);

export const cardAssignees = pgTable(
  "card_assignees",
  {
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] }), index("card_assignees_user_idx").on(t.userId)],
);

export const cardReviewers = pgTable(
  "card_reviewers",
  {
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] }), index("card_reviewers_user_idx").on(t.userId)],
);

export const cardWatchers = pgTable(
  "card_watchers",
  {
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] }), index("card_watchers_user_idx").on(t.userId)],
);

export const cardLabels = pgTable(
  "card_labels",
  {
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    labelId: uuid()
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.labelId] }), index("card_labels_label_idx").on(t.labelId)],
);

export const checklists = pgTable(
  "checklists",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    title: text().notNull(),
    position: doublePrecision().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("checklists_card_idx").on(t.cardId)],
);

export const checklistItems = pgTable(
  "checklist_items",
  {
    id: pk(),
    checklistId: uuid()
      .notNull()
      .references(() => checklists.id, { onDelete: "cascade" }),
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    text: text().notNull(),
    isDone: boolean().notNull().default(false),
    position: doublePrecision().notNull(),
    doneById: uuid().references(() => users.id, { onDelete: "set null" }),
    doneAt: tsz(),
    /** The one person doing this item (a project member who can work on cards). */
    assigneeId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** The day it is due (no time: due by the end of that day). */
    dueOn: date({ mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("checklist_items_checklist_idx").on(t.checklistId), index("checklist_items_card_idx").on(t.cardId), index("checklist_items_assignee_idx").on(t.assigneeId)],
);

/** Last time a user opened a card — drives "recently viewed" and unread indicators. */
export const cardViews = pgTable(
  "card_views",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cardId: uuid()
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    lastViewedAt: tsz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cardId] }), index("card_views_user_recent_idx").on(t.userId, t.lastViewedAt)],
);
