import { bigint, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { cards } from "./cards";
import { createdAt, pk, tsz, updatedAt } from "./columns";
import { deliverables } from "./deliverables";
import { comments } from "./feedback";
import { projects } from "./studio";

export const VERSION_STATUSES = ["DRAFT", "IN_REVIEW", "CHANGES_REQUESTED", "APPROVED"] as const;

/** One revision of a deliverable (V1, V2 …). Version numbers are per deliverable. Never deleted. */
export const assetVersions = pgTable(
  "asset_versions",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    deliverableId: uuid()
      .notNull()
      .references((): AnyPgColumn => deliverables.id, { onDelete: "cascade" }),
    versionNumber: integer().notNull(),
    notes: text().notNull().default(""),
    status: text({ enum: VERSION_STATUSES }).notNull().default("DRAFT"),
    createdById: uuid().references(() => users.id, { onDelete: "set null" }),
    submittedAt: tsz(),
    submittedById: uuid().references(() => users.id, { onDelete: "set null" }),
    decidedAt: tsz(),
    decidedById: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("asset_versions_deliverable_number_uq").on(t.deliverableId, t.versionNumber),
    index("asset_versions_card_idx").on(t.cardId),
  ],
);

export const ATTACHMENT_KINDS = ["IMAGE", "VIDEO", "AUDIO", "ROBLOX", "FILE"] as const;
/** COVER: uploaded only to be the card's board cover (no revision, no review). */
export const ATTACHMENT_PURPOSES = ["VERSION", "CARD", "COMMENT", "RESOURCE", "COVER"] as const;
export const ATTACHMENT_STATUSES = ["PENDING", "PROCESSING", "READY", "FAILED"] as const;

/**
 * Metadata for a stored object. Binaries live in object storage (never in the database).
 * An attachment belongs to a card and optionally to a version (media under review) or a comment.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: pk(),
    cardId: uuid()
      .notNull()
      .references((): AnyPgColumn => cards.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: uuid().references(() => assetVersions.id, { onDelete: "set null" }),
    /** The deliverable this file belongs to (null: card-level reference files). */
    deliverableId: uuid().references((): AnyPgColumn => deliverables.id, { onDelete: "cascade" }),
    commentId: uuid().references((): AnyPgColumn => comments.id, { onDelete: "set null" }),
    kind: text({ enum: ATTACHMENT_KINDS }).notNull(),
    /** VERSION: work under review · CARD: reference files · COMMENT: on a comment · RESOURCE: stands in for a Roblox asset. */
    purpose: text({ enum: ATTACHMENT_PURPOSES }).notNull().default("CARD"),
    status: text({ enum: ATTACHMENT_STATUSES }).notNull().default("PENDING"),
    storageKey: text().notNull(),
    thumbnailKey: text(),
    /** Small muted clip used for hover previews on the board. */
    previewKey: text(),
    /** Browser-friendly transcode (e.g. MOV → MP4) when the original can't play inline. */
    playbackKey: text(),
    filename: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull().default(0),
    width: integer(),
    height: integer(),
    durationMs: integer(),
    fps: real(),
    uploadedById: uuid().references(() => users.id, { onDelete: "set null" }),
    error: text(),
    /** Kind-specific derived metadata (audio details, Roblox file summary + derived preview keys). */
    meta: jsonb().$type<Record<string, unknown>>(),
    /** Viewer choices that persist with the file (e.g. which rig plays an animation). */
    previewConfig: jsonb().$type<Record<string, unknown>>(),
    processedAt: tsz(),
    archivedAt: tsz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("attachments_card_idx").on(t.cardId),
    index("attachments_version_idx").on(t.versionId),
    index("attachments_deliverable_idx").on(t.deliverableId),
    index("attachments_comment_idx").on(t.commentId),
  ],
);

/**
 * Anchors a feedback comment to an exact place in media:
 *  - POINT / REGION: normalised (0–1) coordinates on an image (or a paused video frame)
 *  - TIMESTAMP: a moment in a video (optionally with a point on that frame)
 * Always tied to the attachment (and therefore version) it was made on.
 */
export const mediaAnnotations = pgTable(
  "media_annotations",
  {
    id: pk(),
    commentId: uuid()
      .notNull()
      .references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    attachmentId: uuid()
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    versionId: uuid().references(() => assetVersions.id, { onDelete: "cascade" }),
    type: text({ enum: ["POINT", "REGION", "TIMESTAMP"] }).notNull(),
    x: real(),
    y: real(),
    width: real(),
    height: real(),
    timestampMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("media_annotations_comment_uq").on(t.commentId),
    index("media_annotations_attachment_idx").on(t.attachmentId),
  ],
);
