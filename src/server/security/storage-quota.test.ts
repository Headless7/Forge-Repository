/** Studio storage limits, with a tiny limit (≈10.7 KB) so the edges are easy to reach. */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.STUDIO_STORAGE_LIMIT_GB = "0.00001";
});

import { db } from "@/server/db";
import { attachments } from "@/server/db/schema";
import * as cards from "@/server/services/cards";
import * as media from "@/server/services/media";
import { getStudioStorage, studioStorageLimitBytes, studioStorageUsed } from "@/server/services/storage-quota";
import { storage } from "@/server/storage";
import { expectAppError, setupStudio, type Fixture } from "@/test/helpers";

const LIMIT = 10_737;

function start(f: Fixture, cardId: string, size: number) {
  return media.createUpload(f.member.actor, { cardId, filename: "part.png", size, contentType: "image/png", purpose: "attachment" });
}

describe("studio storage limit", () => {
  let f: Fixture;
  let cardId: string;
  beforeAll(async () => {
    f = await setupStudio();
    cardId = (await cards.createCard(f.member.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Uploads", assigneeIds: [f.member.id] })).id;
  });

  it("is configurable and refuses an upload that would go over it, with a clear message", async () => {
    expect(studioStorageLimitBytes()).toBe(LIMIT);
    await start(f, cardId, 6_000);
    const over = start(f, cardId, 6_000);
    await expectAppError(over, "PAYLOAD_TOO_LARGE");
    await expect(over).rejects.toMatchObject({ details: { code: "STORAGE_FULL" }, message: expect.stringContaining("storage is full") });
  });

  it("doesn't count failed or abandoned uploads", async () => {
    const used = await studioStorageUsed(f.studioId);
    const rows = await db.select().from(attachments).where(eq(attachments.cardId, cardId));
    await db.update(attachments).set({ status: "FAILED" }).where(eq(attachments.id, rows[0]!.id));
    expect(await studioStorageUsed(f.studioId)).toBe(used - 6_000);
    const pending = await start(f, cardId, 5_000);
    await db.update(attachments).set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(attachments.id, pending.attachmentId));
    expect(await studioStorageUsed(f.studioId)).toBe(used - 6_000);
  });

  it("holds even when uploads start at the same moment", async () => {
    const g = await setupStudio();
    const card = (await cards.createCard(g.member.actor, { projectId: g.projectId, columnId: g.columns.vfx, title: "Race", assigneeIds: [g.member.id] })).id;
    const results = await Promise.allSettled([4_000, 4_000, 4_000, 4_000].map((size) => start(g, card, size)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await studioStorageUsed(g.studioId)).toBeLessThanOrEqual(LIMIT);
  });

  it("keeps stored files private: knowing a file's key is not enough", async () => {
    const intent = await start(f, cardId, 100);
    const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
    await storage().put(row!.storageKey, Buffer.alloc(100), "image/png");
    const { GET } = await import("@/app/api/files/[...key]/route");
    const fetchFile = (query: string) =>
      GET(new Request(`http://localhost:3000/api/files/${row!.storageKey}${query}`), { params: Promise.resolve({ key: row!.storageKey.split("/") }) });
    expect((await fetchFile("")).status).toBe(403);
    expect((await fetchFile(`?exp=${Math.floor(Date.now() / 1000) + 600}&sig=forged`)).status).toBe(403);
    // A genuine link works, and only for the file it was made for.
    const signed = new URL(await storage().signedUrl(row!.storageKey), "http://localhost:3000");
    expect((await fetchFile(signed.search)).status).toBe(200);
    const otherKey = row!.storageKey.replace(/original-[^/]+$/, "original-other.png");
    const res = await GET(new Request(`http://localhost:3000/api/files/${otherKey}${signed.search}`), { params: Promise.resolve({ key: otherKey.split("/") }) });
    expect(res.status).toBe(403);
  });

  it("is separate per studio and shown to owners and admins only", async () => {
    const other = await setupStudio();
    expect(await studioStorageUsed(other.studioId)).toBe(0);
    await expect(getStudioStorage(f.admin.actor, f.studioId)).resolves.toMatchObject({ limitBytes: LIMIT });
    await expectAppError(getStudioStorage(f.member.actor, f.studioId), "FORBIDDEN");
    await expectAppError(getStudioStorage(other.owner.actor, f.studioId), "NOT_FOUND");
  });
});
