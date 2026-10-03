import {
  boolean,
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
import type { ProductionSnapshotEntry } from "@/lib/types";
import { users } from "./auth";
import { cards } from "./cards";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { CARD_STATES, DELIVERABLE_LINK_TYPES, PRODUCTION_STATUSES } from "./enums";
import { assetVersions, attachments } from "./media";
import { projects, studios } from "./studio";

/**
 * A first-class piece of work inside a card (a model, a rig, an animation, a sound …).
 * Every card has at least one. Each deliverable owns its own revisions (asset_versions),
 * review state and history, so reviewing one never touches another.
 */
export const deliverables = pgTable(
  "deliverables",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Sequential per card (D1, D2 …) — stable for deep links. */
    number: integer().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    /** Free-form type ("Model", "Animation", "VFX", "Audio" …); never a fixed template. */
    assetType: text().notNull().default(""),
    required: boolean().notNull().default(true),
    state: text({ enum: CARD_STATES }).notNull().default("NOT_SUBMITTED"),
    /** Responsible person; falls back to the card's assignees when empty. */
    ownerId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** Review owner; falls back to the card's reviewers when empty. */
    reviewerId: uuid().references(() => users.id, { onDelete: "set null" }),
    dueAt: tsz(),
    currentVersionId: uuid().references((): AnyPgColumn => assetVersions.id, { onDelete: "set null" }),
    /** Most recent approved revision — kept when newer, unapproved revisions arrive. */
    approvedVersionId: uuid().references((): AnyPgColumn => assetVersions.id, { onDelete: "set null" }),
    coverAttachmentId: uuid().references((): AnyPgColumn => attachments.id, { onDelete: "set null" }),
    /** Position on the card's deliverable canvas. */
    canvasX: real().notNull().default(0),
    canvasY: real().notNull().default(0),
    /** Node size on the canvas; null = the default size (see lib/canvas-points). */
    canvasW: real(),
    canvasH: real(),
    /** Order in list view. */
    position: doublePrecision().notNull(),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    archivedAt: tsz(),
    archivedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("deliverables_card_number_uq").on(t.cardId, t.number),
    index("deliverables_card_idx").on(t.cardId, t.position),
    index("deliverables_owner_idx").on(t.ownerId),
  ],
);

export { DELIVERABLE_LINK_TYPES, PRODUCTION_STATUSES };

/**
 * Relationships between deliverables of the same card.
 *  DEPENDENCY: `toId` requires `fromId` (arrows point from prerequisite to dependant).
 *  ASSOCIATION: non-blocking "related to".
 */
export const deliverableLinks = pgTable(
  "deliverable_links",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    fromId: uuid()
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    toId: uuid()
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    type: text({ enum: DELIVERABLE_LINK_TYPES }).notNull(),
    /** Connection points the arrow leaves from / arrives at (e.g. "r-50"); null = the default sides. */
    fromPoint: text(),
    toPoint: text(),
    note: text().notNull().default(""),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("deliverable_links_pair_uq").on(t.fromId, t.toId, t.type),
    index("deliverable_links_card_idx").on(t.cardId),
  ],
);

/**
 * People who work on a deliverable alongside its responsible person (ownerId). They can upload,
 * submit and resolve feedback on that deliverable only; responsibility stays with the owner.
 */
export const deliverableContributors = pgTable(
  "deliverable_contributors",
  {
    deliverableId: uuid()
      .notNull()
      .references((): AnyPgColumn => deliverables.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.deliverableId, t.userId] }), index("deliverable_contributors_user_idx").on(t.userId)],
);

/** Append-only production history (completed / published / reopened) with what was included. */
export const productionEvents = pgTable(
  "production_events",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    fromStatus: text({ enum: PRODUCTION_STATUSES }).notNull(),
    toStatus: text({ enum: PRODUCTION_STATUSES }).notNull(),
    note: text().notNull().default(""),
    snapshot: jsonb().$type<ProductionSnapshotEntry[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("production_events_card_idx").on(t.cardId, t.createdAt)],
);

/**
 * Files that stand in for content a Roblox model references but doesn't contain
 * (meshes and textures stored on Roblox). Scoped to a project so one upload
 * resolves every reference to that asset in the project.
 */
export const robloxResources = pgTable(
  "roblox_resources",
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    contentId: text().notNull(),
    kind: text({ enum: ["mesh", "texture"] }).notNull(),
    attachmentId: uuid()
      .notNull()
      .references((): AnyPgColumn => attachments.id, { onDelete: "cascade" }),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("roblox_resources_project_content_uq").on(t.projectId, t.contentId, t.kind)],
);

/**
 * Meshes/textures downloaded from Roblox for previews. A cache, not content: one copy per
 * studio, served to every preview that references the asset, and deleted after 7 days
 * without being requested (it is fetched again when next needed). Files people upload
 * themselves live in roblox_resources and are never evicted.
 */
export const robloxAssetCache = pgTable(
  "roblox_asset_cache",
  {
    studioId: uuid()
      .notNull()
      .references(() => studios.id, { onDelete: "cascade" }),
    kind: text({ enum: ["mesh", "texture"] }).notNull(),
    assetId: text().notNull(),
    storageKey: text().notNull(),
    /** Decoded copy for Draco-compressed meshes; served instead of the original. */
    convertedKey: text(),
    format: text().notNull(),
    filename: text().notNull(),
    sizeBytes: integer().notNull(),
    fetchedAt: createdAt(),
    lastAccessedAt: tsz().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.studioId, t.kind, t.assetId] }), index("roblox_asset_cache_last_accessed_idx").on(t.lastAccessedAt)],
);
