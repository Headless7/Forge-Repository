/**
 * Contributor vs Developer (automatic private-project access), and multiple boards per project:
 * independent columns/cards, stable numbers, archiving, moving cards, search, permissions.
 * Every fixture is created here (test database only).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { canGrantRole, hasAutomaticProjectAccess, memberCanOpenProject, normalizeRole, roleLabel } from "@/lib/permissions";
import { accessibleProjectIds, getProjectAccess } from "@/server/access";
import { db } from "@/server/db";
import { auditLogs, boards, cards, projectMembers, studioMembers } from "@/server/db/schema";
import { createUser, expectAppError, setupStudio, type Fixture } from "@/test/helpers";
import * as board from "@/server/services/board";
import * as cardService from "@/server/services/cards";
import { filterProjectMembers } from "@/server/services/members-query";
import * as projects from "@/server/services/projects";
import { purge } from "@/server/services/purge";
import { searchCards } from "@/server/services/search";
import * as studios from "@/server/services/studios";

let f: Fixture;
let privateProject: string;

beforeAll(async () => {
  f = await setupStudio();
  privateProject = (await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Secret ${Date.now()}`, template: "empty", visibility: "PRIVATE" })).id;
});

const opens = async (userId: string, projectId: string) => Boolean(await getProjectAccess(userId, projectId));

describe("Contributor and Developer roles", () => {
  it("rank Developer between Manager and Contributor, and read old Member rows as Contributor", () => {
    expect(normalizeRole("MEMBER")).toBe("CONTRIBUTOR");
    expect(roleLabel("MEMBER")).toBe("Member");
    expect(canGrantRole("ADMIN", "DEVELOPER")).toBe(true);
    expect(canGrantRole("MANAGER", "DEVELOPER")).toBe(false);
    expect(memberCanOpenProject({ role: "DEVELOPER", access: "STUDIO" }, { visibility: "PRIVATE" }, false)).toBe(true);
    expect(memberCanOpenProject({ role: "MANAGER", access: "STUDIO" }, { visibility: "PRIVATE" }, false)).toBe(true);
    expect(memberCanOpenProject({ role: "CONTRIBUTOR", access: "STUDIO" }, { visibility: "PRIVATE" }, false)).toBe(false);
    expect(memberCanOpenProject({ role: "VIEWER", access: "STUDIO" }, { visibility: "PRIVATE" }, false)).toBe(false);
    // Project-scoped collaborators only ever see what they're on, whatever the role.
    expect(memberCanOpenProject({ role: "DEVELOPER", access: "PROJECTS" }, { visibility: "STUDIO" }, false)).toBe(false);
    expect(hasAutomaticProjectAccess({ role: "DEVELOPER", access: "STUDIO" }, { visibility: "PRIVATE" })).toBe(true);
  });

  it("let studio-wide Developers and above into private projects; Contributors and Viewers need to be added", async () => {
    expect(await opens(f.developer.id, privateProject)).toBe(true);
    expect(await opens(f.manager.id, privateProject)).toBe(true);
    expect(await opens(f.admin.id, privateProject)).toBe(true);
    expect(await opens(f.member.id, privateProject)).toBe(false);
    expect(await opens(f.viewer.id, privateProject)).toBe(false);
    // The SQL twin agrees (lists, search, notifications, email checks use it).
    expect((await accessibleProjectIds(f.developer.id, f.studioId)).has(privateProject)).toBe(true);
    expect((await accessibleProjectIds(f.member.id, f.studioId)).has(privateProject)).toBe(false);
    const [project] = await db.select().from((await import("@/server/db/schema")).projects).where(eq((await import("@/server/db/schema")).projects.id, privateProject));
    expect(await filterProjectMembers(project!, [f.developer.id, f.member.id, f.viewer.id])).toEqual([f.developer.id]);
  });

  it("follow role, membership and visibility changes everywhere", async () => {
    // Added explicitly, a Contributor works there with their normal permissions.
    await projects.setProjectMember(f.admin.actor, { projectId: privateProject, userId: f.member.id, member: true });
    expect(await opens(f.member.id, privateProject)).toBe(true);
    await projects.setProjectMember(f.admin.actor, { projectId: privateProject, userId: f.member.id, member: false });
    expect(await opens(f.member.id, privateProject)).toBe(false);
    // Promoting to Developer opens it; demoting closes it again.
    await studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: f.member2.id, role: "DEVELOPER" });
    expect(await opens(f.member2.id, privateProject)).toBe(true);
    expect((await projects.listProjects(f.member2.actor, f.studioId)).some((p) => p.id === privateProject)).toBe(true);
    await studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: f.member2.id, role: "CONTRIBUTOR" });
    expect(await opens(f.member2.id, privateProject)).toBe(false);
    // Removing a Developer's explicit membership changes nothing: they have it through the role.
    await projects.setProjectMember(f.admin.actor, { projectId: privateProject, userId: f.developer.id, member: true });
    await projects.setProjectMember(f.admin.actor, { projectId: privateProject, userId: f.developer.id, member: false });
    expect(await opens(f.developer.id, privateProject)).toBe(true);
    const access = await projects.listProjectAccess(f.admin.actor, privateProject);
    expect(access.find((m) => m.userId === f.developer.id)).toMatchObject({ automaticAccess: true, hasAccess: true });
    expect(access.find((m) => m.userId === f.member.id)).toMatchObject({ automaticAccess: false, hasAccess: false });
    // Making a studio project private hides it from Contributors, not Developers.
    const p = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Open ${Date.now()}`, template: "empty" });
    expect(await opens(f.member.id, p.id)).toBe(true);
    await projects.updateProject(f.admin.actor, { projectId: p.id, visibility: "PRIVATE" });
    expect(await opens(f.member.id, p.id)).toBe(false);
    expect(await opens(f.developer.id, p.id)).toBe(true);
  });

  it("keep project-scoped Developers to the projects they were invited to", async () => {
    const outside = await createUser("Freelance dev");
    const invite = await studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: outside.email, role: "DEVELOPER", access: "PROJECTS", projectIds: [f.projectId] });
    await studios.acceptInvitation(outside.actor, { token: invite.url.split("/invite/")[1]! });
    expect(await opens(outside.id, f.projectId)).toBe(true);
    expect(await opens(outside.id, privateProject)).toBe(false);
    expect((await accessibleProjectIds(outside.id, f.studioId)).size).toBe(1);
  });

  it("never let a project role exceed what the person changing it could grant", async () => {
    await expectAppError(projects.setProjectMember(f.admin.actor, { projectId: f.projectId, userId: f.member.id, member: true, role: "OWNER" }), "VALIDATION");
    await projects.setProjectMember(f.admin.actor, { projectId: f.projectId, userId: f.member.id, member: true, role: "MANAGER" });
    const [row] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, f.projectId), eq(projectMembers.userId, f.member.id)));
    expect(row!.role).toBe("MANAGER");
    await projects.setProjectMember(f.admin.actor, { projectId: f.projectId, userId: f.member.id, member: true, role: null });
  });

  it("keep inviting with Owner/Admin and project archiving with the Owner", async () => {
    await expectAppError(studios.createInvitation(f.manager.actor, { studioId: f.studioId, email: `x_${Date.now()}@test.dev`, role: "CONTRIBUTOR" }), "FORBIDDEN");
    await expectAppError(studios.createInvitation(f.developer.actor, { studioId: f.studioId, email: `y_${Date.now()}@test.dev`, role: "CONTRIBUTOR" }), "FORBIDDEN");
    await expect(studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: `z_${Date.now()}@test.dev`, role: "DEVELOPER" })).resolves.toBeTruthy();
    await expectAppError(projects.setProjectArchived(f.admin.actor, { projectId: f.projectId, archived: true }), "FORBIDDEN");
    await expectAppError(projects.setProjectArchived(f.developer.actor, { projectId: f.projectId, archived: true }), "FORBIDDEN");
  });
});

describe("boards", () => {
  let second: string;

  it("start with one numbered board and add as many more as needed", async () => {
    const first = await board.getBoard(f.owner.actor, f.projectId);
    expect(first.board.number).toBe(1);
    expect(first.boards).toHaveLength(1);
    const created = [];
    for (let i = 0; i < 25; i++) created.push(await board.createBoard(f.manager.actor, { projectId: f.projectId, name: `Board ${i + 2}` }));
    expect(created.map((b) => b.number)).toEqual(Array.from({ length: 25 }, (_, i) => i + 2));
    expect((await board.listBoards(f.projectId)).length).toBe(26);
    second = created[0]!.id;
  });

  it("are managed by Managers and above only", async () => {
    await expectAppError(board.createBoard(f.member.actor, { projectId: f.projectId, name: "Nope" }), "FORBIDDEN");
    await expectAppError(board.createBoard(f.developer.actor, { projectId: f.projectId, name: "Nope" }), "FORBIDDEN");
    await expectAppError(board.updateBoard(f.viewer.actor, { boardId: second, name: "Nope" }), "FORBIDDEN");
    // Boards inherit the project's access: no access to the project, no board.
    await expectAppError(board.getBoard(f.member.actor, privateProject), "NOT_FOUND");
    await expectAppError(board.createBoard(f.outsider.actor, { projectId: f.projectId, name: "Nope" }), "NOT_FOUND");
  });

  it("keep their own columns and cards, opened by id or by number", async () => {
    const col = await board.createColumn(f.manager.actor, { projectId: f.projectId, boardId: second, name: "Second's column" });
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: col.id, title: "Lives on board 2" });
    const [row] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(row!.boardId).toBe(second);
    const view = await board.getBoard(f.manager.actor, f.projectId, second);
    expect(view.columns.map((c) => c.id)).toEqual([col.id]);
    expect(view.cards.map((c) => c.id)).toEqual([card.id]);
    const main = await board.getBoard(f.manager.actor, f.projectId);
    expect(main.cards.some((c) => c.id === card.id)).toBe(false);
    expect(main.columns.some((c) => c.id === col.id)).toBe(false);
    // Card links resolve to the card's board; numbers address boards.
    expect(await board.boardOfCard(f.projectId, main.project.key, card.key)).toEqual({ number: 2, archived: false });
    const page = await board.getBoardPage(f.manager.actor, (await studios.listStudiosForUser(f.manager.id)).find((s) => s.id === f.studioId)!.slug, main.project.slug, 2);
    expect(page).toMatchObject({ status: "ok", board: { boardId: second } });
    // Search names the board.
    const hits = await searchCards(f.manager.actor, { studioId: f.studioId, projectId: f.projectId, q: "Lives on board" });
    expect(hits[0]).toMatchObject({ board: { id: second, number: 2 } });
    // Views are remembered per board.
    await board.setBoardView(f.manager.actor, { projectId: f.projectId, boardId: second, view: "PRODUCTION" });
    expect((await board.getBoard(f.manager.actor, f.projectId, second)).prefs.view).toBe("PRODUCTION");
    expect((await board.getBoard(f.manager.actor, f.projectId)).prefs.view).toBe("CATEGORY");
  });

  it("move cards between boards of the project, and only of that project", async () => {
    const [card] = await db.select().from(cards).where(eq(cards.boardId, second));
    await cardService.moveCardToBoard(f.manager.actor, { cardId: card!.id, boardId: (await board.defaultBoard(f.projectId)).id });
    const [moved] = await db.select().from(cards).where(eq(cards.id, card!.id));
    expect(moved!.boardId).toBe((await board.defaultBoard(f.projectId)).id);
    const otherBoard = await board.defaultBoard(f.otherProjectId);
    await expectAppError(cardService.moveCardToBoard(f.manager.actor, { cardId: card!.id, boardId: otherBoard.id }), "VALIDATION");
    await cardService.moveCardToBoard(f.manager.actor, { cardId: card!.id, boardId: second });
  });

  it("archive with their work hidden, never the last one, and restore as they were", async () => {
    const solo = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Solo ${Date.now()}`, template: "empty" });
    const only = await board.defaultBoard(solo.id);
    await expectAppError(board.setBoardArchived(f.manager.actor, { boardId: only.id, archived: true }), "VALIDATION");

    await board.setBoardArchived(f.manager.actor, { boardId: second, archived: true });
    expect((await board.listBoards(f.projectId)).some((b) => b.id === second)).toBe(false);
    await expectAppError(board.getBoard(f.manager.actor, f.projectId, second), "VALIDATION");
    const [card] = await db.select().from(cards).where(eq(cards.boardId, second));
    // Cards on an archived board are read-only.
    await expectAppError(cardService.updateCard(f.manager.actor, { cardId: card!.id, title: "edited" }), "FORBIDDEN");
    expect((await searchCards(f.manager.actor, { studioId: f.studioId, projectId: f.projectId, q: "Lives on board" })).length).toBe(0);
    await board.setBoardArchived(f.manager.actor, { boardId: second, archived: false });
    expect((await board.getBoard(f.manager.actor, f.projectId, second)).cards.map((c) => c.id)).toEqual([card!.id]);
  });

  it("are listed with their project for the sidebar: live ones, in switcher order", async () => {
    const p = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Sidebar ${Date.now()}`, template: "empty" });
    const main = await board.defaultBoard(p.id);
    const art = await board.createBoard(f.manager.actor, { projectId: p.id, name: "Art" });
    const old = await board.createBoard(f.manager.actor, { projectId: p.id, name: "Old" });
    await board.moveBoard(f.manager.actor, { boardId: art.id, index: 0 });
    await board.setBoardArchived(f.manager.actor, { boardId: old.id, archived: true });
    const listed = (await projects.listProjects(f.manager.actor, f.studioId)).find((x) => x.id === p.id)!;
    expect(listed.boards).toEqual([
      { id: art.id, number: art.number, name: "Art", icon: null },
      { id: main.id, number: main.number, name: main.name, icon: null },
    ]);
    expect(listed.canViewReports).toBe(true);
    expect((await projects.listProjects(f.member.actor, f.studioId)).find((x) => x.id === p.id)!.canViewReports).toBe(false);
    // A project someone can't open isn't listed, boards and all.
    expect((await projects.listProjects(f.member.actor, f.studioId)).some((x) => x.id === privateProject)).toBe(false);
  });

  it("can be deleted once archived (Owner/Admin), taking only their own content", async () => {
    const doomed = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Doomed", columns: "roblox" });
    const col = (await board.getBoard(f.manager.actor, f.projectId, doomed.id)).columns[0]!;
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: col.id, title: "Goes with the board" });
    await expect(purge(f.admin.actor, { targets: [{ type: "board", id: doomed.id }] })).resolves.toMatchObject({ results: [{ status: "skipped" }] }); // not archived
    await board.setBoardArchived(f.manager.actor, { boardId: doomed.id, archived: true });
    await expect(purge(f.manager.actor, { targets: [{ type: "board", id: doomed.id }] })).resolves.toMatchObject({ results: [{ status: "skipped" }] }); // not Owner/Admin
    await expect(purge(f.admin.actor, { targets: [{ type: "board", id: doomed.id }, { type: "card", id: card.id }] })).resolves.toMatchObject({ results: [{ status: "deleted" }, { status: "deleted", reason: "Included in Doomed (board)" }] });
    expect(await db.select().from(boards).where(eq(boards.id, doomed.id))).toHaveLength(0);
    expect(await db.select().from(cards).where(eq(cards.id, card.id))).toHaveLength(0);
    expect((await board.listBoards(f.projectId)).length).toBe(26);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.targetId, doomed.id), eq(auditLogs.action, "board.deleted")))).toHaveLength(1);
    // Numbers are never reused: links to the deleted board can't land on a new one.
    expect((await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "After" })).number).toBe(28);
  });

  it("copy another board's columns (never its cards) when asked", async () => {
    const copy = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Copy", columns: { copyFromBoardId: second } });
    const view = await board.getBoard(f.manager.actor, f.projectId, copy.id);
    expect(view.columns.map((c) => c.name)).toEqual(["Second's column"]);
    expect(view.cards).toHaveLength(0);
  });

  it("migrated Member rows act as Contributors", async () => {
    const legacy = await createUser("Legacy member");
    await db.insert(studioMembers).values({ studioId: f.studioId, userId: legacy.id, role: "MEMBER" });
    expect(await opens(legacy.id, f.projectId)).toBe(true);
    expect(await opens(legacy.id, privateProject)).toBe(false);
    expect((await getProjectAccess(legacy.id, f.projectId))!.role).toBe("CONTRIBUTOR");
  });
});
