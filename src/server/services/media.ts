import { and, eq, inArray, isNull, lt, max, ne, sql } from "drizzle-orm";
import { descriptionImageIds, IMAGE_TOKEN, imageToken } from "@/lib/description-images";
import { DEMO_CLIP_MAX_BYTES, ITEM_VIDEO_MAX_BYTES, demoClipProblem, itemVideoProblem, type AttachmentDTO, type AttachmentPurpose } from "@/lib/types";
import { assertCard, assertItem, computeDeliverablePermissions, loadContributors, requireCard, requireDeliverable, requireItem, type CardAccess, type DeliverableAccess, type ItemAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { assetVersions, attachments, cards, checklistItems, deliverables, forumItems, reviews } from "../db/schema";
import { AppError, conflict, forbidden, invalid, notFound } from "../errors";
import { mediaQueue } from "../jobs/queue";
import { classifyUpload, maxBytesFor, sanitizeFilename, storageName } from "../media/formats";
import {
  analyzeUpload,
  buildAudioDerivatives,
  buildPlaybackTranscode,
  buildPreviewClip,
  buildRobloxManifest,
  ROBLOX_PROCESSOR,
  type ClientMediaMeta,
} from "../media/process";
import { enforceRateLimit } from "../rate-limit";
import { safeFetch } from "../security/safe-fetch";
import { attachmentKey, itemAttachmentKey, storage } from "../storage";
import type { UploadTarget } from "../storage/types";
import { logActivity } from "./activity";
import { attachmentToDTO, type AttachmentRow } from "./card-dto";
import { addWatchers, cardNotificationData, touchCard, watcherIds } from "./cards";
import type { Actor } from "./context";
import { COVER_KINDS, recomputeCardRollup, recomputeDeliverableCover } from "./deliverables";
import { Effects } from "./effects";
import { enqueueStorageCleanup, storageUnits } from "./purge";
import { notify } from "./notifications";
import { ABANDONED_UPLOAD_MS, reserveStudioStorage } from "./storage-quota";

export type UploadPurpose = "version" | "attachment" | "comment" | "resource" | "cover" | "checklist" | "item" | "demo" | "description";

/** What each kind of upload is stored as (demonstration clips are part of their revision). */
const STORED_PURPOSE: Record<UploadPurpose, AttachmentPurpose> = {
  version: "VERSION",
  demo: "VERSION",
  attachment: "CARD",
  comment: "COMMENT",
  resource: "RESOURCE",
  cover: "COVER",
  checklist: "CHECKLIST",
  item: "ITEM",
  description: "DESCRIPTION",
};

/** Forum items (bug reports, QA checks) take pictures and clips only (the kinds the list and lightbox show). */
const ITEM_KINDS = ["IMAGE", "VIDEO"] as const;

/** A card with exactly one active deliverable can be addressed by the card alone (board drops, pastes). */
async function resolveDeliverable(actor: Actor, input: { deliverableId?: string | null; cardId?: string | null }): Promise<DeliverableAccess> {
  if (input.deliverableId) return requireDeliverable(actor.userId, input.deliverableId);
  if (!input.cardId) throw invalid("Choose a deliverable.");
  const ctx = await requireCard(actor.userId, input.cardId);
  const active = await db
    .select({ id: deliverables.id })
    .from(deliverables)
    .where(and(eq(deliverables.cardId, ctx.card.id), isNull(deliverables.archivedAt)));
  if (active.length !== 1) {
    throw conflict(`This card has ${active.length} deliverables — choose which one the upload belongs to.`, { needsDeliverable: true });
  }
  return requireDeliverable(actor.userId, active[0]!.id);
}

// ── Versions ────────────────────────────────────────────────────────────────

/**
 * Starts a new revision of one deliverable. Other deliverables' files, version numbers,
 * approvals and feedback are untouched; this deliverable keeps its approved record
 * (approvedVersionId) until the new revision is itself approved.
 */
export async function createVersion(actor: Actor, input: { deliverableId?: string | null; cardId?: string | null; notes?: string }) {
  const ctx = await resolveDeliverable(actor, input);
  if (!ctx.dperms.canUpload) throw forbidden("You don't have permission to upload revisions of this deliverable.");
  const d = ctx.deliverable;
  const fx = new Effects();
  const version = await db.transaction(async (tx) => {
    const [agg] = await tx.select({ value: max(assetVersions.versionNumber) }).from(assetVersions).where(eq(assetVersions.deliverableId, d.id));
    const versionNumber = (agg?.value ?? 0) + 1;
    const [row] = await tx
      .insert(assetVersions)
      .values({ cardId: ctx.card.id, deliverableId: d.id, versionNumber, notes: input.notes?.trim() ?? "", createdById: actor.userId, createdAt: now() })
      .returning();

    // A pending submission of an older revision is superseded by the new upload.
    const superseded = await tx
      .update(assetVersions)
      .set({ status: "DRAFT" })
      .where(and(eq(assetVersions.deliverableId, d.id), eq(assetVersions.status, "IN_REVIEW"), ne(assetVersions.id, row!.id)))
      .returning({ id: assetVersions.id });
    for (const s of superseded) {
      await tx.insert(reviews).values({
        cardId: ctx.card.id,
        deliverableId: d.id,
        versionId: s.id,
        actorId: actor.userId,
        action: "WITHDRAWN",
        note: `Superseded by V${versionNumber}`,
        createdAt: now(),
      });
    }
    await tx.update(deliverables).set({ currentVersionId: row!.id, state: "IN_PROGRESS" }).where(eq(deliverables.id, d.id));
    await recomputeCardRollup(tx, ctx.card.id);
    await tx
      .update(cards)
      .set({ revision: sql`${cards.revision} + 1`, lastActivityAt: now(), lastActivityById: actor.userId })
      .where(eq(cards.id, ctx.card.id));
    await addWatchers(tx, ctx.card.id, [actor.userId]);
    fx.card(ctx.card.projectId, ctx.card.id);
    return row!;
  });
  fx.flush(actor.clientId);
  return { id: version.id, number: version.versionNumber, deliverableId: d.id };
}

export async function updateVersionNotes(actor: Actor, input: { versionId: string; notes: string }) {
  const [version] = await db.select().from(assetVersions).where(eq(assetVersions.id, input.versionId));
  if (!version) throw notFound("Version");
  const ctx = await requireDeliverable(actor.userId, version.deliverableId).catch(() => {
    throw notFound("Version");
  });
  if (!ctx.dperms.canEdit && !ctx.dperms.canUpload) throw forbidden();
  await db.update(assetVersions).set({ notes: input.notes.trim() }).where(eq(assetVersions.id, version.id));
  new Effects().card(ctx.card.projectId, ctx.card.id, false).flush(actor.clientId);
  return { ok: true };
}

/**
 * Files can be added to (or taken out of) a revision only while it's being prepared: it's the
 * deliverable's current revision and it hasn't been submitted, decided on, or superseded. Anything
 * else is review history, kept exactly as it was.
 */
export function revisionOpenProblem(version: { id: string; number: number; status: string; currentId: string | null }): string | null {
  if (version.status !== "DRAFT") {
    const what = version.status === "IN_REVIEW" ? "is waiting for review" : version.status === "APPROVED" ? "was approved" : "was reviewed";
    return `V${version.number} ${what}, so its files are kept as review history. Upload a new revision instead.`;
  }
  if (version.currentId !== version.id) return `V${version.number} is an earlier revision, so its files are kept as they were. Add files to the current revision instead.`;
  return null;
}

function assertRevisionOpen(version: { id: string; number: number; status: string; currentId: string | null }) {
  const problem = revisionOpenProblem(version);
  if (problem) throw conflict(problem);
}

// ── Upload lifecycle: create intent → browser PUT → complete ────────────────

/** A card upload (`ctx`) or a forum-item upload (`item`): exactly one is set. */
type UploadScope =
  | { ctx: CardAccess; item: null; deliverableId: string | null; checklistItemId?: string | null; versionId?: string | null; demoOfId?: string | null }
  | { ctx: null; item: ItemAccess; deliverableId: null; checklistItemId?: null; versionId?: null; demoOfId?: null };

async function assertUploadAllowed(
  actor: Actor,
  input: { cardId?: string | null; itemId?: string | null; purpose: UploadPurpose; versionId?: string | null; deliverableId?: string | null; checklistItemId?: string | null; demoOfId?: string | null },
  ex: Executor,
): Promise<UploadScope> {
  if (input.purpose === "item") {
    // A screenshot or clip on a forum item: editing the item.
    if (!input.itemId) throw invalid("An item is required.");
    const item = await requireItem(actor.userId, input.itemId, ex);
    assertItem(item.perms, "canUpload", "You don't have permission to add files here.");
    return { ctx: null, item, deliverableId: null };
  }
  if (!input.cardId) throw invalid("A card is required.");
  const ctx = await requireCard(actor.userId, input.cardId, ex);
  if (input.purpose === "comment") {
    assertCard(ctx.perms, "canComment");
    return { ctx, item: null, deliverableId: null };
  }
  if (input.purpose === "demo") {
    // A demonstration clip of a Roblox file in a revision: lands in that revision, shown inside that file's preview.
    if (!input.demoOfId) throw invalid("Choose the file the clip demonstrates.");
    if (ctx.card.productionStatus === "PUBLISHED") throw conflict("This card is published. Demonstration clips are removed once work is published, to save storage.");
    const [target] = await ex
      .select({ id: attachments.id, versionId: attachments.versionId, deliverableId: attachments.deliverableId, kind: attachments.kind, archivedAt: attachments.archivedAt })
      .from(attachments)
      .where(and(eq(attachments.id, input.demoOfId), eq(attachments.cardId, ctx.card.id)));
    if (!target || target.archivedAt || !target.versionId) throw notFound("File");
    if (target.kind !== "ROBLOX") throw invalid("Demonstration clips go with Roblox files.");
    if (target.deliverableId) {
      const [d] = await ex.select().from(deliverables).where(eq(deliverables.id, target.deliverableId));
      if (!d) throw notFound("Deliverable");
      const contributors = (await loadContributors(ex, [d.id])).get(d.id) ?? [];
      if (!computeDeliverablePermissions(ctx, d, contributors).canUpload) throw forbidden("You don't have permission to upload files to this deliverable.");
    } else {
      assertCard(ctx.perms, "canUpload", "You don't have permission to upload files to this card.");
    }
    return { ctx, item: null, deliverableId: target.deliverableId, versionId: target.versionId, demoOfId: target.id };
  }
  if (input.purpose === "checklist") {
    // A checklist item's reference image: editing the item, like its text.
    assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's checklists.");
    if (!input.checklistItemId) throw invalid("A checklist item is required.");
    const [item] = await ex
      .select({ id: checklistItems.id })
      .from(checklistItems)
      .where(and(eq(checklistItems.id, input.checklistItemId), eq(checklistItems.cardId, ctx.card.id)));
    if (!item) throw notFound("Checklist item");
    return { ctx, item: null, deliverableId: null, checklistItemId: item.id };
  }
  if (input.purpose === "description") {
    // An image in a description: editing that description (the deliverable's, else the card's).
    assertCard(ctx.perms, "canEdit", "You don't have permission to change this description.");
    if (!input.deliverableId) return { ctx, item: null, deliverableId: null };
    const [d] = await ex
      .select({ id: deliverables.id, archivedAt: deliverables.archivedAt })
      .from(deliverables)
      .where(and(eq(deliverables.id, input.deliverableId), eq(deliverables.cardId, ctx.card.id)));
    if (!d) throw notFound("Deliverable");
    if (d.archivedAt) throw conflict("This deliverable is archived. Restore it to change its description.");
    return { ctx, item: null, deliverableId: d.id };
  }
  if (input.purpose === "cover") {
    // Changing a cover is a card edit; the file belongs to no revision — and to the deliverable
    // whose cover it is, if any (else it's the card's).
    assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's cover.");
    if (!input.deliverableId) return { ctx, item: null, deliverableId: null };
    const [d] = await ex
      .select({ id: deliverables.id, archivedAt: deliverables.archivedAt })
      .from(deliverables)
      .where(and(eq(deliverables.id, input.deliverableId), eq(deliverables.cardId, ctx.card.id)));
    if (!d) throw notFound("Deliverable");
    if (d.archivedAt) throw conflict("This deliverable is archived. Restore it to change its cover.");
    return { ctx, item: null, deliverableId: d.id };
  }
  let deliverableId = input.deliverableId ?? null;
  if (input.purpose === "version") {
    if (!input.versionId) throw invalid("A revision is required.");
    const rows = await ex
      .select({ id: assetVersions.id, deliverableId: assetVersions.deliverableId, number: assetVersions.versionNumber, status: assetVersions.status, currentId: deliverables.currentVersionId })
      .from(assetVersions)
      .innerJoin(deliverables, eq(deliverables.id, assetVersions.deliverableId))
      .where(and(eq(assetVersions.id, input.versionId), eq(assetVersions.cardId, ctx.card.id)));
    if (!rows[0]) throw notFound("Version");
    // Files go into the revision being prepared; submitted (and older) revisions stay as they were reviewed.
    assertRevisionOpen(rows[0]);
    deliverableId = rows[0].deliverableId;
  }
  if (deliverableId) {
    const [d] = await ex.select().from(deliverables).where(and(eq(deliverables.id, deliverableId), eq(deliverables.cardId, ctx.card.id)));
    if (!d) throw notFound("Deliverable");
    const contributors = (await loadContributors(ex, [d.id])).get(d.id) ?? [];
    if (!computeDeliverablePermissions(ctx, d, contributors).canUpload) throw forbidden("You don't have permission to upload files to this deliverable.");
  } else {
    assertCard(ctx.perms, "canUpload", "You don't have permission to upload files to this card.");
  }
  return { ctx, item: null, deliverableId };
}

export async function createUpload(
  actor: Actor,
  input: {
    cardId?: string | null;
    itemId?: string | null;
    filename: string;
    size: number;
    contentType: string;
    purpose: UploadPurpose;
    versionId?: string | null;
    deliverableId?: string | null;
    checklistItemId?: string | null;
    demoOfId?: string | null;
  },
): Promise<{ attachmentId: string; upload: UploadTarget; maxBytes: number }> {
  enforceRateLimit(`upload:${actor.userId}`, 200, 10 * 60 * 1000);
  const scope = await assertUploadAllowed(actor, input, db);
  const { ctx, item, deliverableId, checklistItemId = null } = scope;

  const filename = sanitizeFilename(input.filename);
  const classification = classifyUpload(filename, input.contentType);
  if ("error" in classification) throw invalid(classification.error);
  if (input.purpose === "cover" && !(COVER_KINDS as readonly string[]).includes(classification.kind)) throw invalid("A cover must be an image or a video.");
  if (input.purpose === "checklist" && classification.kind !== "IMAGE") throw invalid("A checklist item's picture must be an image.");
  if (input.purpose === "description" && classification.kind !== "IMAGE") throw invalid("Only images can go in a description. Attach other files to the card or upload them as a revision.");
  if (input.purpose === "item" && !(ITEM_KINDS as readonly string[]).includes(classification.kind)) throw invalid("Forum items take images and videos.");
  if (input.purpose === "demo" && classification.kind !== "VIDEO") throw invalid("A demonstration clip must be a video.");
  const itemVideo = input.purpose === "item" && classification.kind === "VIDEO";
  const maxBytes = Math.min(maxBytesFor(classification.kind), input.purpose === "demo" ? DEMO_CLIP_MAX_BYTES : itemVideo ? ITEM_VIDEO_MAX_BYTES : Infinity);
  if (input.purpose === "demo" && demoClipProblem(input)) throw new AppError("PAYLOAD_TOO_LARGE", demoClipProblem(input)!);
  if (itemVideo && itemVideoProblem({ size: input.size, name: filename })) throw new AppError("PAYLOAD_TOO_LARGE", itemVideoProblem({ size: input.size, name: filename })!);
  if (input.size > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `${filename} is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit for this file type.`);
  }
  if (input.size <= 0) throw invalid(`${filename} is empty.`);

  const id = crypto.randomUUID();
  const studioId = ctx ? ctx.access.studioId : item.access.studioId;
  const projectId = ctx ? ctx.card.projectId : item.item.projectId;
  const name = `original-${storageName(filename)}`;
  const key = ctx
    ? attachmentKey({ studioId, projectId, cardId: ctx.card.id, attachmentId: id, name })
    : itemAttachmentKey({ studioId, projectId, itemId: item.item.id, attachmentId: id, name });
  const purpose = STORED_PURPOSE[input.purpose];
  await db.transaction(async (tx) => {
    // Counts against the studio's storage limit from now on (until finished or abandoned).
    await reserveStudioStorage(tx, studioId, input.size);
    await tx.insert(attachments).values({
      id,
      cardId: ctx?.card.id ?? null,
      itemId: item?.item.id ?? null,
      projectId,
      versionId: input.purpose === "version" ? input.versionId! : (scope.versionId ?? null),
      deliverableId,
      checklistItemId,
      demoOfId: scope.demoOfId ?? null,
      purpose,
      kind: classification.kind,
      status: "PENDING",
      storageKey: key,
      filename,
      mimeType: classification.mimeType,
      sizeBytes: input.size,
      uploadedById: actor.userId,
      createdAt: now(),
    });
  });
  const upload = await storage().createUploadTarget(key, { contentType: classification.mimeType, attachmentId: id, size: input.size });
  return { attachmentId: id, upload, maxBytes };
}

