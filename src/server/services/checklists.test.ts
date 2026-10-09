/**
 * Checklist items with a person and a due day: who can give, date and tick them, and where they
 * show up (card counts, Home, schedules and the calendar feed). Every fixture is created here
 * (test database only).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { canTickChecklistItem, checklistDueState, formatDueDay } from "@/lib/checklist";
import { expectAppError, setupStudio, type Fixture } from "@/test/helpers";
import { listCardActivity } from "./activity";
import { calendarFeedFor, createCalendarFeed, revokeCalendarFeed } from "./calendar-feed";
import * as cardService from "./cards";
import * as checklists from "./checklists";
import { getStudioHome } from "./home";
import { boardSchedule, studioSchedule } from "./schedule";

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
/** A due day `days` from today (UTC calendar; the tests only compare days far apart). */
const day = (days: number) => at(days).slice(0, 10);

let f: Fixture;
let card: { id: string; key: string };
let listId: string;
const itemId = (detail: Awaited<ReturnType<typeof cardService.getCardDetail>>, text: string) =>
  detail.checklists.flatMap((l) => l.items).find((i) => i.text === text)!.id;

beforeAll(async () => {
  f = await setupStudio();
  // The manager's card: Member Two works in the project but can't edit this card.
  card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Lobby" });
  const detail = await checklists.createChecklist(f.manager.actor, { cardId: card.id, title: "Tasks", items: ["Plain"] });
  listId = detail.checklists[0]!.id;
});

describe("checklist item rules", () => {
  it("give items to people who can work on cards, with a real due day", async () => {
    const detail = await checklists.addChecklistItem(f.manager.actor, { checklistId: listId, text: "Model the arch", assigneeId: f.member2.id, dueOn: day(3) });
    const item = detail.checklists[0]!.items.find((i) => i.text === "Model the arch")!;
    expect(item).toMatchObject({ assigneeId: f.member2.id, dueOn: day(3), isDone: false });
    // Not Viewers, not outsiders, not impossible days.
    await expectAppError(checklists.addChecklistItem(f.manager.actor, { checklistId: listId, text: "x", assigneeId: f.viewer.id }), "VALIDATION");
    await expectAppError(checklists.addChecklistItem(f.manager.actor, { checklistId: listId, text: "x", assigneeId: f.outsider.id }), "VALIDATION");
    await expectAppError(checklists.addChecklistItem(f.manager.actor, { checklistId: listId, text: "x", dueOn: "2026-02-30" }), "VALIDATION");
    await expectAppError(checklists.updateChecklistItem(f.manager.actor, { itemId: item.id, dueOn: "1999-12-31" }), "VALIDATION");
    // Adding needs edit rights on the card.
    await expectAppError(checklists.addChecklistItem(f.member2.actor, { checklistId: listId, text: "Mine now", assigneeId: f.member2.id }), "FORBIDDEN");
  });

  it("let the item's person tick it off, but only editors change it", async () => {
    let detail = await checklists.addChecklistItem(f.manager.actor, { checklistId: listId, text: "Light the lobby", assigneeId: f.member2.id });
    const theirs = itemId(detail, "Light the lobby");
    const plain = itemId(detail, "Plain");
    expect(detail.permissions.canEdit).toBe(true);
    const asMember2 = await cardService.getCardDetail(f.member2.actor, card.id);
    expect(asMember2.permissions.canEdit).toBe(false);
    expect(canTickChecklistItem(asMember2.permissions, { assigneeId: f.member2.id }, f.member2.id)).toBe(true);
    expect(canTickChecklistItem(asMember2.permissions, { assigneeId: null }, f.member2.id)).toBe(false);

    detail = await checklists.updateChecklistItem(f.member2.actor, { itemId: theirs, isDone: true });
    expect(detail.checklists[0]!.items.find((i) => i.id === theirs)).toMatchObject({ isDone: true, doneById: f.member2.id });
    await checklists.updateChecklistItem(f.member2.actor, { itemId: theirs, isDone: false });
    // Someone else's (or nobody's) item, and any change beyond the tick, need edit rights.
    await expectAppError(checklists.updateChecklistItem(f.member2.actor, { itemId: plain, isDone: true }), "FORBIDDEN");
    await expectAppError(checklists.updateChecklistItem(f.member2.actor, { itemId: theirs, isDone: true, dueOn: day(1) }), "FORBIDDEN");
    await expectAppError(checklists.updateChecklistItem(f.member2.actor, { itemId: theirs, assigneeId: null }), "FORBIDDEN");
    await expectAppError(checklists.updateChecklistItem(f.member2.actor, { itemId: theirs, text: "Renamed" }), "FORBIDDEN");
    // Viewers and outsiders can't tick anything.
    await expectAppError(checklists.updateChecklistItem(f.viewer.actor, { itemId: plain, isDone: true }), "FORBIDDEN");
    await expectAppError(checklists.updateChecklistItem(f.outsider.actor, { itemId: theirs, isDone: true }), "NOT_FOUND");

    // Editors give, date and tick anything.
    detail = await checklists.updateChecklistItem(f.manager.actor, { itemId: plain, assigneeId: f.member.id, dueOn: day(5) });
    expect(detail.checklists[0]!.items.find((i) => i.id === plain)).toMatchObject({ assigneeId: f.member.id, dueOn: day(5) });
    detail = await checklists.updateChecklistItem(f.manager.actor, { itemId: plain, assigneeId: null, dueOn: null });
    expect(detail.checklists[0]!.items.find((i) => i.id === plain)).toMatchObject({ assigneeId: null, dueOn: null });
  });

  it("record giving, dating and ticking someone's item in the card's activity", async () => {
    const detail = await checklists.addChecklistItem(f.manager.actor, { checklistId: listId, text: "Logged", assigneeId: f.member.id, dueOn: day(2) });
    const id = itemId(detail, "Logged");
    await checklists.updateChecklistItem(f.member.actor, { itemId: id, isDone: true });
    const events = (await listCardActivity(card.id)).filter((e) => (e.data as { item?: string }).item === "Logged");
    expect(events.map((e) => e.type).sort()).toEqual(["checklist.item_assigned", "checklist.item_done", "checklist.item_due"]);
    expect(events.find((e) => e.type === "checklist.item_due")!.data).toMatchObject({ to: day(2) });
  });
});

