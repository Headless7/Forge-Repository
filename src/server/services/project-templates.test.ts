/**
 * Creating a project from another: setup and access come along, production work never does.
 * Every fixture is created here (test database only).
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getProjectAccess } from "@/server/access";
import { db } from "@/server/db";
import { boardColumns, boards, cards, deliverables, invitations, labels, milestones, projectMembers, projects as projectsTable, studioMembers } from "@/server/db/schema";
import { createUser, expectAppError, setupStudio, type Fixture, type TestUser } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as labelService from "./labels";
import { previewProjectTemplate } from "./project-templates";
import * as projects from "./projects";
import * as studios from "./studios";

let f: Fixture;
let source: string;
let leaver: TestUser;
let collaborator: TestUser;

beforeAll(async () => {
  f = await setupStudio();
  const p = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Template ${Date.now()}`, template: "roblox", visibility: "PRIVATE" });
  source = p.id;
  await projects.updateProject(f.owner.actor, { projectId: source, settings: { allowSelfApproval: true, requireFeedbackForChanges: false, defaultReviewerIds: [f.manager.id, f.member.id] }, background: "ocean" });
  const art = await board.createBoard(f.manager.actor, { projectId: source, name: "Art", description: "Concepts and models", columns: "empty" });
  await board.createColumn(f.manager.actor, { projectId: source, boardId: art.id, name: "Concepts" });
  const oldCol = await board.createColumn(f.manager.actor, { projectId: source, boardId: art.id, name: "Old column" });
  await board.setColumnArchived(f.manager.actor, { columnId: oldCol.id, archived: true });
  const gone = await board.createBoard(f.manager.actor, { projectId: source, name: "Archived board" });
  await board.setBoardArchived(f.manager.actor, { boardId: gone.id, archived: true });
  await labelService.createLabel(f.manager.actor, { projectId: source, name: "Bug", color: "#ef4444" });
  await labelService.createMilestone(f.manager.actor, { projectId: source, name: "Update 7" });
  const firstColumn = (await board.getBoard(f.owner.actor, source)).columns[0]!;
  await cardService.createCard(f.manager.actor, { projectId: source, columnId: firstColumn.id, title: "Production work", dueAt: new Date(Date.now() + 86400000).toISOString() });
  // People: a Contributor managing this project, a Viewer, a project-only collaborator, and someone who left.
  await projects.setProjectMember(f.owner.actor, { projectId: source, userId: f.member.id, member: true, role: "MANAGER" });
  await projects.setProjectMember(f.owner.actor, { projectId: source, userId: f.viewer.id, member: true });
  collaborator = await createUser("Collaborator");
  const invite = await studios.createInvitation(f.admin.actor, { studioId: f.studioId, email: collaborator.email, role: "CONTRIBUTOR", access: "PROJECTS", projectIds: [source] });
  await studios.acceptInvitation(collaborator.actor, { token: invite.url.split("/invite/")[1]! });
  leaver = await createUser("Leaver");
  await db.insert(studioMembers).values({ studioId: f.studioId, userId: leaver.id, role: "CONTRIBUTOR" });
  await projects.setProjectMember(f.owner.actor, { projectId: source, userId: leaver.id, member: true });
  await db.delete(studioMembers).where(and(eq(studioMembers.studioId, f.studioId), eq(studioMembers.userId, leaver.id)));
  await db.insert(invitations).values({ studioId: f.studioId, email: `pending_${Date.now()}@test.dev`, role: "CONTRIBUTOR", access: "PROJECTS", projectIds: [source], tokenHash: `tpl-${Date.now()}`, expiresAt: new Date(Date.now() + 86400000) });
});

describe("project templates", () => {
  it("preview exactly what will be copied, who comes along and who can't", async () => {
    const preview = await previewProjectTemplate(f.admin.actor, { studioId: f.studioId, sourceProjectId: source });
    expect(preview.boards.map((b) => b.name)).toEqual(["Board", "Art"]);
    expect(preview.boards[1]!.columns.map((c) => c.name)).toEqual(["Concepts"]);
    expect(preview.labels.map((l) => l.name)).toEqual(["Bug"]);
    expect(preview.settings).toMatchObject({ visibility: "PRIVATE", allowSelfApproval: true, requireFeedbackForChanges: false, background: "ocean" });
    const people = new Map(preview.people.map((p) => [p.userId, p]));
    expect(people.get(f.member.id)).toMatchObject({ projectRole: "MANAGER", excluded: null });
    expect(people.get(collaborator.id)).toMatchObject({ projectsOnly: true, excluded: null });
    expect(people.get(leaver.id)?.excluded).toMatch(/no longer a member/i);
    expect(preview.notCopied.join(" ")).toMatch(/Cards/);
  });

  it("create an empty, independent project with the setup and access", async () => {
    const created = await projects.createProject(f.admin.actor, { studioId: f.studioId, name: `From template ${Date.now()}`, key: "FTP", templateProjectId: source, templateMemberIds: null });
    const [row] = await db.select().from(projectsTable).where(eq(projectsTable.id, created.id));
    expect(row).toMatchObject({ visibility: "PRIVATE", background: "ocean", key: "FTP" });
    expect(row!.settings).toMatchObject({ allowSelfApproval: true, requireFeedbackForChanges: false });
    // Default reviewers come along only if they can open the new project (both can: Manager role, copied membership).
    expect(row!.settings.defaultReviewerIds.sort()).toEqual([f.manager.id, f.member.id].sort());

    const newBoards = await db.select().from(boards).where(eq(boards.projectId, created.id));
    expect(newBoards.map((b) => [b.number, b.name, b.description]).sort()).toEqual([
      [1, "Board", ""],
      [2, "Art", "Concepts and models"],
    ]);
    const sourceBoards = await db.select({ id: boards.id }).from(boards).where(eq(boards.projectId, source));
    expect(newBoards.some((b) => sourceBoards.some((s) => s.id === b.id))).toBe(false);
    const art = newBoards.find((b) => b.name === "Art")!;
    expect((await db.select().from(boardColumns).where(eq(boardColumns.boardId, art.id))).map((c) => c.name)).toEqual(["Concepts"]);
    expect((await db.select().from(boardColumns).where(eq(boardColumns.projectId, created.id))).length).toBe((await board.getBoard(f.owner.actor, source)).columns.length + 1);
    expect((await db.select().from(labels).where(eq(labels.projectId, created.id))).map((l) => l.name)).toEqual(["Bug"]);

    // No production content.
    expect(await db.select().from(cards).where(eq(cards.projectId, created.id))).toHaveLength(0);
    expect(await db.select().from(deliverables).where(eq(deliverables.projectId, created.id))).toHaveLength(0);
    expect(await db.select().from(milestones).where(eq(milestones.projectId, created.id))).toHaveLength(0);
    const pending = await db.select().from(invitations).where(eq(invitations.studioId, f.studioId));
    expect(pending.some((i) => i.projectIds.includes(created.id))).toBe(false);

    // Access: members as on the template (roles kept), the leaver left out, studio roles untouched.
    const members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, created.id));
    const byUser = new Map(members.map((m) => [m.userId, m.role]));
    expect(byUser.get(f.member.id)).toBe("MANAGER");
    expect(byUser.has(f.viewer.id)).toBe(true);
    expect(byUser.has(collaborator.id)).toBe(true);
    expect(byUser.has(leaver.id)).toBe(false);
    expect((await getProjectAccess(f.member.id, created.id))!.role).toBe("MANAGER");
    expect((await getProjectAccess(collaborator.id, created.id))).toBeTruthy();
    expect(await getProjectAccess(leaver.id, created.id)).toBeNull();
    const [studioRole] = await db.select().from(studioMembers).where(and(eq(studioMembers.studioId, f.studioId), eq(studioMembers.userId, f.member.id)));
    expect(studioRole!.role).toBe("CONTRIBUTOR");

    // Independent afterwards.
    await board.updateBoard(f.manager.actor, { boardId: art.id, name: "Renamed in the copy" });
    expect((await board.listBoards(source)).map((b) => b.name)).toContain("Art");
  });

  it("bring only the people the creator keeps ticked", async () => {
    const created = await projects.createProject(f.admin.actor, { studioId: f.studioId, name: `Picked ${Date.now()}`, templateProjectId: source, templateMemberIds: [f.viewer.id] });
    const members = (await db.select().from(projectMembers).where(eq(projectMembers.projectId, created.id))).map((m) => m.userId).sort();
    expect(members).toEqual([f.admin.id, f.viewer.id].sort());
    // A collaborator left out doesn't get the project.
    expect(await getProjectAccess(collaborator.id, created.id)).toBeNull();
  });

  it("never grant a project role the creator couldn't grant", async () => {
    // Odd data: an Owner override (the UI and API refuse it) must not be copied as such.
    await db.update(projectMembers).set({ role: "OWNER" }).where(and(eq(projectMembers.projectId, source), eq(projectMembers.userId, f.viewer.id)));
    const preview = await previewProjectTemplate(f.admin.actor, { studioId: f.studioId, sourceProjectId: source });
    expect(preview.people.find((p) => p.userId === f.viewer.id)?.note).toMatch(/can't give that role/);
    const created = await projects.createProject(f.admin.actor, { studioId: f.studioId, name: `Safe ${Date.now()}`, templateProjectId: source });
    const [viewerRow] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, created.id), eq(projectMembers.userId, f.viewer.id)));
    expect(viewerRow!.role).toBeNull();
    expect((await getProjectAccess(f.viewer.id, created.id))!.role).toBe("VIEWER");
    await db.update(projectMembers).set({ role: null }).where(and(eq(projectMembers.projectId, source), eq(projectMembers.userId, f.viewer.id)));
  });

  it("only work for people who can create projects, from projects they can open", async () => {
    await expectAppError(projects.createProject(f.manager.actor, { studioId: f.studioId, name: "Nope", templateProjectId: source }), "FORBIDDEN");
    await expectAppError(previewProjectTemplate(f.developer.actor, { studioId: f.studioId, sourceProjectId: source }), "FORBIDDEN");
    // Another studio's project isn't a template here.
    await expectAppError(projects.createProject(f.admin.actor, { studioId: f.studioId, name: "Cross", templateProjectId: f.otherProjectId }), "NOT_FOUND");
  });

  it("leave nothing behind when creation fails", async () => {
    const archived = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Archived src ${Date.now()}`, template: "empty" });
    await projects.setProjectArchived(f.owner.actor, { projectId: archived.id, archived: true });
    const name = `Never created ${Date.now()}`;
    await expectAppError(projects.createProject(f.admin.actor, { studioId: f.studioId, name, templateProjectId: archived.id }), "VALIDATION");
    expect(await db.select().from(projectsTable).where(eq(projectsTable.name, name))).toHaveLength(0);
  });
});