async function loadAttachment(attachmentId: string) {
  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!attachment) throw notFound("Attachment");
  return attachment;
}

/** A card's attachment with the caller's card access. Files on forum items are managed through the item (services/forums). */
async function loadAttachmentForWrite(actor: Actor, attachmentId: string) {
  const attachment = await loadAttachment(attachmentId);
  if (!attachment.cardId) throw notFound("Attachment");
  const ctx = await requireCard(actor.userId, attachment.cardId);
  return { attachment, ctx };
}

/** Re-derives covers for the deliverable an attachment belongs to, then the card (item files have no covers). */
async function recomputeCovers(tx: Executor, attachment: Pick<AttachmentRow, "cardId" | "deliverableId">) {
  if (!attachment.cardId) return;
  if (attachment.deliverableId) await recomputeDeliverableCover(tx, attachment.deliverableId);
  await recomputeCardRollup(tx, attachment.cardId);
}

function finishBackground(attachmentId: string, projectId: string, cardId: string | null, patch: Partial<AttachmentRow>) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(attachments)
      .set({ ...patch, status: "READY", processedAt: now() })
      .where(eq(attachments.id, attachmentId))
      .returning();
    if (row) await recomputeCovers(tx, row);
    const fx = new Effects();
    if (cardId) fx.card(projectId, cardId);
    else fx.item(projectId, row?.itemId);
    fx.flush();
  });
}

