/**
 * Permanent deletion of archived content, and the storage it frees.
 *
 * Archiving stays reversible; this is the separate, explicit step after it. Every target is
 * checked for permission and archive status when previewed AND again inside its own transaction
 * when executed, so a stale preview, a repeated request or a concurrent restore can't delete
 * live work. Nothing active is ever deleted because its container is archived: a column is only
 * eligible once it has no active cards.
 *
 * Files: an upload lives in its own folder with every derived file (thumbnail, preview, playback
 * transcode, waveform, Roblox manifest/meshes). Duplicated cards share those folders, so a folder
 * is removed only when no surviving attachment points into it. Removal is queued durably in the
 * same transaction as the records (storage_deletions) and retried until it succeeds.
 */
import { and, count, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { assertProjectPermission, assertStudioOwner, getProjectAccess, type ProjectAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import {
  assetVersions,
  attachments,
  boardColumns,
  boards,
  cards,
  comments,
  deliverables,
  projects,
  robloxResources,
  storageDeletions,
} from "../db/schema";
import { AppError, forbidden, invalid } from "../errors";
import { storage } from "../storage";
import { audit } from "./activity";
import type { Actor } from "./context";
import { recomputeCardRollup, recomputeDeliverableCover } from "./deliverables";
import { Effects } from "./effects";

export const PURGE_TYPES = ["project", "board", "column", "card", "deliverable", "attachment"] as const;
export type PurgeType = (typeof PURGE_TYPES)[number];
export interface PurgeTarget {
  type: PurgeType;
  id: string;
}

type AttachmentFiles = { id: string; storageKey: string; thumbnailKey: string | null; previewKey: string | null; playbackKey: string | null; sizeBytes: number };

const FOLDER = /^(studios\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/cards\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/)[^/]+$/i;

/** The storage units an attachment occupies: its folder, or (for older layouts) its individual keys. */
export function storageUnits(file: Pick<AttachmentFiles, "storageKey" | "thumbnailKey" | "previewKey" | "playbackKey">): string[] {
  const folder = FOLDER.exec(file.storageKey)?.[1];
  if (folder) return [folder];
  return [file.storageKey, file.thumbnailKey, file.previewKey, file.playbackKey].filter((k): k is string => Boolean(k));
}

const fileColumns = {
  id: attachments.id,
  storageKey: attachments.storageKey,
  thumbnailKey: attachments.thumbnailKey,
  previewKey: attachments.previewKey,
  playbackKey: attachments.playbackKey,
  sizeBytes: attachments.sizeBytes,
};

/** Whether any attachment other than `excludeIds` still uses a storage unit. */
async function unitReferenced(ex: Executor, unit: string, excludeIds: string[] = []): Promise<boolean> {
  const match = unit.endsWith("/")
    ? sql`(starts_with(${attachments.storageKey}, ${unit}) or starts_with(coalesce(${attachments.thumbnailKey}, ''), ${unit}) or starts_with(coalesce(${attachments.previewKey}, ''), ${unit}) or starts_with(coalesce(${attachments.playbackKey}, ''), ${unit}))`
    : sql`(${attachments.storageKey} = ${unit} or ${attachments.thumbnailKey} = ${unit} or ${attachments.previewKey} = ${unit} or ${attachments.playbackKey} = ${unit})`;
  const rows = await ex
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(match, excludeIds.length ? notInArray(attachments.id, excludeIds) : undefined))
    .limit(1);
  return rows.length > 0;
}

// ── Scope ───────────────────────────────────────────────────────────────────

export interface PurgeScope {
  target: PurgeTarget;
  label: string;
  projectId: string | null;
  /** Ancestors (for overlap detection): the project, board, column, card and deliverable it sits in. */
  parents: Partial<Record<PurgeType, string>>;
  eligible: boolean;
  reason?: string;
  files: AttachmentFiles[];
  counts: { cards: number; deliverables: number; revisions: number; files: number; comments: number };
}

const NONE = { cards: 0, deliverables: 0, revisions: 0, files: 0, comments: 0 };
const missing = (target: PurgeTarget): PurgeScope => ({ target, label: "Already deleted", projectId: null, parents: {}, eligible: false, reason: "Already deleted", files: [], counts: { ...NONE } });

async function contentAccess(actor: Actor, projectId: string, ex: Executor): Promise<{ access: ProjectAccess | null; denied?: string }> {
  const access = await getProjectAccess(actor.userId, projectId, ex);
  if (!access) return { access: null, denied: "Not found" };
  try {
    assertProjectPermission(access, "card.delete");
  } catch (error) {
    return { access, denied: error instanceof AppError ? error.message : "You can't delete content in this project." };
  }
  return { access };
}

async function sharedResources(ex: Executor, attachmentIds: string[]): Promise<number> {
  if (!attachmentIds.length) return 0;
  const [row] = await ex.select({ n: count() }).from(robloxResources).where(inArray(robloxResources.attachmentId, attachmentIds));
  return row?.n ?? 0;
}

async function countRows(ex: Executor, cardIds: string[], deliverableIds?: string[]) {
  const byCard = cardIds.length ? inArray(deliverables.cardId, cardIds) : undefined;
  const scope = deliverableIds ? (deliverableIds.length ? inArray(deliverables.id, deliverableIds) : sql`false`) : byCard ?? sql`false`;
  const [[d], [v], [c]] = await Promise.all([
    ex.select({ n: count() }).from(deliverables).where(scope),
    ex.select({ n: count() }).from(assetVersions).innerJoin(deliverables, eq(deliverables.id, assetVersions.deliverableId)).where(scope),
    deliverableIds
      ? ex.select({ n: count() }).from(comments).where(deliverableIds.length ? inArray(comments.deliverableId, deliverableIds) : sql`false`)
      : ex.select({ n: count() }).from(comments).where(cardIds.length ? inArray(comments.cardId, cardIds) : sql`false`),
  ]);
  return { deliverables: d?.n ?? 0, revisions: v?.n ?? 0, comments: c?.n ?? 0 };
}

/** Resolves what deleting `target` would remove, and whether `actor` may do it right now. */
export async function resolveScope(actor: Actor, target: PurgeTarget, ex: Executor = db, lock = false): Promise<PurgeScope> {
  switch (target.type) {
    case "project": {
      const query = ex.select().from(projects).where(eq(projects.id, target.id));
      const [project] = lock ? await query.for("update") : await query;
      if (!project) return missing(target);
      const access = await getProjectAccess(actor.userId, project.id, ex);
      if (!access) return missing(target);
      const base = { target, label: project.name, projectId: project.id, parents: {} };
      const files = await ex.select(fileColumns).from(attachments).where(eq(attachments.projectId, project.id));
      const cardIds = (await ex.select({ id: cards.id }).from(cards).where(eq(cards.projectId, project.id))).map((c) => c.id);
      const counts = { cards: cardIds.length, files: files.length, ...(await countRows(ex, cardIds)) };
      try {
        assertStudioOwner(access, "delete projects");
      } catch (error) {
        return { ...base, eligible: false, reason: (error as Error).message, files, counts };
      }
      if (!project.archivedAt) return { ...base, eligible: false, reason: "Archive the project before deleting it.", files, counts };
      return { ...base, eligible: true, files, counts };
    }
    case "board": {
      // An archived board hides everything on it, so deleting it removes all its columns and cards.
      const query = ex.select().from(boards).where(eq(boards.id, target.id));
      const [board] = lock ? await query.for("update") : await query;
      if (!board) return missing(target);
      const { access, denied } = await contentAccess(actor, board.projectId, ex);
      if (!access) return missing(target);
      const cardIds = (await ex.select({ id: cards.id }).from(cards).where(eq(cards.boardId, board.id))).map((c) => c.id);
      const files = cardIds.length ? await ex.select(fileColumns).from(attachments).where(inArray(attachments.cardId, cardIds)) : [];
      const counts = { cards: cardIds.length, files: files.length, ...(await countRows(ex, cardIds)) };
      const base = { target, label: `${board.name} (board)`, projectId: board.projectId, parents: { project: board.projectId }, files, counts };
      if (denied) return { ...base, eligible: false, reason: denied };
      if (!board.archivedAt) return { ...base, eligible: false, reason: "The board isn't archived." };
      const shared = await sharedResources(ex, files.map((f) => f.id));
      if (shared) return { ...base, eligible: false, reason: `Its cards hold ${shared} Roblox resource${shared === 1 ? "" : "s"} other models in the project use.` };
      return { ...base, eligible: true };
    }
    case "column": {
      const query = ex.select().from(boardColumns).where(eq(boardColumns.id, target.id));
      const [column] = lock ? await query.for("update") : await query;
      if (!column) return missing(target);
      const { access, denied } = await contentAccess(actor, column.projectId, ex);
      if (!access) return missing(target);
      const columnCards = await ex.select({ id: cards.id, archivedAt: cards.archivedAt }).from(cards).where(eq(cards.columnId, column.id));
      const cardIds = columnCards.map((c) => c.id);
      const files = cardIds.length ? await ex.select(fileColumns).from(attachments).where(inArray(attachments.cardId, cardIds)) : [];
      const counts = { cards: cardIds.length, files: files.length, ...(await countRows(ex, cardIds)) };
      const base = { target, label: column.name, projectId: column.projectId, parents: { project: column.projectId, board: column.boardId }, files, counts };
      const active = columnCards.filter((c) => !c.archivedAt).length;
      if (denied) return { ...base, eligible: false, reason: denied };
      if (!column.archivedAt) return { ...base, eligible: false, reason: "The column isn't archived." };
      if (active) return { ...base, eligible: false, reason: `It still has ${active} active card${active === 1 ? "" : "s"}. Move or archive ${active === 1 ? "it" : "them"} first.` };
      const shared = await sharedResources(ex, files.map((f) => f.id));
      if (shared) return { ...base, eligible: false, reason: `Its cards hold ${shared} Roblox resource${shared === 1 ? "" : "s"} other models in the project use.` };
      return { ...base, eligible: true };
    }
    case "card": {
      const query = ex.select().from(cards).where(eq(cards.id, target.id));
      const [card] = lock ? await query.for("update") : await query;
      if (!card) return missing(target);
      const { access, denied } = await contentAccess(actor, card.projectId, ex);
      if (!access) return missing(target);
      const files = await ex.select(fileColumns).from(attachments).where(eq(attachments.cardId, card.id));
      const counts = { cards: 1, files: files.length, ...(await countRows(ex, [card.id])) };
      const base = { target, label: `${access.project.key}-${card.number} ${card.title}`, projectId: card.projectId, parents: { project: card.projectId, board: card.boardId, column: card.columnId }, files, counts };
      if (denied) return { ...base, eligible: false, reason: denied };
      if (!card.archivedAt) return { ...base, eligible: false, reason: "The card isn't archived." };
      const shared = await sharedResources(ex, files.map((f) => f.id));
      if (shared) return { ...base, eligible: false, reason: `It holds ${shared} Roblox resource${shared === 1 ? "" : "s"} other models in the project use.` };
      return { ...base, eligible: true };
    }
    case "deliverable": {
      const query = ex.select().from(deliverables).where(eq(deliverables.id, target.id));
      const [d] = lock ? await query.for("update") : await query;
      if (!d) return missing(target);
      const { access, denied } = await contentAccess(actor, d.projectId, ex);
      if (!access) return missing(target);
      const [card] = await ex.select({ number: cards.number, columnId: cards.columnId, boardId: cards.boardId }).from(cards).where(eq(cards.id, d.cardId));
      const files = await ex.select(fileColumns).from(attachments).where(eq(attachments.deliverableId, d.id));
      const counts = { cards: 0, files: files.length, ...(await countRows(ex, [], [d.id])) };
      const base = {
        target,
        label: `${access.project.key}-${card?.number ?? "?"} · D${d.number} ${d.name}`,
        projectId: d.projectId,
        parents: { project: d.projectId, board: card?.boardId, column: card?.columnId, card: d.cardId },
        files,
        counts,
      };
      if (denied) return { ...base, eligible: false, reason: denied };
      if (!d.archivedAt) return { ...base, eligible: false, reason: "The deliverable isn't archived." };
      const shared = await sharedResources(ex, files.map((f) => f.id));
      if (shared) return { ...base, eligible: false, reason: `It holds ${shared} Roblox resource${shared === 1 ? "" : "s"} other models in the project use.` };
      return { ...base, eligible: true };
    }
    case "attachment": {
      const query = ex.select().from(attachments).where(eq(attachments.id, target.id));
      const [a] = lock ? await query.for("update") : await query;
      if (!a) return missing(target);
      const { access, denied } = await contentAccess(actor, a.projectId, ex);
      if (!access) return missing(target);
      const [card] = await ex.select({ number: cards.number, columnId: cards.columnId, boardId: cards.boardId }).from(cards).where(eq(cards.id, a.cardId));
      const files = [{ id: a.id, storageKey: a.storageKey, thumbnailKey: a.thumbnailKey, previewKey: a.previewKey, playbackKey: a.playbackKey, sizeBytes: a.sizeBytes }];
      const base = {
        target,
        label: `${access.project.key}-${card?.number ?? "?"} · ${a.filename}`,
        projectId: a.projectId,
        parents: { project: a.projectId, board: card?.boardId, column: card?.columnId, card: a.cardId, ...(a.deliverableId ? { deliverable: a.deliverableId } : {}) },
        files,
        counts: { ...NONE, files: 1 },
      };
      if (denied) return { ...base, eligible: false, reason: denied };
      if (!a.archivedAt) return { ...base, eligible: false, reason: "The file isn't archived." };
      if (await sharedResources(ex, [a.id])) return { ...base, eligible: false, reason: "Other models in the project use it as a Roblox resource." };
      return { ...base, eligible: true };
    }
  }
}

// ── Preview ─────────────────────────────────────────────────────────────────

export interface PurgePreviewItem {
  type: PurgeType;
  id: string;
  label: string;
  eligible: boolean;
  reason?: string;
  /** Already covered by another selected item (e.g. a card inside a selected column). */
  includedIn?: { type: PurgeType; id: string; label: string };
  counts: PurgeScope["counts"];
  bytes: number;
}

export interface PurgePreview {
  items: PurgePreviewItem[];
  totals: { items: number; cards: number; deliverables: number; revisions: number; files: number; comments: number; bytes: number; sharedFiles: number };
}

function dedupeTargets(targets: PurgeTarget[]): PurgeTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.type}:${t.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Marks targets that sit inside another eligible selected target. */
function coverage(scopes: PurgeScope[]): Map<PurgeScope, PurgeScope> {
  const byKey = new Map(scopes.filter((s) => s.eligible).map((s) => [`${s.target.type}:${s.target.id}`, s]));
  const covered = new Map<PurgeScope, PurgeScope>();
  for (const s of scopes) {
    for (const [type, id] of Object.entries(s.parents) as Array<[PurgeType, string | undefined]>) {
      const parent = id ? byKey.get(`${type}:${id}`) : undefined;
      if (parent && parent !== s) {
        covered.set(s, parent);
        break;
      }
    }
  }
  return covered;
}

/** Bytes freed by deleting `files` together: each storage unit once, and only units nothing else uses. */
async function reclaimable(ex: Executor, files: AttachmentFiles[]): Promise<{ bytes: number; perFile: Map<string, number>; shared: number }> {
  const ids = files.map((f) => f.id);
  const unitBytes = new Map<string, { bytes: number; keys: Set<string>; fileIds: string[] }>();
  for (const f of files) {
    for (const unit of storageUnits(f)) {
      const entry = unitBytes.get(unit) ?? { bytes: 0, keys: new Set<string>(), fileIds: [] };
      if (!entry.keys.has(f.storageKey)) {
        entry.keys.add(f.storageKey);
        entry.bytes += Number(f.sizeBytes) || 0;
      }
      entry.fileIds.push(f.id);
      unitBytes.set(unit, entry);
    }
  }
  let bytes = 0;
  let shared = 0;
  const perFile = new Map<string, number>();
  for (const [unit, entry] of unitBytes) {
    if (await unitReferenced(ex, unit, ids)) {
      shared += 1;
      continue;
    }
    bytes += entry.bytes;
    perFile.set(entry.fileIds[0]!, (perFile.get(entry.fileIds[0]!) ?? 0) + entry.bytes);
  }
  return { bytes, perFile, shared };
}

export async function previewPurge(actor: Actor, input: { targets: PurgeTarget[] }): Promise<PurgePreview> {
  const targets = dedupeTargets(input.targets);
  if (targets.length > 500) throw invalid("Select at most 500 items at once.");
  const scopes: PurgeScope[] = [];
  for (const t of targets) scopes.push(await resolveScope(actor, t));
  const covered = coverage(scopes);
  const counted = scopes.filter((s) => s.eligible && !covered.has(s));
  const files = new Map<string, AttachmentFiles>();
  for (const s of counted) for (const f of s.files) files.set(f.id, f);
  const total = await reclaimable(db, [...files.values()]);
  const items = await Promise.all(
    scopes.map(async (s) => {
      const parent = covered.get(s);
      return {
        type: s.target.type,
        id: s.target.id,
        label: s.label,
        eligible: s.eligible,
        reason: s.reason,
        includedIn: parent ? { type: parent.target.type, id: parent.target.id, label: parent.label } : undefined,
        counts: s.counts,
        bytes: s.eligible && !parent ? (await reclaimable(db, s.files)).bytes : 0,
      } satisfies PurgePreviewItem;
    }),
  );
  const sum = (key: keyof PurgeScope["counts"]) => counted.reduce((n, s) => n + s.counts[key], 0);
  return {
    items,
    totals: {
      items: counted.length,
      cards: sum("cards"),
      deliverables: sum("deliverables"),
      revisions: sum("revisions"),
      files: files.size,
      comments: sum("comments"),
      bytes: total.bytes,
      sharedFiles: total.shared,
    },
  };
}

// ── Execute ─────────────────────────────────────────────────────────────────

export interface PurgeResult {
  type: PurgeType;
  id: string;
  label: string;
  status: "deleted" | "skipped" | "failed";
  reason?: string;
}

const AUDIT_ACTION: Record<PurgeType, string> = {
  project: "project.deleted",
  board: "board.deleted",
  column: "column.deleted",
  card: "card.deleted",
  deliverable: "deliverable.deleted",
  attachment: "attachment.deleted",
};

/** Deletes one eligible target inside `tx`; returns the storage units to clean up. */
async function deleteTarget(tx: Executor, actor: Actor, scope: PurgeScope, bytes: number, fx: Effects) {
  const t = scope.target;
  const projectId = scope.projectId!;
  const [project] = await tx.select({ studioId: projects.studioId }).from(projects).where(eq(projects.id, projectId));
  await audit(tx, actor, {
    studioId: project!.studioId,
    action: AUDIT_ACTION[t.type],
    targetType: t.type,
    targetId: t.id,
    data: { name: scope.label, ...scope.counts, bytes },
  });
  switch (t.type) {
    case "project":
      await tx.delete(cards).where(eq(cards.projectId, t.id));
      await tx.delete(projects).where(eq(projects.id, t.id));
      break;
    case "board":
      // Cards first: a column can't be removed while cards point at it.
      await tx.delete(cards).where(eq(cards.boardId, t.id));
      await tx.delete(boardColumns).where(eq(boardColumns.boardId, t.id));
      await tx.delete(boards).where(eq(boards.id, t.id));
      fx.project(projectId);
      break;
    case "column":
      await tx.delete(cards).where(eq(cards.columnId, t.id));
      await tx.delete(boardColumns).where(eq(boardColumns.id, t.id));
      fx.project(projectId);
      break;
    case "card":
      await tx.delete(cards).where(eq(cards.id, t.id));
      fx.card(projectId, t.id);
      break;
    case "deliverable":
      await tx.delete(deliverables).where(eq(deliverables.id, t.id));
      await recomputeCardRollup(tx, scope.parents.card!);
      fx.card(projectId, scope.parents.card!);
      break;
    case "attachment": {
      const [row] = await tx.delete(attachments).where(eq(attachments.id, t.id)).returning({ cardId: attachments.cardId, deliverableId: attachments.deliverableId });
      if (row?.deliverableId) await recomputeDeliverableCover(tx, row.deliverableId);
      if (row) {
        await recomputeCardRollup(tx, row.cardId);
        fx.card(projectId, row.cardId);
      }
      break;
    }
  }
  const units = [...new Set(scope.files.flatMap(storageUnits))];
  await enqueueStorageCleanup(tx, units, `${t.type} ${t.id} deleted`);
}

/**
 * Permanently deletes the eligible targets. Each runs in its own transaction after re-checking
 * permission and archive status, so one failure doesn't undo or block the others, and repeating
 * the request reports already-deleted items instead of failing.
 */
export async function purge(actor: Actor, input: { targets: PurgeTarget[] }): Promise<{ results: PurgeResult[]; bytes: number }> {
  const targets = dedupeTargets(input.targets);
  if (targets.length > 500) throw invalid("Select at most 500 items at once.");
  // Order containers first so their contents are reported as included, not deleted twice.
  const order: Record<PurgeType, number> = { project: 0, board: 1, column: 2, card: 3, deliverable: 4, attachment: 5 };
  const scopes: PurgeScope[] = [];
  for (const t of [...targets].sort((a, b) => order[a.type] - order[b.type])) scopes.push(await resolveScope(actor, t));
  const covered = coverage(scopes);
  const results: PurgeResult[] = [];
  let bytes = 0;
  const fx = new Effects();
  for (const planned of scopes) {
    const parent = covered.get(planned);
    const base = { type: planned.target.type, id: planned.target.id, label: planned.label };
    if (parent) {
      const parentResult = results.find((r) => r.type === parent.target.type && r.id === parent.target.id);
      results.push({ ...base, status: parentResult?.status === "deleted" ? "deleted" : "skipped", reason: `Included in ${parent.label}` });
      continue;
    }
    if (!planned.eligible) {
      results.push({ ...base, status: "skipped", reason: planned.reason });
      continue;
    }
    try {
      const freed = await db.transaction(async (tx) => {
        // Re-check with the row locked: it may have been restored or deleted since the preview.
        const scope = await resolveScope(actor, planned.target, tx, true);
        if (!scope.eligible) throw new AppError("CONFLICT", scope.reason ?? "No longer eligible.");
        const size = (await reclaimable(tx, scope.files)).bytes;
        await deleteTarget(tx, actor, scope, size, fx);
        return size;
      });
      bytes += freed;
      results.push({ ...base, status: "deleted" });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Something went wrong deleting this item.";
      if (!(error instanceof AppError)) console.error("[forge] purge failed", planned.target, error);
      results.push({ ...base, status: error instanceof AppError ? "skipped" : "failed", reason: message });
    }
  }
  fx.flush(actor.clientId);
  scheduleStorageCleanup();
  return { results, bytes };
}

/** Deletes a single target the way the older one-item endpoints expect (throws instead of reporting). */
export async function purgeOne(actor: Actor, target: PurgeTarget) {
  const { results } = await purge(actor, { targets: [target] });
  const result = results[0]!;
  if (result.status !== "deleted") {
    if (result.reason === "Already deleted") throw new AppError("NOT_FOUND", "It was already deleted.");
    throw result.status === "failed" ? new Error(result.reason) : forbidden(result.reason);
  }
  return { ok: true };
}

// ── Durable storage cleanup ─────────────────────────────────────────────────

export async function enqueueStorageCleanup(ex: Executor, units: string[], reason: string) {
  if (!units.length) return;
  await ex
    .insert(storageDeletions)
    .values(units.map((prefix) => ({ prefix, reason, createdAt: now(), nextAttemptAt: now() })))
    .onConflictDoUpdate({ target: storageDeletions.prefix, set: { nextAttemptAt: now(), reason } });
}

let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupRun: Promise<unknown> | null = null;
/** Runs the cleanup shortly after a commit (the periodic job catches anything left over). */
export function scheduleStorageCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    cleanupRun = processStorageDeletions()
      .catch((error) => console.error("[forge] storage cleanup failed", error))
      .finally(() => (cleanupRun = null));
  }, 250);
}

