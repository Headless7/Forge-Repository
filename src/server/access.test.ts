import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "@/server/auth/crypto";
import { db } from "@/server/db";
import { invitations } from "@/server/db/schema";
import { createUser, expectAppError, pngBuffer, setupStudio, upload, type Fixture, primaryDeliverable } from "@/test/helpers";
import { eq } from "drizzle-orm";
import { getProjectAccess, requireCard } from "./access";
import * as board from "./services/board";
import * as cardService from "./services/cards";
import * as comments from "./services/comments";
import * as labels from "./services/labels";
import * as media from "./services/media";
import * as projects from "./services/projects";
import * as reviews from "./services/reviews";
import { searchCards } from "./services/search";
import * as studios from "./services/studios";

let f: Fixture;
let cardId: string;
beforeAll(async () => {
  f = await setupStudio();
  cardId = (await cardService.createCard(f.owner.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Secret sauce" })).id;
});

describe("project isolation", () => {
  it("never exposes another studio's project, board or cards — even by ID", async () => {
    const o = f.outsider.actor;
    expect(await getProjectAccess(f.outsider.id, f.projectId)).toBeNull();
    await expectAppError(board.getBoard(o, f.projectId), "NOT_FOUND");
    await expectAppError(requireCard(f.outsider.id, cardId), "NOT_FOUND");
    await expectAppError(cardService.getCardDetail(o, cardId), "NOT_FOUND");
    await expectAppError(cardService.updateCard(o, { cardId, title: "pwned" }), "NOT_FOUND");
    await expectAppError(cardService.moveCard(o, { cardId, toColumnId: f.otherColumnId }), "NOT_FOUND");
    await expectAppError(comments.createComment(o, { cardId, body: "hi" }), "NOT_FOUND");
    await expectAppError(reviews.approve(o, { deliverableId: await primaryDeliverable(cardId) }), "NOT_FOUND");
    await expectAppError(media.createUpload(o, { cardId, filename: "a.png", size: 10, contentType: "image/png", purpose: "attachment" }), "NOT_FOUND");
    await expectAppError(cardService.createCard(o, { projectId: f.projectId, columnId: f.columns.vfx, title: "x" }), "NOT_FOUND");
    await expectAppError(projects.updateProject(o, { projectId: f.projectId, name: "x" }), "NOT_FOUND");
    await expectAppError(studios.listMembers(o, f.studioId), "NOT_FOUND");
    expect(await searchCards(o, { studioId: f.otherStudioId, q: "Secret" })).toEqual([]);
    await expectAppError(searchCards(o, { studioId: f.studioId, q: "Secret" }), "NOT_FOUND");
  });

  it("can't mix resources across projects (labels, columns, attachments)", async () => {
    const foreignLabel = await labels.createLabel(f.outsider.actor, { projectId: f.otherProjectId, name: "Theirs", color: "#ff0000" });
    await expectAppError(cardService.setLabels(f.owner.actor, { cardId, labelIds: [foreignLabel.id] }), "NOT_FOUND");
    const foreignCard = await cardService.createCard(f.outsider.actor, { projectId: f.otherProjectId, columnId: f.otherColumnId, title: "Theirs" });
    const foreignFile = await upload(f.outsider.actor, foreignCard.id, { name: "x.png", type: "image/png", buffer: await pngBuffer() });
    await expectAppError(comments.createComment(f.owner.actor, { cardId, body: "pin", attachmentId: foreignFile.id, annotation: { type: "POINT", x: 0.5, y: 0.5 } }), "NOT_FOUND");
    await expectAppError(comments.createComment(f.owner.actor, { cardId, body: "steal", attachmentIds: [foreignFile.id] }), "VALIDATION");
  });

  it("hides private projects from studio members who weren't added", async () => {
    const hidden = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: "Top Secret", visibility: "PRIVATE", template: "empty" });
    expect(await getProjectAccess(f.member.id, hidden.id)).toBeNull();
    expect(await getProjectAccess(f.admin.id, hidden.id)).not.toBeNull();
    expect((await projects.listProjects(f.member.actor, f.studioId)).map((p) => p.id)).not.toContain(hidden.id);
    await projects.setProjectMember(f.owner.actor, { projectId: hidden.id, userId: f.member.id, member: true, role: "MANAGER" });
    const access = await getProjectAccess(f.member.id, hidden.id);
    expect(access?.role).toBe("MANAGER");
  });
});

describe("roles and permissions", () => {
  it("enforces the role matrix server-side", async () => {
    await expectAppError(board.createColumn(f.member.actor, { projectId: f.projectId, name: "Nope" }), "FORBIDDEN");
    await expect(board.createColumn(f.manager.actor, { projectId: f.projectId, name: "Sound Design" })).resolves.toMatchObject({ name: "Sound Design" });
    await expectAppError(projects.updateProject(f.manager.actor, { projectId: f.projectId, name: "x" }), "FORBIDDEN");
    await expectAppError(projects.createProject(f.manager.actor, { studioId: f.studioId, name: "Mine" }), "FORBIDDEN");
    await expectAppError(cardService.updateCard(f.member.actor, { cardId, title: "not mine" }), "FORBIDDEN");
    await expectAppError(cardService.updateCard(f.viewer.actor, { cardId, title: "viewer" }), "FORBIDDEN");
    await expect(cardService.updateCard(f.manager.actor, { cardId, priority: "HIGH" })).resolves.toMatchObject({ priority: "HIGH" });
  });

  it("limits who can grant which roles and protects the last owner", async () => {
    await expectAppError(studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: f.member.id, role: "OWNER" }), "FORBIDDEN");
    await expectAppError(studios.updateMember(f.manager.actor, { studioId: f.studioId, userId: f.member.id, role: "MANAGER" }), "FORBIDDEN");
    await expectAppError(studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: f.owner.id, role: "CONTRIBUTOR" }), "FORBIDDEN");
    await expectAppError(studios.removeMember(f.owner.actor, { studioId: f.studioId, userId: f.owner.id }), "CONFLICT");
    const members = await studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: f.member2.id, role: "MANAGER" });
    expect(members.find((m) => m.id === f.member2.id)?.role).toBe("MANAGER");
  });

  it("invitations are single-use, email-bound and expire", async () => {
    const invitee = await createUser("Invitee");
    const invite = await studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: invitee.email, role: "CONTRIBUTOR" });
    const token = invite.url.split("/invite/")[1]!;
    await expectAppError(studios.acceptInvitation(f.member.actor, { token }), "FORBIDDEN");
    await expect(studios.acceptInvitation(invitee.actor, { token })).resolves.toHaveProperty("studioSlug");
    await expectAppError(studios.acceptInvitation(invitee.actor, { token }), "CONFLICT");
    expect(await getProjectAccess(invitee.id, f.projectId)).not.toBeNull();

    const late = await createUser("Late");
    const expiring = await studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: late.email, role: "VIEWER" });
    const expToken = expiring.url.split("/invite/")[1]!;
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.tokenHash, hashToken(expToken)));
    await expectAppError(studios.acceptInvitation(late.actor, { token: expToken }), "VALIDATION");
    await expectAppError(studios.createInvitation(f.manager.actor, { studioId: f.studioId, email: "x@y.dev", role: "CONTRIBUTOR" }), "FORBIDDEN");
  });
});