function scheduleVideoWork(attachment: AttachmentRow, projectId: string, cardId: string | null, work: { preview: boolean; transcode: boolean }) {
  if (!work.preview && !work.transcode) return;
  mediaQueue.enqueue(`video:${attachment.id}`, async () => {
    const patch: Partial<AttachmentRow> = {};
    try {
      if (work.transcode) patch.playbackKey = await buildPlaybackTranscode(attachment.storageKey);
      if (work.preview) patch.previewKey = await buildPreviewClip(patch.playbackKey ?? attachment.storageKey);
    } catch (error) {
      console.error("[forge] background video processing failed", error);
    }
    await finishBackground(attachment.id, projectId, cardId, patch);
  });
}

function scheduleAudioWork(attachment: AttachmentRow, projectId: string, cardId: string | null) {
  mediaQueue.enqueue(`audio:${attachment.id}`, async () => {
    const result = await buildAudioDerivatives(attachment.storageKey, attachment.mimeType);
    if (result.error) console.error("[forge] audio processing failed", result.error);
    const meta = { ...(attachment.meta ?? {}), ...(result.derivedKey ? { derivedKey: result.derivedKey } : { waveformError: "The waveform couldn't be generated." }) };
    await finishBackground(attachment.id, projectId, cardId, {
      meta,
      thumbnailKey: result.thumbnailKey ?? attachment.thumbnailKey,
      playbackKey: result.playbackKey,
      durationMs: attachment.durationMs ?? result.durationMs,
    });
  });
}

