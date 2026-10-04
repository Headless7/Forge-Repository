/** Board icons: stored per board, managed by Managers and above, copied with templates. Test database only. */
import { describe, expect, it } from "vitest";
import { realtime, type RealtimeEvent } from "@/server/realtime/bus";
import { expectAppError, setupStudio } from "@/test/helpers";
import * as board from "./board";
import * as projectTemplates from "./project-templates";
import * as projects from "./projects";

describe("board icons", () => {
  it("start on the default, can be changed and reset by a Manager, and show wherever boards are listed", async () => {
    const f = await setupStudio();
    const main = await board.getBoard(f.manager.actor, f.projectId);
    expect(main.board.icon).toBeNull(); // existing and new boards use the default icon
    const second = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Environment" });
    expect(second.icon).toBeNull();

    const events: RealtimeEvent[] = [];
    const unsubscribe = realtime().subscribe((e) => events.push(e));
    const saved = await board.updateBoard(f.manager.actor, { boardId: second.id, icon: "map" });
    unsubscribe();
    expect(saved.icon).toBe("map");
    // Other open sessions refresh their board listings.
    expect(events).toContainEqual(expect.objectContaining({ type: "project", projectId: f.projectId, board: true }));

    expect((await board.getBoard(f.member.actor, f.projectId, second.id)).board.icon).toBe("map");
    expect((await board.listBoards(f.projectId)).find((b) => b.id === second.id)?.icon).toBe("map");
    const listed = (await projects.listProjects(f.member.actor, f.studioId)).find((p) => p.id === f.projectId)!;
    expect(listed.boards.find((b) => b.id === second.id)?.icon).toBe("map"); // the sidebar
    expect(listed.boards.find((b) => b.id === main.boardId)?.icon).toBeNull();

    expect((await board.updateBoard(f.manager.actor, { boardId: second.id, icon: null })).icon).toBeNull(); // reset
  });

  it("are independent of the project's emoji and its columns' icons", async () => {
    const f = await setupStudio();
    const before = await board.getBoard(f.manager.actor, f.projectId);
    await board.updateBoard(f.manager.actor, { boardId: before.boardId, icon: "rocket" });
    const after = await board.getBoard(f.manager.actor, f.projectId);
    expect(after.project.icon).toBe(before.project.icon);
    expect(after.columns.map((c) => c.icon)).toEqual(before.columns.map((c) => c.icon));
  });

  it("follow board-management permissions and read-only rules", async () => {
    const f = await setupStudio();
    const main = await board.getBoard(f.manager.actor, f.projectId);
    await expectAppError(board.updateBoard(f.member.actor, { boardId: main.boardId, icon: "map" }), "FORBIDDEN");
    await expectAppError(board.updateBoard(f.developer.actor, { boardId: main.boardId, icon: "map" }), "FORBIDDEN");
    await expectAppError(board.updateBoard(f.viewer.actor, { boardId: main.boardId, icon: "map" }), "FORBIDDEN");
    await expectAppError(board.updateBoard(f.outsider.actor, { boardId: main.boardId, icon: "map" }), "NOT_FOUND");
    await expectAppError(board.updateBoard(f.manager.actor, { boardId: main.boardId, icon: "not-an-icon" }), "VALIDATION");
    expect((await board.getBoard(f.viewer.actor, f.projectId)).board.icon).toBeNull();

    // Archived boards stay as they were until restored.
    const extra = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Old" });
    await board.setBoardArchived(f.manager.actor, { boardId: extra.id, archived: true });
    await expectAppError(board.updateBoard(f.manager.actor, { boardId: extra.id, icon: "map" }), "VALIDATION");

    // Archived projects are read-only.
    const other = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Archived ${Date.now()}`, template: "empty" });
    const otherBoard = await board.getBoard(f.owner.actor, other.id);
    await projects.setProjectArchived(f.owner.actor, { projectId: other.id, archived: true });
    await expectAppError(board.updateBoard(f.owner.actor, { boardId: otherBoard.boardId, icon: "map" }), "FORBIDDEN");
  });

  it("are copied, with the rest of the board setup, when a project is made from a template", async () => {
    const f = await setupStudio();
    const main = await board.getBoard(f.admin.actor, f.projectId);
    await board.updateBoard(f.admin.actor, { boardId: main.boardId, icon: "swords" });
    const art = await board.createBoard(f.admin.actor, { projectId: f.projectId, name: "Art" });
    await board.updateBoard(f.admin.actor, { boardId: art.id, icon: "palette" });

    const preview = await projectTemplates.previewProjectTemplate(f.admin.actor, { studioId: f.studioId, sourceProjectId: f.projectId });
    expect(preview.boards.map((b) => b.icon)).toEqual(["swords", "palette"]);

    const created = await projects.createProject(f.admin.actor, { studioId: f.studioId, name: `Icons ${Date.now()}`, templateProjectId: f.projectId });
    const copied = await board.listBoards(created.id);
    expect(copied.map((b) => [b.name, b.icon])).toEqual([
      [main.board.name, "swords"],
      ["Art", "palette"],
    ]);
  });
});
