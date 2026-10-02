import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { attachments, userBoardPrefs } from "@/server/db/schema";
import { mediaQueue } from "@/server/jobs/queue";
import { R, writeBinaryModel } from "@/server/roblox/writer";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as comments from "./comments";
import * as deliverables from "./deliverables";
import * as media from "./media";
import * as production from "./production";
import * as reviews from "./reviews";
import * as roblox from "./roblox";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

function mp3Buffer(): Buffer {
  const file = path.resolve(".data/test-fixtures/tone.mp3");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = spawnSync(ffmpegPath!, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "libmp3lame", "-b:a", "128k", file], { stdio: "ignore" });
    if (r.status !== 0) throw new Error("ffmpeg couldn't create the test mp3");
  }
  return fs.readFileSync(file);
}

async function kitCard(title = "Boss kit") {
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
  const rig = await primaryDeliverable(card.id);
  await deliverables.updateDeliverable(f.manager.actor, { deliverableId: rig, name: "Rig", assetType: "Rig" });
  const detail = await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Animation", assetType: "Animation", ownerId: f.member2.id });
  const anim = detail.deliverables.find((d) => d.name === "Animation")!.id;
  return { card, rig, anim };
}

async function uploadRevision(actor: Fixture["member"]["actor"], cardId: string, deliverableId: string, name = "render.png") {
  const version = await media.createVersion(actor, { deliverableId });
  await upload(actor, cardId, { name, type: "image/png", buffer: await pngBuffer() }, "version", version.id);
  return version;
}

