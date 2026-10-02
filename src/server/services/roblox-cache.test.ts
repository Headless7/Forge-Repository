import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Roblox is simulated: no test ever talks to the real service.
vi.mock("@/server/security/safe-fetch", () => ({ safeFetch: vi.fn() }));

import { db } from "@/server/db";
import { robloxAssetCache } from "@/server/db/schema";
import { safeFetch } from "@/server/security/safe-fetch";
import { storage } from "@/server/storage";
import { pngBuffer, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as roblox from "./roblox";

const DAY = 24 * 60 * 60 * 1000;
const TEXTURE = "rbxassetid://9100000001";
const MESH = "rbxassetid://9100000002";
const MESH_FILE = Buffer.from("version 1.00\n1\n[1,0,0][0,0,1][0,0][0,1,0][0,0,1][1,0][0,0,1][0,0,1][0,1]");

let f: Fixture;
let png: Buffer;
let cardId: string;
const robloxApi = vi.fn<(url: string) => Response>();

beforeAll(async () => {
  f = await setupStudio();
  png = await pngBuffer(8, 8);
  cardId = (await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.ui, title: "Shop UI", assigneeIds: [f.member.id] })).id;
  // Both of Roblox's endpoints answer with a CDN location for the asset id in the URL.
  vi.stubGlobal("fetch", (url: string) => Promise.resolve(robloxApi(url)));
  vi.mocked(safeFetch).mockImplementation(async (url: string) => ({
    buffer: url.endsWith("9100000002") ? MESH_FILE : png,
    contentType: "application/octet-stream",
    finalUrl: url,
  }));
});

beforeEach(() => {
  robloxApi.mockReset();
  robloxApi.mockImplementation((url: string) => {
    const id = /(\d+)$/.exec(url)?.[1] ?? /id=(\d+)/.exec(url)?.[1];
    const location = `https://fts.rbxcdn.com/test/${id}`;
    const body = url.includes("asset-delivery-api") ? { location } : { locations: [{ location }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "x-ratelimit-remaining": "999" } });
  });
});

const items = [
  { contentId: TEXTURE, kind: "texture" as const },
  { contentId: MESH, kind: "mesh" as const },
];

async function cacheRow(assetId: string) {
  const [row] = await db.select().from(robloxAssetCache).where(and(eq(robloxAssetCache.studioId, f.studioId), eq(robloxAssetCache.assetId, assetId)));
  return row;
}

describe("Roblox asset cache", () => {
  it("downloads an asset once, then serves it from the studio's cache", async () => {
    const first = await roblox.fetchManyFromRoblox(f.member.actor, { cardId, items });
    expect(first.map((r) => r.error)).toEqual([null, null]);
    expect(first.map((r) => r.resource?.source)).toEqual(["roblox", "roblox"]);
    expect(first[0]!.resource!.format).toBe("png");
    expect(new Date(first[0]!.resource!.expiresAt!).getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
    expect(robloxApi).toHaveBeenCalledTimes(2);

    // Again: no request to Roblox at all.
    const again = await roblox.fetchManyFromRoblox(f.member.actor, { cardId, items });
    expect(again.every((r) => r.resource)).toBe(true);
    expect(robloxApi).toHaveBeenCalledTimes(2);

    // Anyone in the project sees cached assets — even viewers, who can't fetch.
    const seen = await roblox.listResources(f.viewer.actor, { cardId, contentIds: [TEXTURE, MESH] });
    expect(seen.map((r) => `${r.kind}:${r.source}`).sort()).toEqual(["mesh:roblox", "texture:roblox"]);
    await expect(roblox.fetchManyFromRoblox(f.viewer.actor, { cardId, items })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps each studio's cache to itself", async () => {
    const other = await cardService.createCard(f.outsider.actor, { projectId: f.otherProjectId, columnId: f.otherColumnId, title: "Their UI" });
    expect(await roblox.listResources(f.outsider.actor, { cardId: other.id, contentIds: [TEXTURE, MESH] })).toEqual([]);
  });

  it("frees assets after 7 days without being requested; using one restarts its 7 days", async () => {
    await roblox.fetchManyFromRoblox(f.member.actor, { cardId, items });
    const texture = (await cacheRow("9100000001"))!;
    await db.update(robloxAssetCache).set({ lastAccessedAt: new Date(Date.now() - 8 * DAY) }).where(eq(robloxAssetCache.assetId, "9100000001"));
    await db.update(robloxAssetCache).set({ lastAccessedAt: new Date(Date.now() - 6 * DAY) }).where(eq(robloxAssetCache.assetId, "9100000002"));

    expect(await roblox.evictStaleRobloxAssets()).toBeGreaterThanOrEqual(1);
    expect(await cacheRow("9100000001")).toBeUndefined();
    expect(await storage().stat(texture.storageKey)).toBeNull();
    expect(await cacheRow("9100000002")).toBeDefined();

    // Requesting the mesh restarts its clock, so it outlives its original 7 days…
    await roblox.listResources(f.member.actor, { cardId, contentIds: [MESH] });
    expect(Date.now() - (await cacheRow("9100000002"))!.lastAccessedAt.getTime()).toBeLessThan(60_000);
    await roblox.evictStaleRobloxAssets(new Date(Date.now() + 2 * DAY));
    expect(await cacheRow("9100000002")).toBeDefined();
    // …until it goes unused for 7 days.
    await roblox.evictStaleRobloxAssets(new Date(Date.now() + 8 * DAY));
    expect(await cacheRow("9100000002")).toBeUndefined();

    // A freed asset is simply fetched again when it's next needed.
    const refetched = await roblox.fetchManyFromRoblox(f.member.actor, { cardId, items });
    expect(refetched.every((r) => r.resource)).toBe(true);
  });

  it("prefers a file the team uploaded over Roblox's copy", async () => {
    const file = await upload(f.member.actor, cardId, { name: "shop_icon.png", type: "image/png", buffer: await pngBuffer(4, 4, "#ff0000") }, "resource");
    await roblox.resolveResource(f.member.actor, { cardId, contentId: TEXTURE, kind: "texture", attachmentId: file.id });
    const [texture] = await roblox.listResources(f.member.actor, { cardId, contentIds: [TEXTURE] });
    expect(texture).toMatchObject({ source: "upload", filename: "shop_icon.png", expiresAt: null });
    robloxApi.mockClear();
    const [result] = await roblox.fetchManyFromRoblox(f.member.actor, { cardId, items: [items[0]!] });
    expect(result!.resource!.source).toBe("upload");
    expect(robloxApi).not.toHaveBeenCalled();
  });

  // Last: it leaves the module paused, as Roblox asked.
  it("waits when Roblox says to slow down instead of failing every asset", async () => {
    robloxApi.mockImplementation(() => new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
    const items = Array.from({ length: 10 }, (_, k) => ({ contentId: `rbxassetid://91000001${k}`, kind: "texture" as const }));
    const results = await roblox.fetchManyFromRoblox(f.member.actor, { cardId, items });
    expect(results.every((r) => r.error?.code === "RATE_LIMITED")).toBe(true);
    expect(results[0]!.error!.retryAfterMs).toBeGreaterThan(100_000);
    // Only the downloads already under way asked Roblox; nothing new started after the pause.
    expect(robloxApi.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
