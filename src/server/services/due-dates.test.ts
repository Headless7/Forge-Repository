import { and, eq, gte } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { notifications } from "@/server/db/schema";
import { expectAppError, setupStudio, type Fixture, type TestUser } from "@/test/helpers";
import { listItemActivity } from "./activity";
import { runDueDateReminders } from "./due-dates";
import * as forums from "./forums";
import { listNotifications } from "./notifications";

let f: Fixture;
let bugsForumId: string;
beforeAll(async () => {
  f = await setupStudio();
  bugsForumId = (await forums.listForumsFor(f.owner.actor, f.projectId)).find((x) => x.kind === "BUGS")!.id;
});

const HOUR = 3600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

/** Deadline notices about one item for one person, oldest first. */
async function notices(who: TestUser, itemId: string, since = new Date(0)) {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, who.id), eq(notifications.itemId, itemId), gte(notifications.createdAt, since)))
    .orderBy(notifications.createdAt);
  return rows.map((n) => n.type).filter((t) => t === "DUE_SOON" || t === "OVERDUE" || t === "DUE_CHANGED");
}

async function everyoneNotified(itemId: string) {
  const rows = await db.select({ type: notifications.type }).from(notifications).where(eq(notifications.itemId, itemId));
  return rows.map((r) => r.type).filter((t) => t === "DUE_SOON" || t === "OVERDUE");
}

const item = (title: string, input: Partial<forums.CreateItemInput> = {}, forumId = bugsForumId) => forums.createItem(f.manager.actor, { forumId, title, reviewerId: null, ...input });

describe("forum item deadlines", () => {
  it("reminds the assignee once per deadline, however often the job runs", async () => {
    const soon = await item("Lamps float", { assigneeId: f.member.id, reviewerId: f.admin.id, dueAt: inHours(3) });
    const late = await item("Door clips", { assigneeId: f.member2.id, dueAt: inHours(-2) });
    await forums.setItemStatus(f.member2.actor, { itemId: late.id, status: "IN_PROGRESS" });

    await Promise.all([runDueDateReminders(), runDueDateReminders(), runDueDateReminders()]);
    await runDueDateReminders();
    expect(await notices(f.member, soon.id)).toEqual(["DUE_SOON"]);
    expect(await notices(f.member2, late.id)).toEqual(["OVERDUE"]);
    // The reviewer has nothing to do until it's done.
    expect(await notices(f.admin, soon.id)).toEqual([]);

    // The inbox opens the item in its forum.
    const inbox = await listNotifications(f.member.actor);
    const reminder = inbox.items.find((n) => n.type === "DUE_SOON" && n.item?.id === soon.id)!;
    expect(reminder.href).toMatch(new RegExp(`/f/bugs\\?item=${soon.number}$`));
    expect(reminder.data).toMatchObject({ itemKey: soon.key, itemTitle: "Lamps float" });
  });

  it("reminds the reviewer, not the assignee, once the item is done and waiting to be verified", async () => {
    const fixed = await item("Shadows flicker", { assigneeId: f.member.id, reviewerId: f.admin.id, dueAt: inHours(5) });
    await forums.setItemStatus(f.member.actor, { itemId: fixed.id, status: "FIXED" });
    await runDueDateReminders();
    expect(await notices(f.admin, fixed.id)).toEqual(["DUE_SOON"]);
    expect(await notices(f.member, fixed.id)).toEqual([]);
  });

  it("notifies nobody about unassigned, resolved or archived items", async () => {
    const unassigned = await item("Nobody's on it", { dueAt: inHours(2) });
    const fixedNoReviewer = await item("Done, nobody verifies", { assigneeId: f.member.id, dueAt: inHours(2) });
    await forums.setItemStatus(f.member.actor, { itemId: fixedNoReviewer.id, status: "FIXED" });
    const verified = await item("Already verified", { assigneeId: f.member.id, reviewerId: f.admin.id, dueAt: inHours(2) });
    await forums.setItemStatus(f.member.actor, { itemId: verified.id, status: "FIXED" });
    await forums.setItemStatus(f.admin.actor, { itemId: verified.id, status: "VERIFIED" });
    const closed = await item("Won't fix", { assigneeId: f.member.id, dueAt: inHours(-1) });
    await forums.setItemStatus(f.manager.actor, { itemId: closed.id, status: "CLOSED", resolution: "WONT_FIX" });
    const playtest = await forums.createForum(f.manager.actor, { projectId: f.projectId, name: "Old playtest" });
    const archived = await item("In an archived forum", { assigneeId: f.member.id, dueAt: inHours(2) }, playtest.id);
    await forums.updateForum(f.manager.actor, { forumId: playtest.id, archived: true });

    await runDueDateReminders();
    for (const it of [unassigned, fixedNoReviewer, verified, closed, archived]) expect(await everyoneNotified(it.id)).toEqual([]);
  });

  it("tells the assignee and reviewer when the date moves, and a moved date earns fresh reminders", async () => {
    const moving = await item("Moving target", { assigneeId: f.member.id, reviewerId: f.admin.id, dueAt: inHours(4) });
    await runDueDateReminders();
    expect(await notices(f.member, moving.id)).toEqual(["DUE_SOON"]);

    const moved = new Date();
    await forums.updateItem(f.manager.actor, { itemId: moving.id, dueAt: inHours(6) });
    expect(await notices(f.member, moving.id, moved)).toEqual(["DUE_CHANGED"]);
    expect(await notices(f.admin, moving.id, moved)).toEqual(["DUE_CHANGED"]);
    expect(await notices(f.manager, moving.id, moved)).toEqual([]); // never the person who moved it
    await runDueDateReminders();
    await runDueDateReminders();
    expect(await notices(f.member, moving.id)).toEqual(["DUE_SOON", "DUE_CHANGED", "DUE_SOON"]);

    const cleared = new Date();
    const detail = await forums.updateItem(f.manager.actor, { itemId: moving.id, dueAt: null });
    expect(detail.dueAt).toBeNull();
    expect(await notices(f.admin, moving.id, cleared)).toEqual(["DUE_CHANGED"]);
    const [removal] = await db.select().from(notifications).where(and(eq(notifications.userId, f.admin.id), eq(notifications.itemId, moving.id), eq(notifications.type, "DUE_CHANGED"), gte(notifications.createdAt, cleared)));
    expect(removal!.data).toMatchObject({ dueAt: null });
  });

  it("lets only people who can edit the item set its date, and records it in the history", async () => {
    const own = await item("Who sets dates", { assigneeId: f.member.id });
    await expectAppError(forums.updateItem(f.member2.actor, { itemId: own.id, dueAt: inHours(10) }), "FORBIDDEN");
    const due = inHours(10);
    const detail = await forums.updateItem(f.member.actor, { itemId: own.id, dueAt: due });
    expect(detail.dueAt).toBe(due);
    const history = await listItemActivity(own.id);
    expect(history.map((e) => e.type)).toContain("item.due_changed");
  });
});