export function scheduleRobloxWork(attachment: Pick<AttachmentRow, "id" | "storageKey" | "meta">, projectId: string, cardId: string | null) {
  mediaQueue.enqueue(`roblox:${attachment.id}`, async () => {
    const derived = await buildRobloxManifest(attachment.storageKey);
    await finishBackground(attachment.id, projectId, cardId, { meta: { format: attachment.meta?.format, ...derived } });
  });
}

/** The stored object is there and within limits, and what it turned out to be (dimensions, thumbnail…). */
async function inspectStoredUpload(attachment: AttachmentRow, clientMeta: ClientMediaMeta | undefined) {
  const store = storage();
  const stat = await store.stat(attachment.storageKey);
  if (!stat) throw invalid("The upload didn't reach storage. Please retry.");
  // What actually landed in storage, not what the client declared.
  const itemVideo = Boolean(attachment.itemId) && attachment.kind === "VIDEO";
  const maxBytes = Math.min(maxBytesFor(attachment.kind), attachment.demoOfId ? DEMO_CLIP_MAX_BYTES : itemVideo ? ITEM_VIDEO_MAX_BYTES : Infinity);
  if (stat.size > maxBytes) {
    await store.delete(attachment.storageKey).catch(() => {});
    const why = attachment.demoOfId
      ? (demoClipProblem(stat) ?? "That clip passes the 20 MB limit for demonstration clips.")
      : itemVideo
        ? (itemVideoProblem(stat) ?? "That video passes the 12 MB limit for forum clips. Post it on Discord and paste the link instead.")
        : "That file is larger than the allowed limit.";
    await db.update(attachments).set({ status: "FAILED", error: why }).where(eq(attachments.id, attachment.id));
    throw new AppError("PAYLOAD_TOO_LARGE", why);
  }

  let analysis;
  try {
    analysis = await analyzeUpload(attachment, clientMeta);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "We couldn't process this file.";
    await db.update(attachments).set({ status: "FAILED", error: message }).where(eq(attachments.id, attachment.id));
    if (!(error instanceof AppError)) console.error("[forge] media analysis failed", error);
    throw error instanceof AppError ? error : invalid(message);
  }
  return { stat, analysis };
}

/** A finished upload on a forum item: becomes one of its pictures or clips (no revisions, no covers). */
async function completeItemUpload(actor: Actor, attachment: AttachmentRow, clientMeta: ClientMediaMeta | undefined): Promise<AttachmentDTO> {
  const { item, forum, access } = await requireItem(actor.userId, attachment.itemId!);
  if (attachment.uploadedById !== actor.userId) throw forbidden("Only the uploader can finish this upload.");
  if (attachment.status !== "PENDING") return attachmentToDTO(attachment);
  const { stat, analysis } = await inspectStoredUpload(attachment, clientMeta);
  if (!(ITEM_KINDS as readonly string[]).includes(analysis.kind)) {
    await db.update(attachments).set({ status: "FAILED", error: "Forum items take images and videos." }).where(eq(attachments.id, attachment.id));
    throw invalid("Forum items take images and videos.");
  }
  const background = { preview: analysis.wantsPreview, transcode: analysis.needsTranscode };
  const fx = new Effects();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(attachments)
      .set({
        kind: analysis.kind,
        mimeType: analysis.mimeType,
        sizeBytes: stat.size,
        width: analysis.width,
        height: analysis.height,
        durationMs: analysis.durationMs,
        fps: analysis.fps,
        thumbnailKey: analysis.thumbnailKey,
        meta: analysis.meta,
        status: background.transcode ? "PROCESSING" : "READY",
        processedAt: now(),
        error: null,
      })
      .where(eq(attachments.id, attachment.id))
      .returning();
    await logActivity(tx, {
      studioId: access.studioId,
      projectId: item.projectId,
      itemId: item.id,
      actorId: actor.userId,
      type: "item.attachment_added",
      data: { filename: attachment.filename, kind: analysis.kind, noun: forum.itemLabel },
    });
    await tx.update(forumItems).set({ lastActivityAt: now() }).where(eq(forumItems.id, item.id));
    fx.item(item.projectId, item.id);
    return row!;
  });
  fx.flush(actor.clientId);
  if (updated.kind === "VIDEO") scheduleVideoWork(updated, item.projectId, null, background);
  return attachmentToDTO(updated);
}

