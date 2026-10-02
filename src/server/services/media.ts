import { and, eq, isNull, lt, max, ne, sql } from "drizzle-orm";
import type { AttachmentDTO } from "@/lib/types";
import { assertCard, computeDeliverablePermissions, requireCard, requireDeliverable, type CardAccess, type DeliverableAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { assetVersions, attachments, cards, deliverables, reviews } from "../db/schema";
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
import { attachmentKey, storage } from "../storage";
import type { UploadTarget } from "../storage/types";
import { logActivity } from "./activity";
import { attachmentToDTO, type AttachmentRow } from "./card-dto";
import { addWatchers, cardNotificationData, touchCard, watcherIds } from "./cards";
import type { Actor } from "./context";
import { COVER_KINDS, recomputeCardRollup, recomputeDeliverableCover } from "./deliverables";
import { Effects } from "./effects";
import { notify } from "./notifications";
import { ABANDONED_UPLOAD_MS, reserveStudioStorage } from "./storage-quota";

export type UploadPurpose = "version" | "attachment" | "comment" | "resource" | "cover";

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

// ── Upload lifecycle: create intent → browser PUT → complete ────────────────

interface UploadScope {
  ctx: CardAccess;
  deliverableId: string | null;
}

async function assertUploadAllowed(
  actor: Actor,
  input: { cardId: string; purpose: UploadPurpose; versionId?: string | null; deliverableId?: string | null },
  ex: Executor,
): Promise<UploadScope> {
  const ctx = await requireCard(actor.userId, input.cardId, ex);
  if (input.purpose === "comment") {
    assertCard(ctx.perms, "canComment");
    return { ctx, deliverableId: null };
  }
  if (input.purpose === "cover") {
    // Changing the cover is a card edit; the file belongs to no deliverable or revision.
    assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's cover.");
    return { ctx, deliverableId: null };
  }
  let deliverableId = input.deliverableId ?? null;
  if (input.purpose === "version") {
    if (!input.versionId) throw invalid("A revision is required.");
    const rows = await ex
      .select({ id: assetVersions.id, deliverableId: assetVersions.deliverableId })
      .from(assetVersions)
      .where(and(eq(assetVersions.id, input.versionId), eq(assetVersions.cardId, ctx.card.id)));
    if (!rows[0]) throw notFound("Version");
    deliverableId = rows[0].deliverableId;
  }
  if (deliverableId) {
    const [d] = await ex.select().from(deliverables).where(and(eq(deliverables.id, deliverableId), eq(deliverables.cardId, ctx.card.id)));
    if (!d) throw notFound("Deliverable");
    if (!computeDeliverablePermissions(ctx, d).canUpload) throw forbidden("You don't have permission to upload files to this deliverable.");
  } else {
    assertCard(ctx.perms, "canUpload", "You don't have permission to upload files to this card.");
  }
  return { ctx, deliverableId };
}

export async function createUpload(
  actor: Actor,
  input: {
    cardId: string;
    filename: string;
    size: number;
    contentType: string;
    purpose: UploadPurpose;
    versionId?: string | null;
    deliverableId?: string | null;
  },
): Promise<{ attachmentId: string; upload: UploadTarget; maxBytes: number }> {
  enforceRateLimit(`upload:${actor.userId}`, 200, 10 * 60 * 1000);
  const { ctx, deliverableId } = await assertUploadAllowed(actor, input, db);

  const filename = sanitizeFilename(input.filename);
  const classification = classifyUpload(filename, input.contentType);
  if ("error" in classification) throw invalid(classification.error);
  if (input.purpose === "cover" && !(COVER_KINDS as readonly string[]).includes(classification.kind)) throw invalid("A cover must be an image or a video.");
  const maxBytes = maxBytesFor(classification.kind);
  if (input.size > maxBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `${filename} is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit for this file type.`);
  }
  if (input.size <= 0) throw invalid(`${filename} is empty.`);

  const id = crypto.randomUUID();
  const key = attachmentKey({
    studioId: ctx.access.studioId,
    projectId: ctx.card.projectId,
    cardId: ctx.card.id,
    attachmentId: id,
    name: `original-${storageName(filename)}`,
  });
  const purpose = input.purpose === "version" ? "VERSION" : input.purpose === "comment" ? "COMMENT" : input.purpose === "resource" ? "RESOURCE" : input.purpose === "cover" ? "COVER" : "CARD";
  await db.transaction(async (tx) => {
    // Counts against the studio's storage limit from now on (until finished or abandoned).
    await reserveStudioStorage(tx, ctx.access.studioId, input.size);
    await tx.insert(attachments).values({
      id,
      cardId: ctx.card.id,
      projectId: ctx.card.projectId,
      versionId: input.purpose === "version" ? input.versionId! : null,
      deliverableId,
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

async function loadAttachmentForWrite(actor: Actor, attachmentId: string) {
  const [attachment] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
  if (!attachment) throw notFound("Attachment");
  const ctx = await requireCard(actor.userId, attachment.cardId);
  return { attachment, ctx };
}

/** Re-derives covers for the deliverable an attachment belongs to, then the card. */
async function recomputeCovers(tx: Executor, attachment: Pick<AttachmentRow, "cardId" | "deliverableId">) {
  if (attachment.deliverableId) await recomputeDeliverableCover(tx, attachment.deliverableId);
  await recomputeCardRollup(tx, attachment.cardId);
}

function finishBackground(attachmentId: string, projectId: string, cardId: string, patch: Partial<AttachmentRow>) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(attachments)
      .set({ ...patch, status: "READY", processedAt: now() })
      .where(eq(attachments.id, attachmentId))
      .returning();
    if (row) await recomputeCovers(tx, row);
    new Effects().card(projectId, cardId).flush();
  });
}

function scheduleVideoWork(attachment: AttachmentRow, projectId: string, cardId: string, work: { preview: boolean; transcode: boolean }) {
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

function scheduleAudioWork(attachment: AttachmentRow, projectId: string, cardId: string) {
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

export function scheduleRobloxWork(attachment: Pick<AttachmentRow, "id" | "storageKey" | "meta">, projectId: string, cardId: string) {
  mediaQueue.enqueue(`roblox:${attachment.id}`, async () => {
    const derived = await buildRobloxManifest(attachment.storageKey);
    await finishBackground(attachment.id, projectId, cardId, { meta: { format: attachment.meta?.format, ...derived } });
  });
}

export async function completeUpload(
  actor: Actor,
  input: { attachmentId: string; clientMeta?: ClientMediaMeta },
): Promise<AttachmentDTO> {
  const { attachment, ctx } = await loadAttachmentForWrite(actor, input.attachmentId);
  if (attachment.uploadedById !== actor.userId) throw forbidden("Only the uploader can finish this upload.");
  if (attachment.status !== "PENDING") return attachmentToDTO(attachment);

  const store = storage();
  const stat = await store.stat(attachment.storageKey);
  if (!stat) throw invalid("The upload didn't reach storage. Please retry.");
  const maxBytes = maxBytesFor(attachment.kind);
  if (stat.size > maxBytes) {
    await store.delete(attachment.storageKey).catch(() => {});
    await db.update(attachments).set({ status: "FAILED", error: "File exceeds the size limit." }).where(eq(attachments.id, attachment.id));
    throw new AppError("PAYLOAD_TOO_LARGE", "That file is larger than the allowed limit.");
  }

  let analysis;
  try {
    analysis = await analyzeUpload(attachment, input.clientMeta);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "We couldn't process this file.";
    await db.update(attachments).set({ status: "FAILED", error: message }).where(eq(attachments.id, attachment.id));
    if (!(error instanceof AppError)) console.error("[forge] media analysis failed", error);
    throw error instanceof AppError ? error : invalid(message);
  }

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

    if (attachment.purpose === "VERSION" && attachment.versionId) {
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
      if ((readyCount?.value ?? 0) === 0) {
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
      await pinCover(tx, ctx, row!.id, actor.userId);
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
  const urlName = decodeURIComponent(new URL(fetched.finalUrl).pathname.split("/").pop() || "image");
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
  return completeUpload(actor, { attachmentId: intent.attachmentId });
}

export async function archiveAttachment(actor: Actor, input: { attachmentId: string }) {
  const { attachment, ctx } = await loadAttachmentForWrite(actor, input.attachmentId);
  const own = attachment.uploadedById === actor.userId;
  if (!(ctx.perms.canEdit || (own && ctx.perms.canComment))) throw forbidden("You can't remove this attachment.");
  if (attachment.versionId && attachment.kind !== "FILE") {
    // Work under review is part of the revision history and is never removed.
    const [version] = await db.select().from(assetVersions).where(eq(assetVersions.id, attachment.versionId));
    if (version && version.status !== "DRAFT") {
      throw conflict("Files on a submitted revision are kept for review history. Upload a new revision instead.");
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(attachments).set({ archivedAt: now() }).where(eq(attachments.id, attachment.id));
    await recomputeCovers(tx, attachment);
    await touchCard(tx, ctx.card.id, actor.userId);
  });
  new Effects().card(ctx.card.projectId, ctx.card.id).flush(actor.clientId);
  return { ok: true };
}

// ── Card covers ─────────────────────────────────────────────────────────────

/** A cover upload that is no longer the cover has no other use: archive it (the stored file stays). */
async function retireCoverUpload(tx: Executor, cardId: string, attachmentId: string | null, keep: string | null) {
  if (!attachmentId || attachmentId === keep) return;
  await tx
    .update(attachments)
    .set({ archivedAt: now() })
    .where(and(eq(attachments.id, attachmentId), eq(attachments.cardId, cardId), eq(attachments.purpose, "COVER"), isNull(attachments.archivedAt)));
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
  // Files on other cards (even ones the actor can see) are "not found" here, never borrowed.
  if (!attachment || !["CARD", "VERSION", "COVER"].includes(attachment.purpose)) throw notFound("File");
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
    .select({ a: attachments, projectId: cards.projectId })
    .from(attachments)
    .innerJoin(cards, eq(cards.id, attachments.cardId))
    .where(and(eq(attachments.status, "PROCESSING"), isNull(attachments.archivedAt)));
  for (const { a, projectId } of pending) {
    if (a.kind === "ROBLOX") scheduleRobloxWork(a, projectId, a.cardId);
    else if (a.kind === "AUDIO") scheduleAudioWork(a, projectId, a.cardId);
    else if (a.kind === "VIDEO") scheduleVideoWork(a, projectId, a.cardId, { preview: !a.previewKey && (a.durationMs ?? 0) > 500, transcode: !a.playbackKey && !PLAYABLE_VIDEO.has(a.mimeType) });
    else await finishBackground(a.id, projectId, a.cardId, {});
  }

  const stale = await db
    .select({ a: attachments, projectId: cards.projectId })
    .from(attachments)
    .innerJoin(cards, eq(cards.id, attachments.cardId))
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
