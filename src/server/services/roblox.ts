import fsp from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { assetIdOf, normalizeContentId } from "@/lib/roblox/content-id";
import type { RobloxFileMeta } from "@/lib/roblox/manifest";
import { computeDeliverablePermissions, requireCard, type CardAccess } from "../access";
import { now } from "../clock";
import { db } from "../db";
import { attachments, cards, deliverables, robloxAssetCache, robloxResources } from "../db/schema";
import { env } from "../env";
import { convertDracoMesh, DECODED_MESH_NAME, isDracoMesh } from "../roblox/draco-mesh";
import { RobloxParseError } from "../roblox/model";
import { parseRobloxFile } from "../roblox/parse";
import { AppError, conflict, forbidden, invalid, notFound } from "../errors";
import { extensionOf } from "../media/formats";
import { ROBLOX_PROCESSOR, siblingKey } from "../media/process";
import { sniffMedia } from "../media/sniff";
import { enforceRateLimit } from "../rate-limit";
import { safeFetch } from "../security/safe-fetch";
import { storage } from "../storage";
import { logActivity } from "./activity";
import { derivedKeyOf } from "./card-dto";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { scheduleRobloxWork } from "./media";

export type ResourceKind = "mesh" | "texture";

export interface ResolvedResourceDTO {
  /** A project mapping id, or "cache:{kind}:{assetId}" for an asset fetched from Roblox. */
  id: string;
  contentId: string;
  kind: ResourceKind;
  attachmentId: string | null;
  filename: string;
  /** mesh | obj | glb | fbx | png | jpg … — tells the viewer which loader to use. */
  format: string;
  url: string;
  createdById: string | null;
  createdAt: string;
  /** "upload": provided by someone in the project (kept). "roblox": fetched, cached for 7 days after last use. */
  source: "upload" | "roblox";
  /** When a fetched asset is freed unless it's used again before then. */
  expiresAt: string | null;
}

function canProvideResources(ctx: CardAccess) {
  return ctx.perms.canUpload || ctx.perms.canEdit;
}

/** Identifies a mesh file by content. Returns the format or null. */
export function sniffMeshFormat(head: Buffer, filename: string): "mesh" | "obj" | "glb" | "fbx" | null {
  const text = head.subarray(0, 64).toString("latin1");
  if (/^version [1-7]\.\d\d/.test(text)) return "mesh";
  if (text.startsWith("glTF")) return "glb";
  if (text.startsWith("Kaydara FBX Binary")) return "fbx";
  if (/^; FBX \d/.test(text)) return "fbx";
  const body = head.subarray(0, 8192).toString("utf8");
  if (extensionOf(filename) === "obj" && /^\s*v\s+-?[\d.]/m.test(body) && !/\0/.test(body)) return "obj";
  return null;
}

// ── Decoded copies of Draco-compressed meshes ───────────────────────────────

/** Regenerations in progress, by the new key (concurrent previews share one decode). */
const decoding = new Map<string, Promise<string | null>>();

/**
 * Decoded copies made by an older converter (e.g. v2, which dropped the skeleton) are rebuilt
 * from the kept original the first time they're served, so existing uploads and cached assets
 * pick up improvements without being added again. Returns the new key, or null if the
 * original couldn't be decoded (the old copy then keeps being served).
 */
function upgradeDecodedMesh(originalKey: string, oldKey: string, save: (newKey: string) => Promise<void>): Promise<string | null> {
  const newKey = siblingKey(originalKey, DECODED_MESH_NAME);
  const pending = decoding.get(newKey);
  if (pending) return pending;
  const work = (async () => {
    try {
      const local = await storage().materialize(originalKey);
      try {
        await storage().put(newKey, await convertDracoMesh(await fsp.readFile(local.path)), "application/octet-stream");
      } finally {
        await local.cleanup();
      }
      await save(newKey);
      // The old copy is Forge's own derived file (never an upload): drop it once nothing points at it.
      if (oldKey !== newKey && oldKey !== originalKey) await storage().delete(oldKey).catch(() => {});
      return newKey;
    } catch (error) {
      console.error("[forge] Couldn't regenerate a decoded mesh", originalKey, error);
      return null;
    } finally {
      decoding.delete(newKey);
    }
  })();
  decoding.set(newKey, work);
  return work;
}

