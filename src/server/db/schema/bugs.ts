import { index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { milestones, projects } from "./studio";

/**
 * OPEN: reported, nobody on it yet · IN_PROGRESS: the assignee is on it · FIXED: the assignee says
 * it's fixed, waiting for the reviewer to verify · VERIFIED: the reviewer confirmed the fix ·
 * CLOSED: resolved without a fix (see BUG_RESOLUTIONS). Open, in progress and fixed are "unresolved".
 */
export const BUG_STATUSES = ["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED", "CLOSED"] as const;
export const BUG_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "GAME_BREAKING"] as const;
export const BUG_RESOLUTIONS = ["WONT_FIX", "CANNOT_REPRODUCE", "DUPLICATE", "NOT_A_BUG"] as const;

/**
 * A bug report. Lives beside the boards: it belongs to the project (and optionally to one update /
 * milestone), never to a card. One assignee fixes it and one reviewer verifies the fix.
 */
export const bugs = pgTable(
  "bugs",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Sequential per project; with the project key it forms "UTD-B12". */
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: text({ enum: BUG_STATUSES }).notNull().default("OPEN"),
    priority: text({ enum: BUG_PRIORITIES }).notNull().default("MEDIUM"),
    /** Why it was closed without a fix (CLOSED only). */
    resolution: text({ enum: BUG_RESOLUTIONS }),
    /** The update (milestone) it belongs to; null = not tied to an update. Unresolved bugs show in the global list regardless. */
    milestoneId: uuid().references(() => milestones.id, { onDelete: "set null" }),
    /** The one person fixing it. */
    assigneeId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** The one person verifying the fix (null: any manager). */
    reviewerId: uuid().references(() => users.id, { onDelete: "set null" }),
    reportedById: uuid().references(() => users.id, { onDelete: "set null" }),
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
    uniqueIndex("bugs_project_number_uq").on(t.projectId, t.number),
    index("bugs_project_status_idx").on(t.projectId, t.status),
    index("bugs_milestone_idx").on(t.milestoneId),
    index("bugs_assignee_idx").on(t.assigneeId),
    index("bugs_reviewer_idx").on(t.reviewerId),
  ],
);

/** Where a bug happens (Lobby, Play Area, UI…). Project-wide, separate from card labels. */
export const bugTags = pgTable(
  "bug_tags",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    color: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("bug_tags_project_name_uq").on(t.projectId, t.name)],
);

export const bugTagLinks = pgTable(
  "bug_tag_links",
  {
    bugId: uuid()
      .notNull()
      .references(() => bugs.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => bugTags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.bugId, t.tagId] }), index("bug_tag_links_tag_idx").on(t.tagId)],
);

/** Discussion on a bug (repro notes, questions). Flat: no threading. */
export const bugComments = pgTable(
  "bug_comments",
  {
    id: pk(),
    bugId: uuid()
      .notNull()
      .references(() => bugs.id, { onDelete: "cascade" }),
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
  (t) => [index("bug_comments_bug_idx").on(t.bugId, t.createdAt)],
);