describe("deliverables", () => {
  it("gives every card one deliverable that mirrors the card", async () => {
    const card = await cardService.createCard(f.member.actor, { projectId: f.projectId, columnId: f.columns.ui, title: "Simple" });
    const detail = await cardService.getCardDetail(f.member.actor, card.id);
    expect(detail.deliverables).toHaveLength(1);
    expect(detail.deliverables[0]).toMatchObject({ name: "Simple", required: true, state: "NOT_SUBMITTED" });
    expect(detail.progress).toMatchObject({ total: 1, required: 1, withFiles: 0 });
    await cardService.updateCard(f.member.actor, { cardId: card.id, title: "Renamed" });
    expect((await cardService.getCardDetail(f.member.actor, card.id)).deliverables[0]!.name).toBe("Renamed");
  });

  it("keeps each deliverable's revisions, reviews and feedback independent", async () => {
    const { card, rig, anim } = await kitCard("Independent");
    const rigV1 = await uploadRevision(f.member.actor, card.id, rig);
    await reviews.submitForReview(f.member.actor, { deliverableId: rig });
    await reviews.approve(f.manager.actor, { deliverableId: rig });

    // The animation's owner (not a card assignee) can work on their deliverable.
    const animV1 = await uploadRevision(f.member2.actor, card.id, anim, "anim.png");
    expect(animV1.number).toBe(1);
    const animV2 = await uploadRevision(f.member2.actor, card.id, anim, "anim2.png");
    expect(animV2.number).toBe(2);
    await reviews.submitForReview(f.member2.actor, { deliverableId: anim });
    const file = (await cardService.getCardDetail(f.manager.actor, card.id)).attachments.find((a) => a.versionId === animV2.id)!;
    await comments.createComment(f.manager.actor, { cardId: card.id, kind: "FEEDBACK", body: "Pose clips", attachmentId: file.id, annotation: { type: "POINT", x: 0.5, y: 0.5 } });
    const detail = await reviews.requestChanges(f.manager.actor, { deliverableId: anim });

    const rigD = detail.deliverables.find((d) => d.id === rig)!;
    const animD = detail.deliverables.find((d) => d.id === anim)!;
    expect(rigD).toMatchObject({ state: "APPROVED", approvedVersionId: rigV1.id, versionCount: 1, openFeedback: 0 });
    expect(animD).toMatchObject({ state: "CHANGES_REQUESTED", versionCount: 2, openFeedback: 1 });
    expect(detail.versions.filter((v) => v.deliverableId === rig).map((v) => [v.number, v.status])).toEqual([[1, "APPROVED"]]);
    expect(detail.reviews.filter((r) => r.deliverableId === rig).map((r) => r.action)).toEqual(["SUBMITTED", "APPROVED"]);
    expect(detail.comments.find((c) => c.body === "Pose clips")).toMatchObject({ deliverableId: anim, versionId: animV2.id });
    // The card shows what needs attention first.
    expect(detail.state).toBe("CHANGES_REQUESTED");
    expect(detail.progress).toMatchObject({ total: 2, approved: 1, changesRequested: 1, withFiles: 2 });
  });

  it("connects deliverables without cycles and explains what's blocked", async () => {
    const { card, rig, anim } = await kitCard("Graph");
    let detail = await deliverables.linkDeliverables(f.manager.actor, { cardId: card.id, fromId: rig, toId: anim, type: "DEPENDENCY" });
    expect(detail.deliverables.find((d) => d.id === anim)!.blockedBy).toEqual([rig]);
    await expectAppError(deliverables.linkDeliverables(f.manager.actor, { cardId: card.id, fromId: anim, toId: rig, type: "DEPENDENCY" }), "CONFLICT");
    await expectAppError(deliverables.linkDeliverables(f.manager.actor, { cardId: card.id, fromId: rig, toId: rig, type: "ASSOCIATION" }), "VALIDATION");
    await expectAppError(deliverables.linkDeliverables(f.manager.actor, { cardId: card.id, fromId: rig, toId: anim, type: "DEPENDENCY" }), "CONFLICT");
    const third = (await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "VFX", linkFrom: { id: anim, type: "DEPENDENCY" } })).deliverables.find((d) => d.name === "VFX")!;
    // rig → anim → vfx, so vfx → rig would close a loop.
    await expectAppError(deliverables.linkDeliverables(f.manager.actor, { cardId: card.id, fromId: third.id, toId: rig, type: "DEPENDENCY" }), "CONFLICT");
    detail = await deliverables.linkDeliverables(f.manager.actor, { cardId: card.id, fromId: third.id, toId: rig, type: "ASSOCIATION" });
    expect(detail.deliverableLinks).toHaveLength(3);

    // Approving the prerequisite unblocks; removing a link never touches work.
    await uploadRevision(f.member.actor, card.id, rig);
    await reviews.submitForReview(f.member.actor, { deliverableId: rig });
    detail = await reviews.approve(f.manager.actor, { deliverableId: rig });
    expect(detail.deliverables.find((d) => d.id === anim)!.blockedBy).toEqual([]);
    const link = detail.deliverableLinks.find((l) => l.type === "DEPENDENCY" && l.fromId === rig)!;
    detail = await deliverables.unlinkDeliverables(f.manager.actor, { linkId: link.id });
    expect(detail.deliverables.find((d) => d.id === rig)!.state).toBe("APPROVED");
    expect(detail.versions.filter((v) => v.deliverableId === rig)).toHaveLength(1);
  });

  it("archives deliverables without losing history (never the last one)", async () => {
    const { card, rig, anim } = await kitCard("Archive");
    await uploadRevision(f.member2.actor, card.id, anim);
    let detail = await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: anim, archived: true });
    expect(detail.progress.total).toBe(1);
    expect(detail.versions.filter((v) => v.deliverableId === anim)).toHaveLength(1);
    await expectAppError(deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: rig, archived: true }), "CONFLICT");
    detail = await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: anim, archived: false });
    expect(detail.progress.total).toBe(2);
  });

  it("inherits project access (viewers read, outsiders get NOT_FOUND)", async () => {
    const { card, rig, anim } = await kitCard("Access");
    await expectAppError(deliverables.createDeliverable(f.viewer.actor, { cardId: card.id, name: "Nope" }), "FORBIDDEN");
    await expectAppError(deliverables.linkDeliverables(f.viewer.actor, { cardId: card.id, fromId: rig, toId: anim, type: "ASSOCIATION" }), "FORBIDDEN");
    await expectAppError(media.createVersion(f.viewer.actor, { deliverableId: rig }), "FORBIDDEN");
    // member2 owns only the animation.
    await expectAppError(media.createVersion(f.member2.actor, { deliverableId: rig }), "FORBIDDEN");
    await expect(media.createVersion(f.member2.actor, { deliverableId: anim })).resolves.toMatchObject({ number: 1 });
    const o = f.outsider.actor;
    await expectAppError(deliverables.updateDeliverable(o, { deliverableId: rig, name: "pwned" }), "NOT_FOUND");
    await expectAppError(reviews.approve(o, { deliverableId: rig }), "NOT_FOUND");
    await expectAppError(media.createVersion(o, { deliverableId: rig }), "NOT_FOUND");
    await expectAppError(deliverables.linkDeliverables(o, { cardId: card.id, fromId: rig, toId: anim, type: "ASSOCIATION" }), "NOT_FOUND");
    await expectAppError(production.moveProduction(o, { cardId: card.id, status: "COMPLETED" }), "NOT_FOUND");
  });

  it("scopes discussion to the card or a deliverable", async () => {
    const { card, anim } = await kitCard("Talk");
    const detail = await comments.createComment(f.member.actor, { cardId: card.id, body: "About the anim only", deliverableId: anim });
    await comments.createComment(f.member.actor, { cardId: card.id, body: "About the whole kit" });
    const all = (await cardService.getCardDetail(f.member.actor, card.id)).comments;
    expect(all.find((c) => c.body === "About the anim only")?.deliverableId).toBe(anim);
    expect(all.find((c) => c.body === "About the whole kit")?.deliverableId).toBeNull();
    expect(detail.id).toBe(card.id);
  });
});