const isOutdatedDecodedKey = (key: unknown): key is string => typeof key === "string" && !key.endsWith(`/${DECODED_MESH_NAME}`);

async function servedKeyOfUpload(file: typeof attachments.$inferSelect): Promise<string> {
  const converted = file.meta?.convertedKey;
  if (!isOutdatedDecodedKey(converted)) return typeof converted === "string" ? converted : file.storageKey;
  const upgraded = await upgradeDecodedMesh(file.storageKey, converted, async (newKey) => {
    // Only this one meta field changes; the rest of the attachment row is left as it is.
    await db
      .update(attachments)
      .set({ meta: sql`jsonb_set(coalesce(${attachments.meta}, '{}'::jsonb), '{convertedKey}', to_jsonb(${newKey}::text))` })
      .where(eq(attachments.id, file.id));
  });
  return upgraded ?? converted;
}

async function toDTO(row: typeof robloxResources.$inferSelect, file: typeof attachments.$inferSelect): Promise<ResolvedResourceDTO> {
  return {
    id: row.id,
    contentId: row.contentId,
    kind: row.kind,
    attachmentId: file.id,
    filename: file.filename,
    format: String(file.meta?.resourceFormat ?? extensionOf(file.filename)),
    // Draco-compressed meshes are served as the decoded copy made when they were added.
    url: await storage().signedUrl(await servedKeyOfUpload(file)),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    source: "upload",
    expiresAt: null,
  };
}

/** Resolved stand-ins for the given content ids (project-wide; access follows the card's project). */
export async function listResources(actor: Actor, input: { cardId: string; contentIds: string[] }): Promise<ResolvedResourceDTO[]> {
  const ctx = await requireCard(actor.userId, input.cardId);
  const ids = [...new Set(input.contentIds.map(normalizeContentId).filter((c): c is string => Boolean(c)))].slice(0, 500);
  if (!ids.length) return [];
  const rows = await db
    .select({ r: robloxResources, a: attachments })
    .from(robloxResources)
    .innerJoin(attachments, eq(attachments.id, robloxResources.attachmentId))
    .where(and(eq(robloxResources.projectId, ctx.card.projectId), inArray(robloxResources.contentId, ids), isNull(attachments.archivedAt)));
  const provided = await Promise.all(rows.map(({ r, a }) => toDTO(r, a)));

  // Everything else may already be in the studio's cache of assets fetched from Roblox.
  const covered = new Set(provided.map((r) => `${r.kind}:${r.contentId}`));
  const byAsset = new Map<string, string>();
  for (const contentId of ids) {
    const assetId = assetIdOf(contentId);
    if (assetId) byAsset.set(assetId, contentId);
  }
  const cached = (await cachedAssets(ctx.access.studioId, [...byAsset.keys()])).filter((row) => !covered.has(`${row.kind}:${byAsset.get(row.assetId)}`));
  // Being requested restarts an asset's 7 days.
  await touchCache(ctx.access.studioId, cached);
  return [...provided, ...(await Promise.all(cached.map((row) => cacheDTO(row, byAsset.get(row.assetId)!))))];
}

async function validateResourceFile(file: typeof attachments.$inferSelect, kind: ResourceKind): Promise<{ format: string; convertedKey?: string }> {
  const head = await storage().readHead(file.storageKey, 8192);
  if (kind === "texture") {
    const sniffed = sniffMedia(head);
    if (!sniffed || sniffed.kind !== "IMAGE") throw invalid("Textures must be PNG, JPG, WebP or GIF images (DDS isn't supported by browsers).");
    return { format: sniffed.mimeType.split("/")[1]!.replace("jpeg", "jpg") };
  }
  const format = sniffMeshFormat(head, file.filename);
  if (!format) throw invalid("Meshes must be a Roblox .mesh file, or an OBJ, GLB or FBX export of the same mesh.");
  if (format === "mesh" && isDracoMesh(head)) {
    // Newer Roblox meshes are Draco-compressed: decode once into a plain copy the viewer can read.
    const convertedKey = siblingKey(file.storageKey, DECODED_MESH_NAME);
    if (file.meta?.convertedKey !== convertedKey || !(await storage().stat(convertedKey))) {
      const local = await storage().materialize(file.storageKey);
      try {
        await storage().put(convertedKey, await convertDracoMesh(await fsp.readFile(local.path)), "application/octet-stream");
      } catch (error) {
        throw invalid(`This Draco-compressed mesh couldn't be decoded${error instanceof RobloxParseError ? ` (${error.message.replace(/.$/, "")})` : ""}. Upload an OBJ, GLB or FBX export of it instead.`);
      } finally {
        await local.cleanup();
      }
    }
    return { format, convertedKey };
  }
  return { format };
}

