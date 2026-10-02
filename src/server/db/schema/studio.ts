import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProjectSettings } from "@/lib/types";
import { users } from "./auth";
import { createdAt, pk, tsz, updatedAt } from "./columns";

export const studios = pgTable(
  "studios",
  {
    id: pk(),
    name: text().notNull(),
    slug: text().notNull(),
    iconEmoji: text(),
    accentColor: text().notNull().default("#7c6cf2"),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("studios_slug_uq").on(t.slug)],
);

export const studioMembers = pgTable(
  "studio_members",
  {
    id: pk(),
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Permission role (OWNER/ADMIN/MANAGER/MEMBER/VIEWER). Text so custom roles can be added later. */
    role: text().notNull(),
    /** Studio job title shown on profiles, e.g. "VFX Artist". */
    title: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("studio_members_studio_user_uq").on(t.studioId, t.userId),
    index("studio_members_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: pk(),
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text().notNull(),
    tokenHash: text().notNull(),
    invitedById: uuid().references(() => users.id, { onDelete: "set null" }),
    expiresAt: tsz().notNull(),
    acceptedAt: tsz(),
    acceptedById: uuid().references(() => users.id, { onDelete: "set null" }),
    revokedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_uq").on(t.tokenHash),
    index("invitations_studio_idx").on(t.studioId),
    index("invitations_email_idx").on(t.email),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: pk(),
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    /** Short prefix for card keys, e.g. "UTD" → UTD-42. */
    key: text().notNull(),
    description: text().notNull().default(""),
    icon: text().notNull().default("🎮"),
    color: text().notNull().default("#7c6cf2"),
    background: text().notNull().default("default"),
    visibility: text({ enum: ["STUDIO", "PRIVATE"] }).notNull().default("STUDIO"),
    defaultCardMode: text({ enum: ["VISUAL", "COMPACT"] }).notNull().default("VISUAL"),
    settings: jsonb().$type<ProjectSettings>().notNull().default({
      allowSelfApproval: false,
      requireFeedbackForChanges: true,
      defaultReviewerIds: [],
    }),
    cardCounter: integer().notNull().default(0),
    archivedAt: tsz(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("projects_studio_slug_uq").on(t.studioId, t.slug),
    uniqueIndex("projects_studio_key_uq").on(t.studioId, t.key),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Optional per-project role override; null inherits the studio role. */
    role: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_members_project_user_uq").on(t.projectId, t.userId),
    index("project_members_user_idx").on(t.userId),
  ],
);

export const boards = pgTable(
  "boards",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull().default("Board"),
    archivedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("boards_project_idx").on(t.projectId)],
);

export const boardColumns = pgTable(
  "board_columns",
  {
    id: pk(),
    boardId: uuid()
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    icon: text(),
    color: text(),
    position: doublePrecision().notNull(),
    defaultCardMode: text({ enum: ["VISUAL", "COMPACT"] }),
    archivedAt: tsz(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("board_columns_board_idx").on(t.boardId, t.position)],
);

export const labels = pgTable(
  "labels",
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
  (t) => [uniqueIndex("labels_project_name_uq").on(t.projectId, t.name)],
);

export const milestones = pgTable(
  "milestones",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    dueAt: tsz(),
    releasedAt: tsz(),
    position: doublePrecision().notNull().default(0),
    archivedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("milestones_project_idx").on(t.projectId)],
);

/** Per-user board view preferences (collapsed columns, category vs production view). */
export const userBoardPrefs = pgTable(
  "user_board_prefs",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    boardId: uuid()
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    collapsedColumnIds: jsonb().$type<string[]>().notNull().default([]),
    view: text({ enum: ["CATEGORY", "PRODUCTION"] }).notNull().default("CATEGORY"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.boardId] })],
);