export async function completeUpload(
  actor: Actor,
  /** `addedToRevision`: the file was added to a revision that already had files (not uploaded with it). */
  input: { attachmentId: string; clientMeta?: ClientMediaMeta; addedToRevision?: boolean },
): Promise<AttachmentDTO> {
  const pending = await loadAttachment(input.attachmentId);
  if (pending.itemId && !pending.cardId) return completeItemUpload(actor, pending, input.clientMeta);
  const { attachment, ctx } = await loadAttachmentForWrite(actor, input.attachmentId);
  if (attachment.uploadedById !== actor.userId) throw forbidden("Only the uploader can finish this upload.");
  if (attachment.status !== "PENDING") return attachmentToDTO(attachment);
  const { stat, analysis } = await inspectStoredUpload(attachment, input.clientMeta);

  const background = { preview: analysis.wantsPreview, transcode: analysis.needsTranscode };
  const processing = background.transcode || analysis.derive !== null;
  const fx = new Effects();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(attachments)
      .set({
        kind: analysis.kind,
        mimeType: analysis.mimeType,
        sizeBytes: stat.size,
        width: analysis.width,
        height: analysis.height,
        durationMs: analysis.durationMs,
        fps: analysis.fps,
        thumbnailKey: analysis.thumbnailKey,
        meta: analysis.meta,
        status: processing ? "PROCESSING" : "READY",
        processedAt: now(),
        error: null,
      })
      .where(eq(attachments.id, attachment.id))
      .returning();

    if (row!.purpose === "VERSION" || row!.purpose === "CARD") await recomputeCovers(tx, row!);

    if (attachment.purpose === "VERSION" && attachment.versionId && attachment.demoOfId) {
      // A demonstration clip: part of the revision, but not a new upload of the work itself.
      await logActivity(tx, {
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        actorId: actor.userId,
        type: "attachment.added",
        data: { filename: attachment.filename, kind: analysis.kind, demo: true },
      });
    } else if (attachment.purpose === "VERSION" && attachment.versionId) {
      const [readyCount] = await tx
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(attachments)
        .where(and(eq(attachments.versionId, attachment.versionId), eq(attachments.status, "READY"), ne(attachments.id, attachment.id)));
      const [version] = await tx.select().from(assetVersions).where(eq(assetVersions.id, attachment.versionId));
      const [d] = version ? await tx.select().from(deliverables).where(eq(deliverables.id, version.deliverableId)) : [];
      const [activeCount] = await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(deliverables)
        .where(and(eq(deliverables.cardId, ctx.card.id), isNull(deliverables.archivedAt)));
      const scoped = d && (activeCount?.n ?? 1) > 1 ? d.name : undefined;
      if (input.addedToRevision && (readyCount?.value ?? 0) > 0) {
        // Added later to a revision that's still being prepared: history says so (no one is notified).
        await logActivity(tx, {
          studioId: ctx.access.studioId,
          projectId: ctx.card.projectId,
          cardId: ctx.card.id,
          actorId: actor.userId,
          type: "version.file_added",
          data: { versionNumber: version?.versionNumber ?? null, filename: attachment.filename, deliverable: scoped, deliverableId: d?.id },
        });
      } else if ((readyCount?.value ?? 0) === 0) {
        await logActivity(tx, {
          studioId: ctx.access.studioId,
          projectId: ctx.card.projectId,
          cardId: ctx.card.id,
          actorId: actor.userId,
          type: "version.uploaded",
          data: { versionNumber: version?.versionNumber ?? null, filename: attachment.filename, kind: analysis.kind, deliverable: scoped, deliverableId: d?.id },
        });
        fx.notify(
          await notify(tx, {
            recipientIds: await watcherIds(tx, ctx.card.id),
            actorId: actor.userId,
            type: "WATCHED_CARD",
            studioId: ctx.access.studioId,
            projectId: ctx.card.projectId,
            cardId: ctx.card.id,
            deliverableId: d?.id ?? null,
            versionId: version?.id ?? null,
            data: { ...cardNotificationData(ctx.access, ctx.card), change: `uploaded ${scoped ? `${scoped} ` : ""}V${version?.versionNumber ?? "?"}` },
          }),
        );
      }
      if (d && d.state === "NOT_SUBMITTED") {
        await tx.update(deliverables).set({ state: "IN_PROGRESS" }).where(eq(deliverables.id, d.id));
        await recomputeCardRollup(tx, ctx.card.id);
      }
    } else if (attachment.purpose === "COVER") {
      // Uploaded to be the cover: becomes it now (no revision, no review state change).
      if (!(COVER_KINDS as readonly string[]).includes(row!.kind)) throw invalid("A cover must be an image or a video.");
      if (row!.deliverableId) await pinDeliverableCover(tx, ctx, row!.deliverableId, row!.id, actor.userId);
      else await pinCover(tx, ctx, row!.id, actor.userId);
    } else if (attachment.purpose === "DESCRIPTION") {
      // Shown once the description that refers to it is saved (see syncDescriptionImages).
      if (row!.kind !== "IMAGE") throw invalid("Only images can go in a description.");
    } else if (attachment.purpose === "CHECKLIST") {
      // Becomes its item's picture now, replacing the one before.
      if (row!.kind !== "IMAGE") throw invalid("A checklist item's picture must be an image.");
      if (row!.checklistItemId) await retireChecklistImages(tx, row!.checklistItemId, row!.id);
    } else if (attachment.purpose === "CARD") {
      await logActivity(tx, {
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        actorId: actor.userId,
        type: "attachment.added",
        data: { filename: attachment.filename, kind: analysis.kind },
      });
    }
    await touchCard(tx, ctx.card.id, actor.userId);
    fx.card(ctx.card.projectId, ctx.card.id);
    return row!;
  });
  fx.flush(actor.clientId);
  if (updated.kind === "VIDEO") scheduleVideoWork(updated, ctx.card.projectId, ctx.card.id, background);
  if (analysis.derive === "audio") scheduleAudioWork(updated, ctx.card.projectId, ctx.card.id);
  if (analysis.derive === "roblox") scheduleRobloxWork(updated, ctx.card.projectId, ctx.card.id);
  return attachmentToDTO(updated);
}

