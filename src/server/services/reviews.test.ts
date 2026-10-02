import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { notifications } from "@/server/db/schema";
import { expectAppError, mp4Buffer, setupStudio, upload, type Fixture, primaryDeliverable } from "@/test/helpers";
import * as cardService from "./cards";
import * as comments from "./comments";
import * as media from "./media";
import * as projects from "./projects";
import * as reviews from "./reviews";

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
});

async function assignedCard(title: string) {
  return cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
}

const typesFor = async (userId: string, cardId: string) =>
  (await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.cardId, cardId)))).map((n) => n.type);

describe("review state transitions", () => {
  it("runs the full lifecycle and preserves every review on the right version", async () => {
    const card = await assignedCard("Hollow Purple");
    const v1 = await media.createVersion(f.member.actor, { cardId: card.id, notes: "first pass" });
    const clip = await upload(f.member.actor, card.id, { name: "gojo_v1.mp4", type: "video/mp4", buffer: mp4Buffer(2) }, "version", v1.id);

    let detail = await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    expect(detail.state).toBe("NEEDS_REVIEW");
    expect(detail.versions[0]?.status).toBe("IN_REVIEW");
    expect(await typesFor(f.manager.id, card.id)).toContain("REVIEW_REQUESTED");

    await comments.createComment(f.manager.actor, {
      cardId: card.id,
      kind: "FEEDBACK",
      body: "Increase the impact here.",
      attachmentId: clip.id,
      annotation: { type: "TIMESTAMP", timestampMs: 1470 },
    });
    detail = await reviews.requestChanges(f.manager.actor, { deliverableId: await primaryDeliverable(card.id), items: ["Reduce camera shake."] });
    expect(detail.state).toBe("CHANGES_REQUESTED");
    expect(detail.versions[0]?.status).toBe("CHANGES_REQUESTED");
    const decision = detail.reviews.at(-1)!;
    expect(decision.action).toBe("CHANGES_REQUESTED");
    // Both the typed item and the earlier timestamp comment belong to the decision.
    expect(decision.feedbackIds).toHaveLength(2);
    expect(await typesFor(f.member.id, card.id)).toContain("CHANGES_REQUESTED");

    // A new version moves the card back into progress; V1 keeps its result.
    const v2 = await media.createVersion(f.member.actor, { cardId: card.id, notes: "fixes" });
    expect(v2.number).toBe(2);
    detail = await cardService.getCardDetail(f.member.actor, card.id);
    expect(detail.state).toBe("IN_PROGRESS");
    expect(detail.deliverables[0]!.currentVersionId).toBe(v2.id);
    await upload(f.member.actor, card.id, { name: "gojo_v2.mp4", type: "video/mp4", buffer: mp4Buffer(2) }, "version", v2.id);

    detail = await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id), versionId: v2.id });
    expect(detail.state).toBe("NEEDS_REVIEW");
    detail = await reviews.approve(f.manager.actor, { deliverableId: await primaryDeliverable(card.id), note: "Ship it" });
    expect(detail.state).toBe("APPROVED");
    expect(detail.versions.map((v) => v.status)).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
    expect(detail.reviews.map((r) => r.action)).toEqual(["SUBMITTED", "CHANGES_REQUESTED", "SUBMITTED", "APPROVED"]);
    expect(detail.reviews.map((r) => r.versionId)).toEqual([v1.id, v1.id, v2.id, v2.id]);
    expect(await typesFor(f.member.id, card.id)).toContain("APPROVED");

    // Feedback from V1 stays attached to V1.
    const timestamped = detail.comments.find((c) => c.body === "Increase the impact here.")!;
    expect(timestamped.versionId).toBe(v1.id);
    expect(timestamped.annotation?.timestampMs).toBe(1470);
  });

  it("requires at least one feedback item when the project asks for it", async () => {
    const card = await assignedCard("Needs words");
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    await expectAppError(reviews.requestChanges(f.manager.actor, { deliverableId: await primaryDeliverable(card.id) }), "VALIDATION");
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, settings: { requireFeedbackForChanges: false } });
    await expect(reviews.requestChanges(f.manager.actor, { deliverableId: await primaryDeliverable(card.id), note: "see call" })).resolves.toMatchObject({ state: "CHANGES_REQUESTED" });
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, settings: { requireFeedbackForChanges: true } });
  });

  it("blocks self-approval unless the project allows it", async () => {
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Own work", assigneeIds: [f.manager.id] });
    await reviews.submitForReview(f.manager.actor, { deliverableId: await primaryDeliverable(card.id) });
    await expectAppError(reviews.approve(f.manager.actor, { deliverableId: await primaryDeliverable(card.id) }), "FORBIDDEN");
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, settings: { allowSelfApproval: true } });
    await expect(reviews.approve(f.manager.actor, { deliverableId: await primaryDeliverable(card.id) })).resolves.toMatchObject({ state: "APPROVED" });
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, settings: { allowSelfApproval: false } });
  });

  it("only reviewers decide; only people on the card submit", async () => {
    const card = await assignedCard("Gatekeeping");
    await expectAppError(reviews.submitForReview(f.member2.actor, { deliverableId: await primaryDeliverable(card.id) }), "FORBIDDEN");
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    await expectAppError(reviews.approve(f.member.actor, { deliverableId: await primaryDeliverable(card.id) }), "FORBIDDEN");
    await expectAppError(reviews.approve(f.viewer.actor, { deliverableId: await primaryDeliverable(card.id) }), "FORBIDDEN");
    await expectAppError(reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) }), "CONFLICT");
    const withdrawn = await reviews.withdrawSubmission(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    expect(withdrawn.state).toBe("IN_PROGRESS");
    expect(withdrawn.reviews.map((r) => r.action)).toEqual(["SUBMITTED", "WITHDRAWN"]);
  });

  it("routes quick status changes through the review workflow", async () => {
    const card = await assignedCard("Quick status");
    let detail = await reviews.setCardState(f.member.actor, { cardId: card.id, state: "IN_PROGRESS" });
    expect(detail.state).toBe("IN_PROGRESS");
    detail = await reviews.setCardState(f.member.actor, { cardId: card.id, state: "NEEDS_REVIEW" });
    expect(detail.reviews.at(-1)?.action).toBe("SUBMITTED");
    detail = await reviews.setCardState(f.manager.actor, { cardId: card.id, state: "APPROVED" });
    expect(detail.reviews.at(-1)?.action).toBe("APPROVED");
    detail = await reviews.setCardState(f.manager.actor, { cardId: card.id, state: "IN_PROGRESS" });
    expect(detail.reviews.at(-1)?.action).toBe("REOPENED");
    await reviews.setCardState(f.member.actor, { cardId: card.id, state: "NEEDS_REVIEW" });
    // Members can't sneak an approval through the quick-status menu.
    await expectAppError(reviews.setCardState(f.member.actor, { cardId: card.id, state: "APPROVED" }), "FORBIDDEN");
  });
});