describe("production stages", () => {
  it("only completes approved work, records it, and keeps the record after new revisions", async () => {
    const { card, rig, anim } = await kitCard("Ship it");
    // Nothing approved: completion is refused with the reasons.
    const refused = production.moveProduction(f.member.actor, { cardId: card.id, status: "COMPLETED" });
    await expect(refused).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(refused).rejects.toMatchObject({ details: { blockers: expect.arrayContaining([expect.objectContaining({ deliverableId: rig })]) } });

    const rigV1 = await uploadRevision(f.member.actor, card.id, rig);
    await reviews.submitForReview(f.member.actor, { deliverableId: rig });
    await reviews.approve(f.manager.actor, { deliverableId: rig });
    await expectAppError(production.moveProduction(f.member.actor, { cardId: card.id, status: "COMPLETED" }), "CONFLICT");

    const animV1 = await uploadRevision(f.member2.actor, card.id, anim);
    await reviews.submitForReview(f.member2.actor, { deliverableId: anim });
    await reviews.approve(f.manager.actor, { deliverableId: anim });

    await production.moveProduction(f.member.actor, { cardId: card.id, status: "COMPLETED" });
    // Publishing is a manager decision (and never deploys anything).
    await expectAppError(production.moveProduction(f.member.actor, { cardId: card.id, status: "PUBLISHED" }), "FORBIDDEN");
    await production.moveProduction(f.manager.actor, { cardId: card.id, status: "PUBLISHED", note: "Live" });
    let detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.productionStatus).toBe("PUBLISHED");
    expect(detail.productionSnapshot.map((s) => [s.deliverableId, s.versionId])).toEqual([
      [rig, rigV1.id],
      [anim, animV1.id],
    ]);
    expect(detail.productionEvents.map((e) => e.toStatus)).toEqual(["COMPLETED", "PUBLISHED"]);
    expect(detail.pendingChanges).toBe(false);

    // A new revision: still published, record unchanged, change flagged — and not treated as approved.
    await uploadRevision(f.member2.actor, card.id, anim, "anim-v2.png");
    detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.productionStatus).toBe("PUBLISHED");
    expect(detail.productionSnapshot.find((s) => s.deliverableId === anim)!.versionId).toBe(animV1.id);
    expect(detail.pendingChanges).toBe(true);
    expect(detail.readiness.pendingChanges[0]).toMatchObject({ deliverableId: anim });
    expect(detail.deliverables.find((d) => d.id === anim)).toMatchObject({ state: "IN_PROGRESS", approvedVersionId: animV1.id });
    // Can't be re-published until the new revision is approved.
    await expectAppError(production.moveProduction(f.manager.actor, { cardId: card.id, status: "COMPLETED" }), "CONFLICT");

    // Moving between stages never rewrites review history.
    const before = detail.reviews.length;
    await production.moveProduction(f.manager.actor, { cardId: card.id, status: "TODO" });
    detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.reviews).toHaveLength(before);
    expect(detail.deliverables.find((d) => d.id === rig)!.state).toBe("APPROVED");
    expect(detail.productionEvents).toHaveLength(3);
  });

  it("ignores optional deliverables for completion and orders cards within a stage", async () => {
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.ui, title: "With optional", assigneeIds: [f.member.id] });
    const main = await primaryDeliverable(card.id);
    await deliverables.createDeliverable(f.manager.actor, { cardId: card.id, name: "Bonus", required: false });
    await uploadRevision(f.member.actor, card.id, main);
    await reviews.submitForReview(f.member.actor, { deliverableId: main });
    await reviews.approve(f.manager.actor, { deliverableId: main });
    const moved = await production.moveProduction(f.member.actor, { cardId: card.id, status: "COMPLETED", index: 0 });
    expect(moved.productionStatus).toBe("COMPLETED");
    // The unapproved optional deliverable isn't in the record — and isn't a "pending change" either.
    let detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.productionSnapshot.find((s) => s.name === "Bonus")?.versionId).toBeNull();
    expect(detail.pendingChanges).toBe(false);
    // Once it has approved work that the record doesn't include, that is flagged.
    const bonus = detail.deliverables.find((d) => d.name === "Bonus")!.id;
    await uploadRevision(f.member.actor, card.id, bonus);
    detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.pendingChanges).toBe(false);
    await reviews.submitForReview(f.member.actor, { deliverableId: bonus });
    await reviews.approve(f.manager.actor, { deliverableId: bonus });
    detail = await cardService.getCardDetail(f.manager.actor, card.id);
    expect(detail.readiness.pendingChanges).toEqual([expect.objectContaining({ deliverableId: bonus, detail: "V1 is approved but not yet recorded" })]);
  });

  it("remembers each person's board view", async () => {
    await board.setBoardView(f.member.actor, { projectId: f.projectId, view: "PRODUCTION" });
    expect((await board.getBoard(f.member.actor, f.projectId)).prefs.view).toBe("PRODUCTION");
    expect((await board.getBoard(f.manager.actor, f.projectId)).prefs.view).toBe("CATEGORY");
    const rows = await db.select().from(userBoardPrefs).where(eq(userBoardPrefs.userId, f.member.id));
    expect(rows[0]?.view).toBe("PRODUCTION");
  });
});

