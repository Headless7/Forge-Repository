import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { mediaAnnotations, notifications } from "@/server/db/schema";
import { expectAppError, mp4Buffer, pngBuffer, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import * as comments from "./comments";
import * as media from "./media";

let f: Fixture;
let cardId: string;
beforeAll(async () => {
  f = await setupStudio();
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Commented", assigneeIds: [f.member.id] });
  cardId = card.id;
});

async function versionWith(file: { name: string; type: string; buffer: Buffer }) {
  const version = await media.createVersion(f.member.actor, { cardId });
  const attachment = await upload(f.member.actor, cardId, file, "version", version.id);
  return { version, attachment };
}

describe("comment creation", () => {
  it("creates discussion comments and threaded replies, notifying the right people", async () => {
    let detail = await comments.createComment(f.manager.actor, { cardId, body: `Which package is this? @${f.member2.username} might know` });
    const root = detail.comments.at(-1)!;
    expect(root.kind).toBe("DISCUSSION");
    expect(root.mentions).toEqual([f.member2.id]);

    detail = await comments.createComment(f.member.actor, { cardId, parentId: root.id, body: "Using the custom rig." });
    const thread = detail.comments.find((c) => c.id === root.id)!;
    expect(thread.replies.map((r) => r.body)).toEqual(["Using the custom rig."]);

    const mention = await db.select().from(notifications).where(and(eq(notifications.userId, f.member2.id), eq(notifications.type, "MENTIONED")));
    expect(mention).toHaveLength(1);
    const reply = await db.select().from(notifications).where(and(eq(notifications.userId, f.manager.id), eq(notifications.type, "REPLY")));
    expect(reply).toHaveLength(1);
    // The assignee is told about comments on their card (but never about their own).
    const onMyCard = await db.select().from(notifications).where(and(eq(notifications.userId, f.member.id), eq(notifications.type, "COMMENT")));
    expect(onMyCard.length).toBeGreaterThan(0);
  });

  it("rejects empty comments, viewers, and nested replies", async () => {
    await expectAppError(comments.createComment(f.manager.actor, { cardId, body: "   " }), "VALIDATION");
    await expectAppError(comments.createComment(f.viewer.actor, { cardId, body: "hi" }), "FORBIDDEN");
    const detail = await comments.createComment(f.manager.actor, { cardId, body: "parent" });
    const parent = detail.comments.at(-1)!;
    const withReply = await comments.createComment(f.member.actor, { cardId, parentId: parent.id, body: "child" });
    const child = withReply.comments.find((c) => c.id === parent.id)!.replies[0]!;
    await expectAppError(comments.createComment(f.manager.actor, { cardId, parentId: child.id, body: "grandchild" }), "VALIDATION");
  });

  it("lets authors edit, and authors or moderators delete (softly)", async () => {
    let detail = await comments.createComment(f.member.actor, { cardId, body: "draft" });
    const mine = detail.comments.at(-1)!;
    await expectAppError(comments.editComment(f.manager.actor, { commentId: mine.id, body: "hijack" }), "FORBIDDEN");
    detail = await comments.editComment(f.member.actor, { commentId: mine.id, body: "final" });
    expect(detail.comments.find((c) => c.id === mine.id)?.editedAt).not.toBeNull();
    await expectAppError(comments.deleteComment(f.member2.actor, { commentId: mine.id }), "FORBIDDEN");
    detail = await comments.deleteComment(f.manager.actor, { commentId: mine.id });
    expect(detail.comments.find((c) => c.id === mine.id)).toBeUndefined();
  });

  it("toggles emoji reactions and rejects unknown ones", async () => {
    let detail = await comments.createComment(f.manager.actor, { cardId, body: "react to me" });
    const c = detail.comments.at(-1)!;
    detail = await comments.toggleReaction(f.member.actor, { commentId: c.id, emoji: "🔥" });
    expect(detail.comments.find((x) => x.id === c.id)?.reactions).toEqual([{ emoji: "🔥", userIds: [f.member.id] }]);
    detail = await comments.toggleReaction(f.member.actor, { commentId: c.id, emoji: "🔥" });
    expect(detail.comments.find((x) => x.id === c.id)?.reactions).toEqual([]);
    await expectAppError(comments.toggleReaction(f.member.actor, { commentId: c.id, emoji: "<script>" }), "VALIDATION");
  });
});

describe("timestamp comments", () => {
  it("anchors feedback to a moment of a specific video version", async () => {
    const { version, attachment } = await versionWith({ name: "clip.mp4", type: "video/mp4", buffer: mp4Buffer(2) });
    expect(attachment.durationMs).toBeGreaterThan(1800);
    const detail = await comments.createComment(f.manager.actor, {
      cardId,
      kind: "FEEDBACK",
      body: "The arm clips through the weapon here.",
      attachmentId: attachment.id,
      annotation: { type: "TIMESTAMP", timestampMs: 1730 },
    });
    const note = detail.comments.at(-1)!;
    expect(note.kind).toBe("FEEDBACK");
    expect(note.versionId).toBe(version.id);
    expect(note.annotation).toMatchObject({ type: "TIMESTAMP", timestampMs: 1730, attachmentId: attachment.id, versionId: version.id });

    // A later version doesn't move the feedback.
    const next = await media.createVersion(f.member.actor, { cardId });
    const [stored] = await db.select().from(mediaAnnotations).where(eq(mediaAnnotations.commentId, note.id));
    expect(stored?.versionId).toBe(version.id);
    expect(stored?.versionId).not.toBe(next.id);
  });

  it("rejects timestamps past the end, negative or on images", async () => {
    const { attachment: video } = await versionWith({ name: "short.mp4", type: "video/mp4", buffer: mp4Buffer(2) });
    await expectAppError(
      comments.createComment(f.manager.actor, { cardId, kind: "FEEDBACK", body: "too late", attachmentId: video.id, annotation: { type: "TIMESTAMP", timestampMs: 60_000 } }),
      "VALIDATION",
    );
    await expectAppError(
      comments.createComment(f.manager.actor, { cardId, kind: "FEEDBACK", body: "negative", attachmentId: video.id, annotation: { type: "TIMESTAMP", timestampMs: -5 } }),
      "VALIDATION",
    );
    const { attachment: image } = await versionWith({ name: "still.png", type: "image/png", buffer: await pngBuffer() });
    await expectAppError(
      comments.createComment(f.manager.actor, { cardId, kind: "FEEDBACK", body: "no", attachmentId: image.id, annotation: { type: "TIMESTAMP", timestampMs: 100 } }),
      "VALIDATION",
    );
  });
});

describe("image annotation coordinates", () => {
  it("stores pins as normalised coordinates on the image's version", async () => {
    const { version, attachment } = await versionWith({ name: "UI.png", type: "image/png", buffer: await pngBuffer(1600, 900) });
    const detail = await comments.createComment(f.manager.actor, {
      cardId,
      kind: "FEEDBACK",
      body: "Increase spacing here.",
      attachmentId: attachment.id,
      annotation: { type: "POINT", x: 0.1875, y: 0.5 },
    });
    const note = detail.comments.at(-1)!;
    expect(note.annotation).toMatchObject({ type: "POINT", x: 0.1875, y: 0.5, versionId: version.id });
    // Normalised → pixel mapping is exact at any display size.
    expect(note.annotation!.x! * 1600).toBeCloseTo(300);
    expect(note.annotation!.y! * 900).toBeCloseTo(450);
  });

  it("stores regions and rejects coordinates outside the image", async () => {
    const { attachment } = await versionWith({ name: "map.png", type: "image/png", buffer: await pngBuffer(800, 800) });
    const ok = await comments.createComment(f.manager.actor, {
      cardId,
      kind: "FEEDBACK",
      body: "This whole area",
      attachmentId: attachment.id,
      annotation: { type: "REGION", x: 0.25, y: 0.25, width: 0.5, height: 0.25 },
    });
    expect(ok.comments.at(-1)?.annotation).toMatchObject({ type: "REGION", width: 0.5, height: 0.25 });
    for (const bad of [
      { type: "POINT" as const, x: 1.2, y: 0.5 },
      { type: "POINT" as const, x: 0.5, y: -0.1 },
      { type: "REGION" as const, x: 0.8, y: 0.1, width: 0.5, height: 0.1 },
    ]) {
      await expectAppError(comments.createComment(f.manager.actor, { cardId, kind: "FEEDBACK", body: "bad", attachmentId: attachment.id, annotation: bad }), "VALIDATION");
    }
  });

  it("lets the people on the card resolve and reopen feedback", async () => {
    const detail = await comments.createComment(f.manager.actor, { cardId, kind: "FEEDBACK", body: "Darker here" });
    const note = detail.comments.at(-1)!;
    await expectAppError(comments.setFeedbackResolved(f.viewer.actor, { commentId: note.id, resolved: true }), "FORBIDDEN");
    await expectAppError(comments.setFeedbackResolved(f.member2.actor, { commentId: note.id, resolved: true }), "FORBIDDEN");
    const resolved = await comments.setFeedbackResolved(f.member.actor, { commentId: note.id, resolved: true });
    expect(resolved.comments.find((c) => c.id === note.id)?.resolvedById).toBe(f.member.id);
    const reopened = await comments.setFeedbackResolved(f.manager.actor, { commentId: note.id, resolved: false });
    expect(reopened.comments.find((c) => c.id === note.id)?.resolvedAt).toBeNull();
  });
});