describe("where items show up", () => {
  let showcase: { id: string; key: string };
  beforeAll(async () => {
    showcase = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.ui, title: "HUD" });
    await checklists.addChecklistItems(f.manager.actor, { cardId: showcase.id, texts: ["Health bar"], assigneeId: f.member.id, dueOn: day(4) });
    await checklists.addChecklistItems(f.manager.actor, { cardId: showcase.id, texts: ["Late icons"], assigneeId: f.member.id, dueOn: day(-2) });
    await checklists.addChecklistItems(f.manager.actor, { cardId: showcase.id, texts: ["Someone else's"], assigneeId: f.member2.id, dueOn: day(4) });
    await checklists.addChecklistItems(f.manager.actor, { cardId: showcase.id, texts: ["Far away"], assigneeId: f.member.id, dueOn: day(60) });
    const done = await checklists.addChecklistItems(f.manager.actor, { cardId: showcase.id, texts: ["Done already"], assigneeId: f.member.id, dueOn: day(4) });
    const detail = await cardService.getCardDetail(f.manager.actor, done.ctx.card.id);
    await checklists.updateChecklistItem(f.member.actor, { itemId: itemId(detail, "Done already"), isDone: true });
  });

  it("count the viewer's open items and the soonest open day on the card", async () => {
    const mine = await cardService.getCardDetail(f.member.actor, showcase.id);
    expect(mine.counts).toMatchObject({ checklistTotal: 5, checklistDone: 1, checklistMine: 3, checklistNextDue: day(-2) });
    expect((await cardService.getCardDetail(f.manager.actor, showcase.id)).counts.checklistMine).toBe(0);
  });

  it("list the person's open items in Home, soonest first", async () => {
    const home = await getStudioHome(f.member.actor, f.studioId);
    const texts = home.checklistItems.filter((i) => i.card.id === showcase.id).map((i) => i.text);
    expect(texts).toEqual(["Late icons", "Health bar", "Far away"]);
    expect(home.checklistItems.find((i) => i.text === "Health bar")).toMatchObject({ dueOn: day(4), card: { key: showcase.key }, checklistTitle: "Checklist" });
    // Archived cards drop out.
    await cardService.setCardArchived(f.manager.actor, { cardId: showcase.id, archived: true });
    expect((await getStudioHome(f.member.actor, f.studioId)).checklistItems.some((i) => i.card.id === showcase.id)).toBe(false);
    await cardService.setCardArchived(f.manager.actor, { cardId: showcase.id, archived: false });
  });

  it("put open items with a day in range on schedules: everyone's on the board, only yours in 'mine'", async () => {
    const all = await boardSchedule(f.manager.actor, { projectId: f.projectId, boardId: null, from: at(-7), to: at(14) });
    const onCard = all.checklistItems.filter((i) => i.card.id === showcase.id).map((i) => i.text).sort();
    expect(onCard).toEqual(["Health bar", "Late icons", "Someone else's"]);
    const item = all.checklistItems.find((i) => i.text === "Health bar")!;
    expect(item).toMatchObject({ dueOn: day(4), assigneeId: f.member.id, card: { key: showcase.key, board: { number: 1 } } });
    const mine = await studioSchedule(f.member.actor, { studioId: f.studioId, from: at(-7), to: at(14), scope: "mine" });
    expect(mine.checklistItems.filter((i) => i.card.id === showcase.id).map((i) => i.text).sort()).toEqual(["Health bar", "Late icons"]);
    // Outsiders see nothing of the studio.
    expect((await studioSchedule(f.outsider.actor, { studioId: f.otherStudioId, from: at(-7), to: at(14), scope: "all" })).checklistItems.some((i) => i.card.id === showcase.id)).toBe(false);
  });

  it("add the person's open items to their calendar feed as all-day events", async () => {
    const { url } = await createCalendarFeed(f.member.actor);
    const token = url.split("/api/calendar/")[1]!.replace(/\.ics$/, "");
    const ics = (await calendarFeedFor(token))!;
    const events = ics.split("BEGIN:VEVENT").slice(1);
    const health = events.find((e) => e.includes("SUMMARY:☐ Health bar"))!;
    expect(health).toContain(`DTSTART;VALUE=DATE:${day(4).replace(/-/g, "")}`);
    expect(health).toContain(`DTEND;VALUE=DATE:${day(5).replace(/-/g, "")}`);
    expect(health.replace(/\r\n /g, "")).toContain(`?card=${showcase.key}`);
    expect(events.some((e) => e.includes("Someone else"))).toBe(false);
    expect(events.some((e) => e.includes("Done already"))).toBe(false);
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    await revokeCalendarFeed(f.member.actor);
  });
});

describe("due day display", () => {
  it("is the same everywhere and marks overdue and today", () => {
    expect(formatDueDay("2026-10-16")).toBe("Fri 16 Oct");
    expect(formatDueDay("2027-01-04", "2026-10-09")).toBe("Mon 4 Jan 2027");
    expect(formatDueDay("2026-10-16", "2026-10-09")).toBe("Fri 16 Oct");
    expect(checklistDueState("2026-10-08", false, "2026-10-09")).toBe("overdue");
    expect(checklistDueState("2026-10-09", false, "2026-10-09")).toBe("today");
    expect(checklistDueState("2026-10-10", false, "2026-10-09")).toBe("upcoming");
    expect(checklistDueState("2026-10-08", true, "2026-10-09")).toBeNull();
    expect(checklistDueState(null, false, "2026-10-09")).toBeNull();
  });
});