export async function importFromUrl(
  actor: Actor,
  input: { cardId: string; url: string; purpose: UploadPurpose; versionId?: string | null; deliverableId?: string | null },
): Promise<AttachmentDTO> {
  enforceRateLimit(`import:${actor.userId}`, 30, 10 * 60 * 1000);
  await assertUploadAllowed(actor, input, db);
  const maxBytes = maxBytesFor("IMAGE");
  const fetched = await safeFetch(input.url, { maxBytes });
  const lastSegment = new URL(fetched.finalUrl).pathname.split("/").pop() || "image";
  // A malformed escape ("%E0%A4%A") in someone else's URL just keeps the raw name.
  const urlName = (() => {
    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  })();
  const contentType = fetched.contentType.split(";")[0]!.trim();
  if (!contentType.startsWith("image/")) throw invalid("That link doesn't point to an image.");
  const extension = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const filename = sanitizeFilename(/\.[a-z0-9]{2,5}$/i.test(urlName) ? urlName : `${urlName}.${extension}`);

  const intent = await createUpload(actor, {
    cardId: input.cardId,
    filename,
    size: fetched.buffer.length,
    contentType,
    purpose: input.purpose,
    versionId: input.versionId,
    deliverableId: input.deliverableId,
  });
  const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
  await storage().put(row!.storageKey, fetched.buffer, row!.mimeType);
  // One image at a time: into a revision that already has files, it's an addition to it.
  return completeUpload(actor, { attachmentId: intent.attachmentId, addedToRevision: input.purpose === "version" });
}

/**
 * Permanently removes every demonstration clip on a card (the work is published, so the clips
 * have done their job and only cost storage). Feedback left on a clip stays as plain revision
 * feedback. Returns what was removed.
 */
export async function deleteDemoClips(tx: Executor, cardId: string): Promise<{ id: string; filename: string }[]> {
  const clips = await tx
    .select({ id: attachments.id, filename: attachments.filename, storageKey: attachments.storageKey, thumbnailKey: attachments.thumbnailKey, previewKey: attachments.previewKey, playbackKey: attachments.playbackKey })
    .from(attachments)
    .where(and(eq(attachments.cardId, cardId), sql`${attachments.demoOfId} is not null`));
  if (!clips.length) return [];
  await tx.delete(attachments).where(
    inArray(
      attachments.id,
      clips.map((c) => c.id),
    ),
  );
  await enqueueStorageCleanup(tx, [...new Set(clips.flatMap(storageUnits))], `demo clips of card ${cardId} removed on publish`);
  return clips.map((c) => ({ id: c.id, filename: c.filename }));
}

/**
 * A file of a revision (not a demonstration clip): who may take it out or put it back, and whether
 * the revision still allows it. People who can upload to the deliverable manage its files, as do
 * card editors; only the revision being prepared can change (see revisionOpenProblem).
 */
async function revisionFileAccess(ctx: CardAccess, attachment: AttachmentRow, verb: "remove" | "restore") {
  const [row] = await db
    .select({ version: assetVersions, deliverable: deliverables })
    .from(assetVersions)
    .innerJoin(deliverables, eq(deliverables.id, assetVersions.deliverableId))
    .where(eq(assetVersions.id, attachment.versionId!));
  if (!row) throw notFound("Version");
  const contributors = (await loadContributors(db, [row.deliverable.id])).get(row.deliverable.id) ?? [];
  const dperms = computeDeliverablePermissions(ctx, row.deliverable, contributors);
  if (!dperms.canUpload && !ctx.perms.canEdit) throw forbidden(`Only people who can upload to ${row.deliverable.name} can ${verb} its files.`);
  const problem = revisionOpenProblem({ id: row.version.id, number: row.version.versionNumber, status: row.version.status, currentId: row.deliverable.currentVersionId });
  if (problem) throw conflict(verb === "remove" ? problem : problem.replace("its files are kept", "files can't be put back into it, and its files are kept"));
  return row;
}

