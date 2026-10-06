/**
 * Start dates, the schedule behind the timeline and calendars, private calendar feeds, and the
 * producer dashboard. Every fixture is created here (test database only).
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { deliverables as deliverablesTable, reviews } from "@/server/db/schema";
import { createUser, expectAppError, primaryDeliverable, setupStudio, type Fixture } from "@/test/helpers";
import * as board from "./board";
import { calendarFeedFor, createCalendarFeed, getCalendarFeed, renderCalendar, revokeCalendarFeed } from "./calendar-feed";
import * as cardService from "./cards";
import { dashboardList, projectDashboard, studioDashboard } from "./dashboard";
import * as deliverables from "./deliverables";
import * as labelService from "./labels";
import * as projects from "./projects";
import { boardSchedule, studioSchedule } from "./schedule";

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

let f: Fixture;
let dated: { id: string; key: string };
let model: string;
let rig: string;
let undated: { id: string; key: string };
let otherBoardCard: { id: string; key: string };
let secondBoard: string;

beforeAll(async () => {
  f = await setupStudio();
  dated = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Boss fight", startAt: at(1), dueAt: at(10), assigneeIds: [f.member.id] });
  model = await primaryDeliverable(dated.id);
  const detail = await deliverables.createDeliverable(f.manager.actor, { cardId: dated.id, name: "Rig", ownerId: f.member2.id, startAt: at(3), dueAt: at(6) });
  rig = detail.deliverables.find((d) => d.name === "Rig")!.id;
  await deliverables.linkDeliverables(f.manager.actor, { cardId: dated.id, fromId: model, toId: rig, type: "DEPENDENCY" });
  undated = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Someday" });
  const b2 = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Second", columns: "roblox" });
  secondBoard = b2.id;
  const col = (await board.getBoard(f.manager.actor, f.projectId, b2.id)).columns[0]!;
  otherBoardCard = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: col.id, title: "On board two", dueAt: at(4), assigneeIds: [f.member2.id] });
});

describe("start dates", () => {
  it("are optional, inherited by deliverables, and never after the deadline", async () => {
    const card = await cardService.getCardDetail(f.manager.actor, dated.id);
    expect(Math.abs(new Date(card.startAt!).getTime() - (Date.now() + DAY))).toBeLessThan(60_000);
    expect(card.deliverables.find((d) => d.id === model)).toMatchObject({ startAt: null, dueAt: null });
    expect(card.deliverables.find((d) => d.id === rig)!.startAt).not.toBeNull();
    await expectAppError(cardService.updateCard(f.manager.actor, { cardId: dated.id, startAt: at(20) }), "VALIDATION");
    // A deliverable's own start after the card's deadline it inherits.
    await expectAppError(deliverables.updateDeliverable(f.manager.actor, { deliverableId: model, startAt: at(15) }), "VALIDATION");
    await expectAppError(deliverables.createDeliverable(f.manager.actor, { cardId: dated.id, name: "Bad", startAt: at(9), dueAt: at(8) }), "VALIDATION");
    await expectAppError(cardService.updateCard(f.viewer.actor, { cardId: dated.id, startAt: at(2) }), "FORBIDDEN");
  });
});

describe("schedule", () => {
  it("returns a board's work overlapping a range, with effective dates and blockers", async () => {
    const main = (await board.defaultBoard(f.projectId)).id;
    const s = await boardSchedule(f.manager.actor, { projectId: f.projectId, boardId: main, from: at(0), to: at(14) });
    expect(s.cards.map((c) => c.key)).toEqual([dated.key]);
    const card = s.cards[0]!;
    expect(card.canEdit).toBe(true);
    const m = card.deliverables.find((d) => d.id === model)!;
    expect(m.startAt).toBe(card.startAt);
    expect(m.dueAt).toBe(card.dueAt);
    expect(m.ownDueAt).toBeNull();
    const r = card.deliverables.find((d) => d.id === rig)!;
    expect(r.blockedBy).toEqual([model]);
    expect(r.ownDueAt).not.toBeNull();
    expect(card.links).toEqual([{ fromId: model, toId: rig, type: "DEPENDENCY" }]);
    expect(s.unscheduled.map((u) => u.key)).toContain(undated.key);
    // Outside the range: nothing.
    expect((await boardSchedule(f.manager.actor, { projectId: f.projectId, from: at(30), to: at(40) })).cards).toHaveLength(0);
    // Read-only for a viewer.
    expect((await boardSchedule(f.viewer.actor, { projectId: f.projectId, boardId: main, from: at(0), to: at(14) })).cards[0]!.canEdit).toBe(false);
  });

  it("covers one board, or the whole project with each card's board", async () => {
    const one = await boardSchedule(f.manager.actor, { projectId: f.projectId, boardId: secondBoard, from: at(0), to: at(14) });
    expect(one.cards.map((c) => c.key)).toEqual([otherBoardCard.key]);
    const all = await boardSchedule(f.manager.actor, { projectId: f.projectId, boardId: null, from: at(0), to: at(14) });
    expect(all.cards.map((c) => c.key).sort()).toEqual([dated.key, otherBoardCard.key].sort());
    expect(all.cards.find((c) => c.key === otherBoardCard.key)!.board).toMatchObject({ id: secondBoard, number: 2 });
  });

  it("leaves out archived work, and limits 'mine' to the person's work", async () => {
    const mine = await studioSchedule(f.member2.actor, { studioId: f.studioId, from: at(0), to: at(14), scope: "mine" });
    // member2: responsible for Rig (on Boss fight) and assigned to the board-two card.
    expect(mine.cards.map((c) => c.key).sort()).toEqual([dated.key, otherBoardCard.key].sort());
    expect(mine.cards.find((c) => c.key === dated.key)!.deliverables.filter((d) => d.mine).map((d) => d.id)).toEqual([rig]);
    const viewerMine = await studioSchedule(f.viewer.actor, { studioId: f.studioId, from: at(0), to: at(14), scope: "mine" });
    expect(viewerMine.cards).toHaveLength(0);
    expect((await studioSchedule(f.viewer.actor, { studioId: f.studioId, from: at(0), to: at(14), scope: "all" })).cards.length).toBe(2);
    await board.setBoardArchived(f.manager.actor, { boardId: secondBoard, archived: true });
    expect((await studioSchedule(f.member2.actor, { studioId: f.studioId, from: at(0), to: at(14), scope: "mine" })).cards.map((c) => c.key)).toEqual([dated.key]);
    await board.setBoardArchived(f.manager.actor, { boardId: secondBoard, archived: false });
    await expectAppError(boardSchedule(f.manager.actor, { projectId: f.projectId, from: at(0), to: at(500) }), "VALIDATION");
    await expectAppError(boardSchedule(f.outsider.actor, { projectId: f.projectId, from: at(0), to: at(14) }), "NOT_FOUND");
  });

  it("includes milestones due in the range", async () => {
    await labelService.createMilestone(f.manager.actor, { projectId: f.projectId, name: "Update 9", dueAt: at(7) });
    const s = await boardSchedule(f.manager.actor, { projectId: f.projectId, from: at(0), to: at(14) });
    expect(s.milestones.map((m) => m.name)).toContain("Update 9");
  });
});

describe("calendar feeds", () => {
  it("serve the person's deadlines through a secret, revocable link", async () => {
    expect(await getCalendarFeed(f.member2.actor)).toMatchObject({ active: false });
    const { url } = await createCalendarFeed(f.member2.actor);
    const token = url.split("/api/calendar/")[1]!.replace(/\.ics$/, "");
    const ics = (await calendarFeedFor(token))!;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain(`SUMMARY:${dated.key} · D2 Rig — due`);
    expect(ics).toContain(`SUMMARY:${otherBoardCard.key} On board two — due`);
    expect(ics).not.toContain("Boss fight — due"); // member2 isn't assigned to the card itself
    expect(ics).toContain("Update 9");
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect((await getCalendarFeed(f.member2.actor)).lastUsedAt).not.toBeNull();
    // Regenerating revokes the old link; revoking removes it.
    const again = await createCalendarFeed(f.member2.actor);
    expect(await calendarFeedFor(token)).toBeNull();
    const newToken = again.url.split("/api/calendar/")[1]!.replace(/\.ics$/, "");
    expect(await calendarFeedFor(newToken)).toContain("BEGIN:VEVENT");
    await revokeCalendarFeed(f.member2.actor);
    expect(await calendarFeedFor(newToken)).toBeNull();
    expect(await calendarFeedFor("not-a-token")).toBeNull();
  });

  it("follow access: losing a private project removes its work", async () => {
    const p = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Secret ${Date.now()}`, template: "roblox", visibility: "PRIVATE" });
    await projects.setProjectMember(f.owner.actor, { projectId: p.id, userId: f.member.id, member: true });
    const col = (await board.getBoard(f.owner.actor, p.id)).columns[0]!;
    const secret = await cardService.createCard(f.owner.actor, { projectId: p.id, columnId: col.id, title: "Secret work", dueAt: at(5), assigneeIds: [f.member.id] });
    const { url } = await createCalendarFeed(f.member.actor);
    const token = url.split("/api/calendar/")[1]!.replace(/\.ics$/, "");
    expect(await calendarFeedFor(token)).toContain(secret.key);
    await projects.setProjectMember(f.owner.actor, { projectId: p.id, userId: f.member.id, member: false });
    expect(await calendarFeedFor(token)).not.toContain(secret.key);
  });

  it("escape text safely", () => {
    const ics = renderCalendar([{ uid: "x@forge", summary: "A, B; C\\D\nE\rLOCATION:x", description: "", url: "https://x", at: new Date("2026-01-02T03:04:05Z") }], new Date("2026-01-01T00:00:00Z"));
    expect(ics).toContain("SUMMARY:A\\, B\\; C\\\\D\\nE\\nLOCATION:x");
    // A lone carriage return can't start a property of its own.
    expect(ics.split("\r\n").some((line) => line.startsWith("LOCATION"))).toBe(false);
    expect(ics).toContain("DTSTART:20260102T030405Z");
  });
});

describe("producer dashboard", () => {
  let p: string;
  let cardId: string;
  let ds: Record<string, string>;
  const range = () => ({ from: at(-30), to: at(0.01) });

  beforeAll(async () => {
    p = (await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Dash ${Date.now()}`, template: "roblox" })).id;
    const col = (await board.getBoard(f.owner.actor, p)).columns[0]!;
    const milestone = await labelService.createMilestone(f.manager.actor, { projectId: p, name: "Launch", dueAt: at(20) });
    const card = await cardService.createCard(f.manager.actor, { projectId: p, columnId: col.id, title: "Dash card", dueAt: at(-2), assigneeIds: [f.member.id], milestoneId: milestone.id });
    cardId = card.id;
    const first = await primaryDeliverable(card.id);
    await deliverables.updateDeliverable(f.manager.actor, { deliverableId: first, name: "Approved one" });
    let detail = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "Waiting", ownerId: f.member2.id, dueAt: at(3) });
    detail = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "In review", reviewerId: f.manager.id, dueAt: at(30) });
    detail = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "Nobody's", required: false });
    ds = Object.fromEntries(detail.deliverables.map((d) => [d.name, d.id]));
    await deliverables.linkDeliverables(f.manager.actor, { cardId, fromId: ds["In review"]!, toId: ds["Waiting"]!, type: "DEPENDENCY" });
    // "Nobody's": no owner, and the card has assignees → inherits them. Make a truly unassigned one on another card.
    const lonely = await cardService.createCard(f.manager.actor, { projectId: p, columnId: col.id, title: "Lonely" });
    ds.lonely = await primaryDeliverable(lonely.id);
    // Review history with known timings (hours after t0 = 5 days ago).
    const t0 = Date.now() - 5 * DAY;
    const h = (n: number) => new Date(t0 + n * 3_600_000);
    await db.update(deliverablesTable).set({ createdAt: new Date(t0 - 2 * DAY) }).where(eq(deliverablesTable.id, ds["Approved one"]!));
    await db.insert(reviews).values([
      { cardId, deliverableId: ds["Approved one"]!, action: "SUBMITTED", createdAt: h(0) },
      { cardId, deliverableId: ds["Approved one"]!, action: "CHANGES_REQUESTED", createdAt: h(10) },
      { cardId, deliverableId: ds["Approved one"]!, action: "SUBMITTED", createdAt: h(20) },
      { cardId, deliverableId: ds["Approved one"]!, action: "APPROVED", createdAt: h(30) },
      { cardId, deliverableId: ds["In review"]!, action: "SUBMITTED", createdAt: h(40) },
    ]);
    await db.update(deliverablesTable).set({ state: "APPROVED" }).where(eq(deliverablesTable.id, ds["Approved one"]!));
    await db.update(deliverablesTable).set({ state: "NEEDS_REVIEW" }).where(eq(deliverablesTable.id, ds["In review"]!));
  });

  it("is for Managers and above", async () => {
    await expectAppError(projectDashboard(f.member.actor, { projectId: p, ...range() }), "FORBIDDEN");
    await expectAppError(projectDashboard(f.developer.actor, { projectId: p, ...range() }), "FORBIDDEN");
    await expectAppError(projectDashboard(f.outsider.actor, { projectId: p, ...range() }), "NOT_FOUND");
    await expect(projectDashboard(f.manager.actor, { projectId: p, ...range() })).resolves.toBeTruthy();
    await expectAppError(studioDashboard(f.member.actor, { studioId: f.studioId }), "FORBIDDEN");
  });

  it("reports status, risk and review flow that match their drill-down lists", async () => {
    const d = await projectDashboard(f.manager.actor, { projectId: p, ...range() });
    expect(d.status.total).toBe(5);
    expect(d.status.byState.APPROVED).toBe(1);
    expect(d.status.byState.NEEDS_REVIEW).toBe(1);
    expect(d.status.required).toBe(4);
    expect(d.status.requiredApproved).toBe(1);
    // Overdue: the card's deadline (2 days ago) is inherited by "Nobody's" — not by the approved one.
    const overdue = await dashboardList(f.manager.actor, { projectId: p, ...range(), key: "overdue" });
    expect(overdue.map((i) => i.name)).toEqual(["Nobody's"]);
    expect(d.risk.overdue).toBe(overdue.length);
    const blocked = await dashboardList(f.manager.actor, { projectId: p, ...range(), key: "blocked" });
    expect(blocked.map((i) => [i.name, i.note])).toEqual([["Waiting", "waiting on In review"]]);
    expect((await dashboardList(f.manager.actor, { projectId: p, ...range(), key: "unassigned" })).map((i) => i.cardTitle)).toEqual(["Lonely"]);
    expect((await dashboardList(f.manager.actor, { projectId: p, ...range(), key: "queue" }))[0]!.note).toMatch(/waiting \d+ (h|days)/);
    expect(d.review.queue).toBe(1);
    // Review flow from the log: two submissions answered after 10 h each; approved 30 h after the round began.
    expect(d.review.firstReview).toEqual({ median: 10, p75: 10, n: 2 });
    expect(d.review.toApproval).toEqual({ median: 30, p75: 30, n: 1 });
    expect(d.review).toMatchObject({ decisions: 2, changesRequested: 1, approvals: 1, approvalsAfterChanges: 1 });
    expect(d.cycleTime).toEqual({ median: 78, p75: 78, n: 1 }); // created 2 days before t0, approved at t0 + 30 h
    expect(d.throughput.reduce((n, w) => n + w.approved, 0)).toBe(1);
    expect(d.historySince).not.toBeNull();
  });

  it("shows workload per person and milestone forecasts", async () => {
    const d = await projectDashboard(f.manager.actor, { projectId: p, ...range() });
    const m2 = d.workload.find((w) => w.userId === f.member2.id)!;
    expect(m2).toMatchObject({ responsible: 1, dueSoon: 1 });
    const mgr = d.workload.find((w) => w.userId === f.manager.id)!;
    expect(mgr.reviewing).toBe(1);
    const person = await dashboardList(f.manager.actor, { projectId: p, ...range(), key: `person:${f.member2.id}` });
    expect(person.map((i) => i.name)).toEqual(["Waiting"]);
    const launch = d.milestones.find((m) => m.name === "Launch")!;
    expect(launch).toMatchObject({ required: 3, approved: 1 });
    expect(["on-track", "at-risk"]).toContain(launch.forecast);
    expect((await dashboardList(f.manager.actor, { projectId: p, ...range(), key: `milestone:${launch.id}` })).length).toBe(2);
  });

  it("filters by board and milestone, leaves archived work out, and summarises the studio", async () => {
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: true });
    const d = await projectDashboard(f.manager.actor, { projectId: p, ...range() });
    expect(d.status.total).toBe(1); // only "Lonely" is left
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: false });
    const launch = (await projectDashboard(f.manager.actor, { projectId: p, ...range() })).milestones.find((m) => m.name === "Launch")!;
    expect((await projectDashboard(f.manager.actor, { projectId: p, milestoneId: launch.id, ...range() })).status.total).toBe(4);
    const rows = await studioDashboard(f.manager.actor, { studioId: f.studioId });
    expect(rows.find((r) => r.project.id === p)).toMatchObject({ open: 4, overdue: 1, blocked: 1, queue: 1 });
    // A project-level Manager on one project sees that project's dashboard.
    const promoted = await createUser("Project manager");
    const { studioMembers } = await import("@/server/db/schema");
    await db.insert(studioMembers).values({ studioId: f.studioId, userId: promoted.id, role: "CONTRIBUTOR" });
    await projects.setProjectMember(f.admin.actor, { projectId: p, userId: promoted.id, member: true, role: "MANAGER" });
    await expect(projectDashboard(promoted.actor, { projectId: p, ...range() })).resolves.toBeTruthy();
  });
});