async function upsertMapping(
  actor: Actor,
  ctx: CardAccess,
  input: { contentId: string; kind: ResourceKind; attachmentId: string; format: string; convertedKey?: string; source: "upload" | "roblox" },
) {
  const fx = new Effects();
  await db.transaction(async (tx) => {
    const meta = { resourceFormat: input.format, contentId: input.contentId, source: input.source, ...(input.convertedKey ? { convertedKey: input.convertedKey } : {}) };
    await tx.update(attachments).set({ meta }).where(eq(attachments.id, input.attachmentId));
    await tx
      .insert(robloxResources)
      .values({ projectId: ctx.card.projectId, contentId: input.contentId, kind: input.kind, attachmentId: input.attachmentId, createdById: actor.userId, createdAt: now() })
      .onConflictDoUpdate({
        target: [robloxResources.projectId, robloxResources.contentId, robloxResources.kind],
        set: { attachmentId: input.attachmentId, createdById: actor.userId, createdAt: now() },
      });
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "resource.resolved",
      data: { contentId: input.contentId, kind: input.kind, source: input.source },
    });
    fx.card(ctx.card.projectId, ctx.card.id, false);
  });
  fx.flush(actor.clientId);
}

/** Maps a content id (e.g. rbxassetid://123) to a file someone uploaded for it. */
export async function resolveResource(
  actor: Actor,
  input: { cardId: string; contentId: string; kind: ResourceKind; attachmentId: string },
): Promise<ResolvedResourceDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  if (!canProvideResources(ctx)) throw forbidden("You don't have permission to provide files for this card.");
  const contentId = normalizeContentId(input.contentId);
  if (!contentId) throw invalid("Missing content id.");
  const [file] = await db.select().from(attachments).where(and(eq(attachments.id, input.attachmentId), eq(attachments.projectId, ctx.card.projectId)));
  if (!file || file.archivedAt) throw notFound("File");
  if (file.status !== "READY") throw conflict("That file hasn't finished uploading yet.");
  if (file.uploadedById !== actor.userId && file.purpose === "RESOURCE") {
    // Anyone may reuse an existing project resource, but only through files they can see.
    await requireCard(actor.userId, file.cardId);
  }
  const { format, convertedKey } = await validateResourceFile(file, input.kind);
  await upsertMapping(actor, ctx, { contentId, kind: input.kind, attachmentId: file.id, format, convertedKey, source: "upload" });
  return (await listResources(actor, { cardId: ctx.card.id, contentIds: [contentId] })).find((r) => r.kind === input.kind)!;
}

export async function unresolveResource(actor: Actor, input: { cardId: string; resourceId: string }) {
  const ctx = await requireCard(actor.userId, input.cardId);
  if (!canProvideResources(ctx)) throw forbidden();
  const deleted = await db
    .delete(robloxResources)
    .where(and(eq(robloxResources.id, input.resourceId), eq(robloxResources.projectId, ctx.card.projectId)))
    .returning();
  if (!deleted.length) throw notFound("Resource");
  new Effects().card(ctx.card.projectId, ctx.card.id, false).flush(actor.clientId);
  return { ok: true };
}

/** Whether this server can download referenced assets from Roblox, and whether that includes private ones. */
export function robloxFetchAvailable() {
  return { canFetch: Boolean(env.ROBLOX_OPEN_CLOUD_API_KEY) || env.ROBLOX_PUBLIC_ASSET_FETCH, privateAssets: Boolean(env.ROBLOX_OPEN_CLOUD_API_KEY) };
}