export async function archiveAttachment(actor: Actor, input: { attachmentId: string }) {
  const { attachment, ctx } = await loadAttachmentForWrite(actor, input.attachmentId);
  const revisionFile = Boolean(attachment.versionId && !attachment.demoOfId);
  const own = attachment.uploadedById === actor.userId;
  // Work under review is part of the revision history and is never removed (demonstration clips can be swapped).
  const revision = revisionFile ? await revisionFileAccess(ctx, attachment, "remove") : null;
  if (!revision && !(ctx.perms.canEdit || (own && ctx.perms.canComment))) throw forbidden("You can't remove this attachment.");
  if (attachment.archivedAt) return { ok: true };
  await db.transaction(async (tx) => {
    await tx.update(attachments).set({ archivedAt: now() }).where(eq(attachments.id, attachment.id));
    await recomputeCovers(tx, attachment);
    if (revision) {
      await logActivity(tx, {
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        actorId: actor.userId,
        type: "attachment.removed",
        data: { filename: attachment.filename, versionNumber: revision.version.versionNumber, deliverable: revision.deliverable.name, deliverableId: revision.deliverable.id },
      });
    }
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

/** Brings an archived file back (archiving is reversible until someone deletes it permanently). */
export async function restoreAttachment(actor: Actor, input: { attachmentId: string }) {
  const { attachment, ctx } = await loadAttachmentForWrite(actor, input.attachmentId);
  const own = attachment.uploadedById === actor.userId;
  const revision = attachment.versionId && !attachment.demoOfId ? await revisionFileAccess(ctx, attachment, "restore") : null;
  if (!revision && !(ctx.perms.canEdit || (own && ctx.perms.canComment))) throw forbidden("You can't restore this attachment.");
  if (!attachment.archivedAt) return { ok: true };
  await db.transaction(async (tx) => {
    await tx.update(attachments).set({ archivedAt: null }).where(eq(attachments.id, attachment.id));
    await recomputeCovers(tx, attachment);
    if (revision) {
      await logActivity(tx, {
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        actorId: actor.userId,
        type: "attachment.restored",
        data: { filename: attachment.filename, versionNumber: revision.version.versionNumber, deliverable: revision.deliverable.name, deliverableId: revision.deliverable.id },
      });
    }
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

// ── Checklist item pictures ─────────────────────────────────────────────────

/** Archives a checklist item's pictures (all of them, or all but `keep`); the stored files stay. */
export async function retireChecklistImages(tx: Executor, checklistItemId: string | string[], keep: string | null = null) {
  const ids = Array.isArray(checklistItemId) ? checklistItemId : [checklistItemId];
  if (!ids.length) return;
  await tx
    .update(attachments)
    .set({ archivedAt: now() })
    .where(
      and(
        inArray(attachments.checklistItemId, ids),
        eq(attachments.purpose, "CHECKLIST"),
        isNull(attachments.archivedAt),
        keep ? ne(attachments.id, keep) : undefined,
      ),
    );
}

// ── Card covers ─────────────────────────────────────────────────────────────

/**
 * A cover upload that is no longer the cover has no other use: archive it (the stored file stays).
 * `deliverableId` says whose cover it was (null: the card's) — one never retires the other's.
 */
async function retireCoverUpload(tx: Executor, cardId: string, attachmentId: string | null, keep: string | null, deliverableId: string | null = null) {
  if (!attachmentId || attachmentId === keep) return;
  await tx
    .update(attachments)
    .set({ archivedAt: now() })
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.cardId, cardId),
        eq(attachments.purpose, "COVER"),
        deliverableId ? eq(attachments.deliverableId, deliverableId) : isNull(attachments.deliverableId),
        isNull(attachments.archivedAt),
      ),
    );
}

/** Makes an attachment the card's chosen cover (inside the caller's transaction). */
async function pinCover(tx: Executor, ctx: CardAccess, attachmentId: string, actorId: string) {
  const [card] = await tx.select({ pinned: cards.coverPinnedId }).from(cards).where(eq(cards.id, ctx.card.id));
  await retireCoverUpload(tx, ctx.card.id, card?.pinned ?? null, attachmentId);
  await tx.update(cards).set({ coverMode: "MANUAL", coverPinnedId: attachmentId }).where(eq(cards.id, ctx.card.id));
  await recomputeCardRollup(tx, ctx.card.id);
  const [file] = await tx.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.id, attachmentId));
  await logActivity(tx, {
    studioId: ctx.access.studioId,
    projectId: ctx.card.projectId,
    cardId: ctx.card.id,
    actorId,
    type: "card.cover_changed",
    data: { mode: "MANUAL", filename: file?.filename ?? "" },
  });
}

/**
 * Uses an image or video already on the card (a reference file, a revision's file or an
 * earlier cover upload) as its board cover. It stays the cover through new revisions,
 * processing and review changes until someone changes it.
 */
export async function setCover(actor: Actor, input: { cardId: string; attachmentId: string }) {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's cover.");
  const [attachment] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, input.attachmentId), eq(attachments.cardId, ctx.card.id), isNull(attachments.archivedAt)));
  // Files on other cards (even ones the actor can see) are "not found" here, never borrowed; nor is
  // an image uploaded as a deliverable's cover or put in its description (that deliverable may
  // replace it any time). The card's own description images can be its cover.
  if (!attachment || !["CARD", "VERSION", "COVER", "DESCRIPTION"].includes(attachment.purpose) || ((attachment.purpose === "COVER" || attachment.purpose === "DESCRIPTION") && attachment.deliverableId)) throw notFound("File");
  if (!(COVER_KINDS as readonly string[]).includes(attachment.kind)) throw invalid("Only an image or a video can be the cover.");
  if (attachment.status === "FAILED" || attachment.status === "PENDING") throw conflict("That file hasn't finished uploading, so it can't be the cover yet.");
  await db.transaction(async (tx) => {
    await pinCover(tx, ctx, attachment.id, actor.userId);
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

/** AUTO: back to the automatic cover (the first deliverable's current file). NONE: no cover. */
export async function setCoverMode(actor: Actor, input: { cardId: string; mode: "AUTO" | "NONE" }) {
  const ctx = await requireCard(actor.userId, input.cardId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's cover.");
  await db.transaction(async (tx) => {
    const [card] = await tx.select({ pinned: cards.coverPinnedId }).from(cards).where(eq(cards.id, ctx.card.id));
    await retireCoverUpload(tx, ctx.card.id, card?.pinned ?? null, null);
    await tx.update(cards).set({ coverMode: input.mode, coverPinnedId: null }).where(eq(cards.id, ctx.card.id));
    await recomputeCardRollup(tx, ctx.card.id);
    await logActivity(tx, { studioId: ctx.access.studioId, projectId: ctx.card.projectId, cardId: ctx.card.id, actorId: actor.userId, type: "card.cover_changed", data: { mode: input.mode } });
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

// ── Deliverable covers ──────────────────────────────────────────────────────

/** Makes an image or video the deliverable's chosen cover (inside the caller's transaction). */
async function pinDeliverableCover(tx: Executor, ctx: CardAccess, deliverableId: string, attachmentId: string, actorId: string) {
  const [d] = await tx.select({ name: deliverables.name, pinned: deliverables.coverPinnedId }).from(deliverables).where(eq(deliverables.id, deliverableId));
  if (!d) throw notFound("Deliverable");
  await retireCoverUpload(tx, ctx.card.id, d.pinned, attachmentId, deliverableId);
  await tx.update(deliverables).set({ coverMode: "MANUAL", coverPinnedId: attachmentId }).where(eq(deliverables.id, deliverableId));
  await recomputeDeliverableCover(tx, deliverableId);
  // The card's automatic cover follows its first deliverable's cover.
  await recomputeCardRollup(tx, ctx.card.id);
  const [file] = await tx.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.id, attachmentId));
  await logActivity(tx, {
    studioId: ctx.access.studioId,
    projectId: ctx.card.projectId,
    cardId: ctx.card.id,
    actorId,
    type: "deliverable.cover_changed",
    data: { deliverableId, deliverable: d.name, mode: "MANUAL", filename: file?.filename ?? "" },
  });
}

async function editableDeliverable(actor: Actor, deliverableId: string) {
  const ctx = await requireDeliverable(actor.userId, deliverableId);
  assertCard(ctx.perms, "canEdit", "You don't have permission to change this deliverable's cover.");
  if (ctx.deliverable.archivedAt) throw conflict("This deliverable is archived. Restore it to change its cover.");
  return ctx;
}

/**
 * Uses one of the deliverable's own images or videos (from any of its revisions, its description,
 * or an earlier cover upload) as its cover. It stays through new revisions and reviews until
 * someone changes it — or the file goes (a description image taken out of the description, say),
 * when the automatic cover shows instead.
 */
export async function setDeliverableCover(actor: Actor, input: { deliverableId: string; attachmentId: string }) {
  const ctx = await editableDeliverable(actor, input.deliverableId);
  const [attachment] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, input.attachmentId), eq(attachments.deliverableId, ctx.deliverable.id), isNull(attachments.archivedAt)));
  // Another deliverable's or card's files are "not found" here, never borrowed.
  if (!attachment || !["VERSION", "COVER", "DESCRIPTION"].includes(attachment.purpose)) throw notFound("File");
  if (!(COVER_KINDS as readonly string[]).includes(attachment.kind)) throw invalid("Only an image or a video can be the cover.");
  if (attachment.status === "FAILED" || attachment.status === "PENDING") throw conflict("That file hasn't finished uploading, so it can't be the cover yet.");
  await db.transaction(async (tx) => {
    await pinDeliverableCover(tx, ctx, ctx.deliverable.id, attachment.id, actor.userId);
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

/** AUTO: back to its current file. NONE: no cover. */
export async function setDeliverableCoverMode(actor: Actor, input: { deliverableId: string; mode: "AUTO" | "NONE" }) {
  const ctx = await editableDeliverable(actor, input.deliverableId);
  await db.transaction(async (tx) => {
    await retireCoverUpload(tx, ctx.card.id, ctx.deliverable.coverPinnedId, null, ctx.deliverable.id);
    await tx.update(deliverables).set({ coverMode: input.mode, coverPinnedId: null }).where(eq(deliverables.id, ctx.deliverable.id));
    await recomputeDeliverableCover(tx, ctx.deliverable.id);
    await recomputeCardRollup(tx, ctx.card.id);
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "deliverable.cover_changed",
      data: { deliverableId: ctx.deliverable.id, deliverable: ctx.deliverable.name, mode: input.mode },
    });
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

// ── Description images ──────────────────────────────────────────────────────

/**
 * After a description is saved: its images that the text no longer shows are archived (they stay
 * restorable until deleted permanently, like any file), and ones it shows again come back. Covers
 * are re-derived, so a cover that was one of those images falls back to the automatic one.
 */
export async function syncDescriptionImages(tx: Executor, cardId: string, deliverableId: string | null, text: string) {
  const shown = new Set(descriptionImageIds(text));
  const rows = await tx
    .select({ id: attachments.id, archivedAt: attachments.archivedAt })
    .from(attachments)
    .where(and(eq(attachments.cardId, cardId), eq(attachments.purpose, "DESCRIPTION"), deliverableId ? eq(attachments.deliverableId, deliverableId) : isNull(attachments.deliverableId)));
  const hide = rows.filter((r) => !r.archivedAt && !shown.has(r.id)).map((r) => r.id);
  const show = rows.filter((r) => r.archivedAt && shown.has(r.id)).map((r) => r.id);
  if (hide.length) await tx.update(attachments).set({ archivedAt: now() }).where(inArray(attachments.id, hide));
  if (show.length) await tx.update(attachments).set({ archivedAt: null }).where(inArray(attachments.id, show));
  if (!hide.length && !show.length) return;
  if (deliverableId) await recomputeDeliverableCover(tx, deliverableId);
  await recomputeCardRollup(tx, cardId);
}

/** Copies description images to a duplicated card or deliverable (sharing the stored files) and points its text at the copies. */
export async function copyDescriptionImages(tx: Executor, from: { cardId: string; deliverableId: string | null }, to: { cardId: string; deliverableId: string | null }, text: string): Promise<string> {
  const ids = descriptionImageIds(text);
  if (!ids.length) return text;
  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.cardId, from.cardId),
        eq(attachments.purpose, "DESCRIPTION"),
        from.deliverableId ? eq(attachments.deliverableId, from.deliverableId) : isNull(attachments.deliverableId),
        inArray(attachments.id, ids),
        isNull(attachments.archivedAt),
      ),
    );
  const map = new Map<string, string>();
  for (const a of rows) {
    const { id, createdAt: _c, updatedAt: _u, ...rest } = a;
    const [copy] = await tx.insert(attachments).values({ ...rest, cardId: to.cardId, deliverableId: to.deliverableId, createdAt: now() }).returning({ id: attachments.id });
    map.set(id, copy!.id);
  }
  return text.replace(IMAGE_TOKEN, (whole, name: string, id: string) => (map.has(id.toLowerCase()) ? imageToken(name, map.get(id.toLowerCase())!) : whole));
}

// ── Recovery after restarts ─────────────────────────────────────────────────

const PLAYABLE_VIDEO = new Set(["video/mp4", "video/webm", "video/x-m4v"]);

/**
 * The media queue lives in memory, so a restart loses queued work. Run once at startup (by the
 * single worker process): files left mid-processing are queued again, Roblox previews made by
 * an older reader are rebuilt in the background (the original upload is never touched), and
 * uploads that were started but never finished free their storage.
 */
export async function recoverMediaJobs(at: Date = now()) {
  const pending = await db
    .select({ a: attachments, projectId: attachments.projectId })
    .from(attachments)
    .where(and(eq(attachments.status, "PROCESSING"), isNull(attachments.archivedAt)));
  for (const { a, projectId } of pending) {
    if (a.kind === "ROBLOX") scheduleRobloxWork(a, projectId, a.cardId);
    else if (a.kind === "AUDIO") scheduleAudioWork(a, projectId, a.cardId);
    else if (a.kind === "VIDEO") scheduleVideoWork(a, projectId, a.cardId, { preview: !a.previewKey && (a.durationMs ?? 0) > 500, transcode: !a.playbackKey && !PLAYABLE_VIDEO.has(a.mimeType) });
    else await finishBackground(a.id, projectId, a.cardId, {});
  }

  const stale = await db
    .select({ a: attachments, projectId: attachments.projectId })
    .from(attachments)
    .where(
      and(
        eq(attachments.kind, "ROBLOX"),
        eq(attachments.status, "READY"),
        isNull(attachments.archivedAt),
        sql`coalesce(${attachments.meta}->>'processor', '') <> ${ROBLOX_PROCESSOR}`,
        sql`${attachments.meta}->>'previewError' is null`,
      ),
    );
  for (const { a, projectId } of stale) {
    await db.update(attachments).set({ status: "PROCESSING" }).where(eq(attachments.id, a.id));
    scheduleRobloxWork(a, projectId, a.cardId);
  }

  const abandoned = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.status, "PENDING"), lt(attachments.createdAt, new Date(at.getTime() - ABANDONED_UPLOAD_MS))))
    .limit(500);
  for (const a of abandoned) {
    await storage().delete(a.storageKey).catch(() => {});
    await db.update(attachments).set({ status: "FAILED", error: "The upload was never finished." }).where(eq(attachments.id, a.id));
  }
  return { requeued: pending.length, robloxUpgrades: stale.length, abandonedUploads: abandoned.length };
}

/** Used by the local upload endpoint to authorise the PUT. */
export async function getPendingUpload(attachmentId: string) {
  const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  return row ?? null;
}
