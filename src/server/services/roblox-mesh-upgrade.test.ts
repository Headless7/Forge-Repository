import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { parseRobloxMesh } from "@/lib/roblox/mesh";
import { db } from "@/server/db";
import { attachments, robloxAssetCache } from "@/server/db/schema";
import { siblingKey } from "@/server/media/process";
import { storage } from "@/server/storage";
import { dracoSkinnedCube } from "@/test/roblox-meshes";
import { setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as roblox from "./roblox";

/**
 * Meshes decoded by an older converter (v2, which dropped the skeleton) must be rebuilt from the
 * kept original when they're next served — for assets fetched from Roblox and files people uploaded.
 */
let f: Fixture;
let cardId: string;
let original: Buffer;

beforeAll(async () => {
  f = await setupStudio();
  cardId = (await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Wolf" })).id;
  original = Buffer.from(await dracoSkinnedCube());
});

const OLD_COPY = Buffer.from("version 2.00\n(old decoded copy without bones)");
const keyOf = (url: string) => decodeURIComponent(new URL(url, "http://local").pathname.replace(/^\/api\/files\//, ""));

async function servedMesh(url: string) {
  const local = await storage().materialize(keyOf(url));
  try {
    const { readFile } = await import("node:fs/promises");
    return parseRobloxMesh(new Uint8Array(await readFile(local.path)));
  } finally {
    await local.cleanup();
  }
}

describe("upgrading decoded meshes", () => {
  it("rebuilds a cached Roblox asset's decoded copy, keeps the skeleton and drops the old copy", async () => {
    const assetId = "9200000001";
    const base = `roblox-cache/${f.studioId}/mesh/${assetId}`;
    await storage().put(`${base}/original.mesh`, original, "application/octet-stream");
    await storage().put(`${base}/decoded-v2.mesh`, OLD_COPY, "application/octet-stream");
    await db.insert(robloxAssetCache).values({
      studioId: f.studioId,
      kind: "mesh",
      assetId,
      storageKey: `${base}/original.mesh`,
      convertedKey: `${base}/decoded-v2.mesh`,
      format: "mesh",
      filename: `roblox-${assetId}.mesh`,
      sizeBytes: original.length,
      fetchedAt: new Date(),
      lastAccessedAt: new Date(),
    });

    const [res] = await roblox.listResources(f.member.actor, { cardId, contentIds: [`rbxassetid://${assetId}`] });
    expect(keyOf(res!.url)).toBe(`${base}/decoded-v3.mesh`);
    const mesh = await servedMesh(res!.url);
    expect(mesh.skin?.bones.map((b) => b.name)).toEqual(["Lower", "Upper"]);
    const [row] = await db.select().from(robloxAssetCache).where(and(eq(robloxAssetCache.studioId, f.studioId), eq(robloxAssetCache.assetId, assetId)));
    expect(row!.convertedKey).toBe(`${base}/decoded-v3.mesh`);
    expect(await storage().stat(`${base}/decoded-v2.mesh`)).toBeNull();
    expect(await storage().stat(`${base}/original.mesh`)).not.toBeNull(); // the original is never touched
  });

  it("rebuilds an uploaded mesh's decoded copy and keeps the rest of its metadata", async () => {
    const contentId = "rbxassetid://9200000002";
    const file = await upload(f.manager.actor, cardId, { name: "wolf_body.mesh", type: "application/octet-stream", buffer: original }, "resource");
    await roblox.resolveResource(f.manager.actor, { cardId, contentId, kind: "mesh", attachmentId: file.id });
    // Pretend it was decoded by the old converter.
    const [row] = await db.select().from(attachments).where(eq(attachments.id, file.id));
    const oldKey = siblingKey(row!.storageKey, "decoded-v2.mesh");
    await storage().put(oldKey, OLD_COPY, "application/octet-stream");
    await db.update(attachments).set({ meta: { ...row!.meta, convertedKey: oldKey } }).where(eq(attachments.id, file.id));

    const [res] = await roblox.listResources(f.member.actor, { cardId, contentIds: [contentId] });
    expect(keyOf(res!.url)).toBe(siblingKey(row!.storageKey, "decoded-v3.mesh"));
    expect((await servedMesh(res!.url)).skin?.bones).toHaveLength(2);
    const [after] = await db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(after!.meta).toMatchObject({ resourceFormat: "mesh", contentId, convertedKey: siblingKey(row!.storageKey, "decoded-v3.mesh") });
    expect(await storage().stat(oldKey)).toBeNull();
  });
});