// ── Talking to Roblox ───────────────────────────────────────────────────────

/**
 * Roblox rate-limits Open Cloud per key *owner* (shared by all of that account's keys:
 * 1000 asset requests/min at the time of writing), so extra keys from the same account
 * don't add capacity. Forge stays well inside it by caching, and when Roblox does say
 * "slow down" it waits as instructed instead of retrying blindly.
 */
let robloxPausedUntil = 0;
const MAX_INLINE_WAIT_MS = 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function robloxBusy(waitMs: number) {
  return new AppError("RATE_LIMITED", `Roblox is limiting downloads right now — trying again in ${Math.max(1, Math.ceil(waitMs / 1000))} s.`, { retryAfterMs: waitMs });
}

/** Waits out a pause Roblox asked for (short ones inline, long ones are reported to the caller). */
async function respectRobloxPause() {
  const wait = robloxPausedUntil - Date.now();
  if (wait <= 0) return;
  if (wait > MAX_INLINE_WAIT_MS) throw robloxBusy(wait);
  await sleep(wait);
}

/** Records Roblox's rate-limit headers; returns how long to wait after a 429. */
function noteRobloxLimits(res: Response): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number((res.headers.get("x-ratelimit-reset") ?? "").split(",")[0]);
  const remaining = Number((res.headers.get("x-ratelimit-remaining") ?? "").split(",")[0]);
  const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number.isFinite(reset) && reset > 0 ? reset : 30) * 1000;
  if (res.status === 429 || remaining === 0) robloxPausedUntil = Math.max(robloxPausedUntil, Date.now() + waitMs);
  return waitMs;
}

/** GET with Roblox's rate limits respected: waits briefly and retries once on 429. */
async function robloxGet(url: string, headers: Record<string, string>): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await respectRobloxPause();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) return null;
    const waitMs = noteRobloxLimits(res);
    if (res.status !== 429) return res;
    if (attempt === 1 || waitMs > MAX_INLINE_WAIT_MS) throw robloxBusy(waitMs);
  }
  return null;
}

/**
 * Finds a temporary download location for an asset. With an Open Cloud key (scope
 * legacy-asset:manage) it asks apis.roblox.com first, which also covers private assets the
 * key's owner can access; otherwise (or if the key can't see it) it asks Roblox's public
 * asset endpoint. That one only serves some assets without credentials (in practice mostly
 * older ones); most — even public catalog items — answer 401 there.
 */
async function locateRobloxAsset(assetId: string): Promise<string> {
  const key = env.ROBLOX_OPEN_CLOUD_API_KEY;
  let reason: string | null = null;
  if (key) {
    const res = await robloxGet(`https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`, { "x-api-key": key, accept: "application/json" });
    if (res?.ok) {
      const location = ((await res.json().catch(() => null)) as { location?: string } | null)?.location;
      if (location) return location;
    }
    reason = !res
      ? "Roblox didn't respond."
      : res.status === 404
        ? "Roblox says this asset doesn't exist."
        : res.status === 401 || res.status === 403
          ? "The server's Roblox API key can't access this asset."
          : `Roblox returned an error (${res.status}).`;
    if (res?.status === 404 || !env.ROBLOX_PUBLIC_ASSET_FETCH) throw conflict(`${reason} Upload the file instead.`);
  }
  if (!env.ROBLOX_PUBLIC_ASSET_FETCH) throw conflict("Fetching from Roblox isn't enabled on this server. Upload the file instead.");
  const res = await robloxGet(`https://assetdelivery.roblox.com/v2/asset/?id=${assetId}`, { accept: "application/json" });
  if (!res) throw conflict("Roblox didn't respond. Try again or upload the file.");
  if (res.status === 404) throw conflict("Roblox says this asset doesn't exist.");
  if (res.status === 401 || res.status === 403) {
    throw conflict(
      key
        ? "Neither the server's Roblox API key nor Roblox's public download can access this asset. Upload the file instead."
        : "Roblox won't hand this asset out without signing in — it only serves a few (mostly older) assets that way; most, even public catalog items, need an API key. Upload the file, or set ROBLOX_OPEN_CLOUD_API_KEY.",
    );
  }
  if (!res.ok) throw conflict(`Roblox returned an error (${res.status}). Upload the file instead.`);
  const body = (await res.json().catch(() => null)) as { locations?: Array<{ location?: string }> } | null;
  const location = body?.locations?.find((l) => l.location)?.location;
  if (!location) throw conflict(reason ?? "Roblox didn't return a download location for this asset.");
  return location;
}