describe("audio and Roblox uploads", () => {
  it("verifies audio by content, derives a waveform and takes timestamped feedback", async () => {
    const card = await cardService.createCard(f.member.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "SFX" });
    const d = await primaryDeliverable(card.id);
    const v = await media.createVersion(f.member.actor, { deliverableId: d });
    const audio = await upload(f.member.actor, card.id, { name: "hit.mp3", type: "audio/mpeg", buffer: mp3Buffer() }, "version", v.id);
    expect(audio).toMatchObject({ kind: "AUDIO", mimeType: "audio/mpeg", status: "PROCESSING" });
    expect(audio.durationMs).toBeGreaterThan(1000);
    await mediaQueue.onIdle();
    const [row] = await db.select().from(attachments).where(eq(attachments.id, audio.id));
    expect(row!.status).toBe("READY");
    expect(row!.meta).toMatchObject({ codec: "mp3", derivedKey: expect.stringContaining("peaks.json") });
    expect(row!.thumbnailKey).toBeTruthy();
    const detail = await comments.createComment(f.member.actor, { cardId: card.id, kind: "FEEDBACK", body: "Tail is too long", attachmentId: audio.id, annotation: { type: "TIMESTAMP", timestampMs: 900 } });
    expect(detail.comments.find((c) => c.body === "Tail is too long")?.annotation?.timestampMs).toBe(900);
    await expectAppError(
      comments.createComment(f.member.actor, { cardId: card.id, kind: "FEEDBACK", body: "x", attachmentId: audio.id, annotation: { type: "POINT", x: 0.1, y: 0.1 } }),
      "VALIDATION",
    );
    await expectAppError(upload(f.member.actor, card.id, { name: "fake.mp3", type: "audio/mpeg", buffer: Buffer.from("definitely not audio".repeat(10)) }), "VALIDATION");
  });

  it("parses Roblox files in the background and resolves missing resources per project", async () => {
    const card = await cardService.createCard(f.member.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Rig file" });
    const d = await primaryDeliverable(card.id);
    const right = [0, 0, 1, 0, 1, 0, -1, 0, 0];
    const rbxm = Buffer.from(
      writeBinaryModel([
        {
          className: "Model",
          props: { Name: R.str("Dummy") },
          children: [
            { className: "Part", props: { __id: R.str("t"), Name: R.str("Torso"), size: R.v3(2, 2, 1), CFrame: R.cf(0, 3, 0) }, children: [{ className: "Motor6D", props: { Name: R.str("Right Shoulder"), Part0: R.ref("t"), Part1: R.ref("a"), C0: R.cf(1, 0.5, 0, right), C1: R.cf(-0.5, 0.5, 0, right) } }] },
            { className: "MeshPart", props: { __id: R.str("a"), Name: R.str("Right Arm"), size: R.v3(1, 2, 1), CFrame: R.cf(1.5, 3, 0), MeshId: R.str("rbxassetid://42"), TextureID: R.str("rbxassetid://43") } },
          ],
        },
      ]),
    );
    const v = await media.createVersion(f.member.actor, { deliverableId: d });
    const file = await upload(f.member.actor, card.id, { name: "dummy.rbxm", type: "application/octet-stream", buffer: rbxm }, "version", v.id);
    expect(file).toMatchObject({ kind: "ROBLOX", status: "PROCESSING" });
    await mediaQueue.onIdle();
    const detail = await cardService.getCardDetail(f.member.actor, card.id);
    const ready = detail.attachments.find((a) => a.id === file.id)!;
    expect(ready.status).toBe("READY");
    expect(ready.derivedUrl).toBeTruthy();
    expect(ready.meta).toMatchObject({ primary: "model", rigCount: 1, externalResources: 2, format: "binary" });

    // Provide the texture: uploaded as a resource and mapped for the whole project.
    const texture = await upload(f.member.actor, card.id, { name: "arm.png", type: "image/png", buffer: await pngBuffer(64, 64) }, "resource", undefined, d);
    const resolved = await roblox.resolveResource(f.member.actor, { cardId: card.id, contentId: "http://www.roblox.com/asset/?id=43", kind: "texture", attachmentId: texture.id });
    expect(resolved).toMatchObject({ contentId: "rbxassetid://43", kind: "texture", format: "png" });
    // A picture isn't a mesh.
    await expectAppError(roblox.resolveResource(f.member.actor, { cardId: card.id, contentId: "rbxassetid://42", kind: "mesh", attachmentId: texture.id }), "VALIDATION");
    const list = await roblox.listResources(f.member2.actor, { cardId: card.id, contentIds: ["rbxassetid://43", "rbxassetid://42"] });
    expect(list.map((r) => r.contentId)).toEqual(["rbxassetid://43"]);
    await expectAppError(roblox.listResources(f.outsider.actor, { cardId: card.id, contentIds: ["rbxassetid://43"] }), "NOT_FOUND");

    const rigs = await roblox.listRigCandidates(f.member.actor, { cardId: card.id });
    expect(rigs.find((r) => r.attachmentId === file.id)).toMatchObject({ rigCount: 1, sameCard: true });
    await roblox.setPreviewConfig(f.member.actor, { attachmentId: file.id, rigAttachmentId: file.id });
    await expectAppError(roblox.setPreviewConfig(f.viewer.actor, { attachmentId: file.id, rigAttachmentId: null }), "FORBIDDEN");
  });
});