/** Cancels a pending post-commit cleanup and waits for one already running (for tests that drive the queue themselves). */
export async function settleStorageCleanup() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  await cleanupRun;
}

const backoffMs = (attempts: number) => Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, attempts - 1));

/**
 * Removes queued storage units nothing references any more. Safe to run on several workers at
 * once (each row is claimed first) and after crashes (unfinished rows are simply retried).
 */
export async function processStorageDeletions(limit = 100): Promise<{ deleted: number; preserved: number; failed: number }> {
  const due = await db.select().from(storageDeletions).where(lte(storageDeletions.nextAttemptAt, sql`now()`)).orderBy(storageDeletions.nextAttemptAt).limit(limit);
  const tally = { deleted: 0, preserved: 0, failed: 0 };
  for (const job of due) {
    const [claimed] = await db
      .update(storageDeletions)
      .set({ attempts: sql`${storageDeletions.attempts} + 1`, nextAttemptAt: new Date(now().getTime() + 10 * 60_000) })
      .where(and(eq(storageDeletions.prefix, job.prefix), lte(storageDeletions.nextAttemptAt, sql`now()`)))
      .returning();
    if (!claimed) continue;
    if (await unitReferenced(db, job.prefix)) {
      // Something (a duplicate, a re-upload) uses it again: keep the files.
      await db.delete(storageDeletions).where(eq(storageDeletions.prefix, job.prefix));
      tally.preserved += 1;
      continue;
    }
    try {
      if (job.prefix.endsWith("/")) await storage().deletePrefix(job.prefix);
      else await storage().delete(job.prefix);
      await db.delete(storageDeletions).where(eq(storageDeletions.prefix, job.prefix));
      tally.deleted += 1;
    } catch (error) {
      await db
        .update(storageDeletions)
        .set({ lastError: String(error).slice(0, 500), nextAttemptAt: new Date(now().getTime() + backoffMs(claimed.attempts)) })
        .where(eq(storageDeletions.prefix, job.prefix));
      tally.failed += 1;
    }
  }
  return tally;
}