async function downloadRobloxAsset(assetId: string): Promise<Buffer> {
  const location = await locateRobloxAsset(assetId);
  const host = new URL(location).hostname;
  if (!/(^|\.)rbxcdn\.com$/.test(host) && !/(^|\.)roblox\.com$/.test(host)) throw conflict("Roblox returned an unexpected download location.");
  const downloaded = await safeFetch(location, { maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
  let buffer = downloaded.buffer;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
  return buffer;
}

/**
 * Texture properties often hold a Decal's id rather than its image's. Roblox then serves a
 * small model containing the Decal; follow its Texture to the actual image (one level).
 */
function imageIdInsideDecal(buffer: Buffer): string | null {
  try {
    const doc = parseRobloxFile(new Uint8Array(buffer));
    for (const inst of doc.instances) {
      const value = inst.props.get("Texture") ?? inst.props.get("Image");
      const raw = value && (value.type === "Content" || value.type === "String") ? value.value : null;
      const id = raw ? assetIdOf(normalizeContentId(raw) ?? "") : null;
      if (id) return id;
    }
  } catch {
    // not a Roblox file
  }
  return null;
}

// ── The 7-day cache ─────────────────────────────────────────────────────────

/** Fetched assets are kept this long after they were last requested, then freed. */
export const ROBLOX_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Last-used times are refreshed at most this often per asset (saves a write per preview). */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

type CacheRow = typeof robloxAssetCache.$inferSelect;

async function cacheDTO(row: CacheRow, contentId: string): Promise<ResolvedResourceDTO> {
  return {
    id: `cache:${row.kind}:${row.assetId}`,
    contentId,
    kind: row.kind,
    attachmentId: null,
    filename: row.filename,
    format: row.format,
    url: await storage().signedUrl(await servedKeyOfCached(row)),
    createdById: null,
    createdAt: row.fetchedAt.toISOString(),
    source: "roblox",
    expiresAt: new Date(row.lastAccessedAt.getTime() + ROBLOX_CACHE_TTL_MS).toISOString(),
  };
}

async function servedKeyOfCached(row: CacheRow): Promise<string> {
  if (!isOutdatedDecodedKey(row.convertedKey)) return row.convertedKey ?? row.storageKey;
  const old = row.convertedKey;
  const upgraded = await upgradeDecodedMesh(row.storageKey, old, async (newKey) => {
    await db
      .update(robloxAssetCache)
      .set({ convertedKey: newKey })
      .where(and(eq(robloxAssetCache.studioId, row.studioId), eq(robloxAssetCache.kind, row.kind), eq(robloxAssetCache.assetId, row.assetId)));
  });
  if (upgraded) row.convertedKey = upgraded;
  return upgraded ?? old;
}

/** Marks cached assets as used now (which restarts their 7 days). */
async function touchCache(studioId: string, rows: CacheRow[]) {
  const stale = rows.filter((r) => Date.now() - r.lastAccessedAt.getTime() > TOUCH_INTERVAL_MS);
  if (!stale.length) return;
  const at = now();
  for (const kind of ["mesh", "texture"] as const) {
    const ids = stale.filter((r) => r.kind === kind).map((r) => r.assetId);
    if (ids.length) {
      await db
        .update(robloxAssetCache)
        .set({ lastAccessedAt: at })
        .where(and(eq(robloxAssetCache.studioId, studioId), eq(robloxAssetCache.kind, kind), inArray(robloxAssetCache.assetId, ids)));
    }
  }
  for (const r of stale) r.lastAccessedAt = at;
}

async function cachedAssets(studioId: string, assetIds: string[]): Promise<CacheRow[]> {
  if (!assetIds.length) return [];
  return db
    .select()
    .from(robloxAssetCache)
    .where(and(eq(robloxAssetCache.studioId, studioId), inArray(robloxAssetCache.assetId, assetIds)));
}

/** Deletes cached assets nobody has requested for 7 days (the row first, so no new URLs point at them). */
export async function evictStaleRobloxAssets(at: Date = now()): Promise<number> {
  const cutoff = new Date(at.getTime() - ROBLOX_CACHE_TTL_MS);
  let evicted = 0;
  for (;;) {
    const batch = await db.select().from(robloxAssetCache).where(lt(robloxAssetCache.lastAccessedAt, cutoff)).limit(200);
    for (const row of batch) {
      // Re-checked inside the delete, so an asset used a moment ago survives.
      const deleted = await db
        .delete(robloxAssetCache)
        .where(
          and(
            eq(robloxAssetCache.studioId, row.studioId),
            eq(robloxAssetCache.kind, row.kind),
            eq(robloxAssetCache.assetId, row.assetId),
            lt(robloxAssetCache.lastAccessedAt, cutoff),
          ),
        )
        .returning();
      if (!deleted.length) continue;
      for (const key of [row.storageKey, row.convertedKey]) if (key) await storage().delete(key).catch(() => {});
      evicted++;
    }
    if (batch.length < 200) break;
  }
  return evicted;
}

/** Concurrent requests for the same asset share one download. */
const inFlight = new Map<string, Promise<CacheRow>>();

/** Downloads one asset into the studio's cache (or returns what's already there). */
async function cacheRobloxAsset(actor: Actor, studioId: string, kind: ResourceKind, assetId: string): Promise<CacheRow> {
  const [existing] = await db
    .select()
    .from(robloxAssetCache)
    .where(and(eq(robloxAssetCache.studioId, studioId), eq(robloxAssetCache.kind, kind), eq(robloxAssetCache.assetId, assetId)));
  if (existing) {
    await touchCache(studioId, [existing]);
    return existing;
  }
  const flightKey = `${studioId}:${kind}:${assetId}`;
  const pending = inFlight.get(flightKey);
  if (pending) return pending;
  const work = (async () => {
    // Only real downloads count against Forge's own per-person budget; cache hits are free.
    enforceRateLimit(`roblox-download:${actor.userId}`, 300, 10 * 60 * 1000);
    let buffer = await downloadRobloxAsset(assetId);
    if (kind === "texture" && !sniffMedia(buffer)) {
      const imageId = imageIdInsideDecal(buffer);
      if (imageId && imageId !== assetId) buffer = await downloadRobloxAsset(imageId);
    }
    const base = `roblox-cache/${studioId}/${kind}/${assetId}`;
    let format: string;
    let convertedKey: string | null = null;
    if (kind === "texture") {
      const sniffed = sniffMedia(buffer);
      if (!sniffed || sniffed.kind !== "IMAGE") throw conflict("Roblox returned something that isn't a PNG/JPG/WebP/GIF image for this texture. Upload the image instead.");
      format = sniffed.mimeType.split("/")[1]!.replace("jpeg", "jpg");
    } else {
      const sniffedMesh = sniffMeshFormat(buffer.subarray(0, 8192), "asset.mesh");
      if (!sniffedMesh) throw conflict("Roblox returned something that isn't a mesh for this id. Upload the mesh instead.");
      format = sniffedMesh;
      if (format === "mesh" && isDracoMesh(buffer)) {
        convertedKey = `${base}/${DECODED_MESH_NAME}`;
        try {
          await storage().put(convertedKey, await convertDracoMesh(buffer), "application/octet-stream");
        } catch (error) {
          throw conflict(
            `This Draco-compressed mesh couldn't be decoded${error instanceof RobloxParseError ? ` (${error.message.replace(/\.$/, "")})` : ""}. Upload an OBJ, GLB or FBX export of it instead.`,
          );
        }
      }
    }
    const filename = `roblox-${assetId}.${format}`;
    const storageKey = `${base}/original.${format}`;
    await storage().put(storageKey, buffer, "application/octet-stream");
    const at = now();
    const [row] = await db
      .insert(robloxAssetCache)
      .values({ studioId, kind, assetId, storageKey, convertedKey, format, filename, sizeBytes: buffer.length, fetchedAt: at, lastAccessedAt: at })
      .onConflictDoUpdate({
        target: [robloxAssetCache.studioId, robloxAssetCache.kind, robloxAssetCache.assetId],
        set: { storageKey, convertedKey, format, filename, sizeBytes: buffer.length, fetchedAt: at, lastAccessedAt: at },
      })
      .returning();
    return row!;
  })();
  inFlight.set(flightKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(flightKey);
  }
}

async function fetchOne(actor: Actor, ctx: CardAccess, input: { contentId: string; kind: ResourceKind }): Promise<ResolvedResourceDTO> {
  const contentId = normalizeContentId(input.contentId);
  const assetId = contentId ? assetIdOf(contentId) : null;
  if (!contentId || !assetId) throw invalid("Only rbxassetid:// content can be fetched from Roblox.");
  // A file someone provided for this project always wins over Roblox's copy.
  const provided = (await listResources(actor, { cardId: ctx.card.id, contentIds: [contentId] })).find((r) => r.kind === input.kind && r.source === "upload");
  if (provided) return provided;
  const row = await cacheRobloxAsset(actor, ctx.access.studioId, input.kind, assetId);
  return cacheDTO(row, contentId);
}

/** Downloads a referenced mesh/texture from Roblox into the studio's 7-day cache. */
export async function fetchResourceFromRoblox(actor: Actor, input: { cardId: string; contentId: string; kind: ResourceKind }): Promise<ResolvedResourceDTO> {
  const ctx = await requireCard(actor.userId, input.cardId);
  if (!canProvideResources(ctx)) throw forbidden("You don't have permission to provide files for this card.");
  return fetchOne(actor, ctx, input);
}

/** Parallel downloads per batch. */
const FETCH_CONCURRENCY = 6;

export interface FetchManyResult {
  contentId: string;
  kind: ResourceKind;
  resource: ResolvedResourceDTO | null;
  error: { code: string; message: string; retryAfterMs?: number } | null;
}

/**
 * What a preview calls when it opens: every missing asset in one request, fetched one at a
 * time. If Roblox asks Forge to slow down, the rest are returned as "try again later".
 */
export async function fetchManyFromRoblox(
  actor: Actor,
  input: { cardId: string; items: Array<{ contentId: string; kind: ResourceKind }> },
): Promise<FetchManyResult[]> {
  const ctx = await requireCard(actor.userId, input.cardId);
  if (!canProvideResources(ctx)) throw forbidden("You don't have permission to provide files for this card.");
  // A few downloads at a time (Roblox allows 1000/min per key owner); once Roblox asks for a
  // pause, nothing new starts and the rest are reported as "try again later".
  const items = input.items;
  const results: FetchManyResult[] = new Array(items.length);
  let busy: AppError | null = null;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index]!;
      if (busy) {
        results[index] = { ...item, resource: null, error: { code: busy.code, message: busy.message, retryAfterMs: Number(busy.details?.retryAfterMs) || undefined } };
        continue;
      }
      try {
        results[index] = { ...item, resource: await fetchOne(actor, ctx, item), error: null };
      } catch (error) {
        const appError = error instanceof AppError ? error : null;
        if (appError?.code === "RATE_LIMITED") busy = appError;
        if (!appError) console.error("[forge] Roblox fetch failed", error);
        results[index] = {
          ...item,
          resource: null,
          error: {
            code: appError?.code ?? "INTERNAL",
            message: appError?.message ?? "Fetching this asset failed unexpectedly.",
            retryAfterMs: Number(appError?.details?.retryAfterMs) || undefined,
          },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
  return results;
}

// ── Rigs & preview settings ─────────────────────────────────────────────────

export interface RigCandidateDTO {
  attachmentId: string;
  filename: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
  deliverableName: string | null;
  rigCount: number;
  manifestUrl: string;
  sameCard: boolean;
}

/** Roblox files in this project that contain a rig (Motor6D joints), newest revision first. */
export async function listRigCandidates(actor: Actor, input: { cardId: string }): Promise<RigCandidateDTO[]> {
  const ctx = await requireCard(actor.userId, input.cardId);
  const rows = await db
    .select({ a: attachments, cardNumber: cards.number, cardTitle: cards.title, deliverableName: deliverables.name })
    .from(attachments)
    .innerJoin(cards, eq(cards.id, attachments.cardId))
    .leftJoin(deliverables, eq(deliverables.id, attachments.deliverableId))
    .where(
      and(
        eq(attachments.projectId, ctx.card.projectId),
        eq(attachments.kind, "ROBLOX"),
        eq(attachments.status, "READY"),
        isNull(attachments.archivedAt),
        isNull(cards.archivedAt),
      ),
    )
    .orderBy(desc(attachments.createdAt))
    .limit(200);
  const out: RigCandidateDTO[] = [];
  for (const { a, cardNumber, cardTitle, deliverableName } of rows) {
    const meta = a.meta as Partial<RobloxFileMeta> | null;
    const derivedKey = derivedKeyOf(a);
    if (!meta?.rigCount || !derivedKey) continue;
    out.push({
      attachmentId: a.id,
      filename: a.filename,
      cardId: a.cardId,
      cardKey: `${ctx.access.project.key}-${cardNumber}`,
      cardTitle,
      deliverableName,
      rigCount: meta.rigCount,
      manifestUrl: await storage().signedUrl(derivedKey),
      sameCard: a.cardId === ctx.card.id,
    });
  }
  return out.sort((x, y) => Number(y.sameCard) - Number(x.sameCard));
}

/** Persists viewer choices that belong with the file (e.g. which rig plays this animation). */
export async function setPreviewConfig(
  actor: Actor,
  input: { attachmentId: string; rigAttachmentId?: string | null; rigNode?: number | null },
) {
  const [file] = await db.select().from(attachments).where(eq(attachments.id, input.attachmentId));
  if (!file || file.kind !== "ROBLOX") throw notFound("File");
  const ctx = await requireCard(actor.userId, file.cardId).catch(() => {
    throw notFound("File");
  });
  let allowed = ctx.perms.canEdit || ctx.perms.canUpload;
  if (!allowed && file.deliverableId) {
    const [d] = await db.select().from(deliverables).where(eq(deliverables.id, file.deliverableId));
    allowed = Boolean(d && computeDeliverablePermissions(ctx, d).canUpload);
  }
  if (!allowed) throw forbidden("You don't have permission to change how this file is previewed.");
  if (input.rigAttachmentId) {
    const [rig] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, input.rigAttachmentId), eq(attachments.projectId, file.projectId), eq(attachments.kind, "ROBLOX")));
    if (!rig) throw notFound("Rig file");
    await requireCard(actor.userId, rig.cardId);
  }
  const previewConfig = {
    ...(file.previewConfig ?? {}),
    rigAttachmentId: input.rigAttachmentId ?? null,
    rigNode: input.rigNode ?? null,
    updatedById: actor.userId,
  };
  await db.update(attachments).set({ previewConfig }).where(eq(attachments.id, file.id));
  new Effects().card(ctx.card.projectId, ctx.card.id, false).flush(actor.clientId);
  return { previewConfig };
}

/** Re-derives the preview (after a parser upgrade or a failed attempt). The original upload is untouched. */
export async function rebuildPreview(actor: Actor, input: { attachmentId: string }) {
  const [file] = await db.select().from(attachments).where(eq(attachments.id, input.attachmentId));
  if (!file || file.kind !== "ROBLOX") throw notFound("File");
  const ctx = await requireCard(actor.userId, file.cardId).catch(() => {
    throw notFound("File");
  });
  if (!ctx.perms.canComment) throw forbidden();
  enforceRateLimit(`roblox-rebuild:${actor.userId}`, 20, 10 * 60 * 1000);
  if (file.meta?.processor === ROBLOX_PROCESSOR && !file.meta?.previewError && file.status === "READY") {
    return { queued: false };
  }
  await db.update(attachments).set({ status: "PROCESSING" }).where(eq(attachments.id, file.id));
  scheduleRobloxWork(file, ctx.card.projectId, ctx.card.id);
  new Effects().card(ctx.card.projectId, ctx.card.id, false).flush(actor.clientId);
  return { queued: true };
}
