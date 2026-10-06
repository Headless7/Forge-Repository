/**
 * Notification channels and archived work: in-app and device delivery chosen independently per
 * type; archived cards/deliverables/boards/projects hidden from the inbox (and back on restore,
 * read state intact); device pushes queued with the event, encrypted per device, re-checked and
 * retried; subscriptions bound to the signed-in session. Push services are stubbed (fetch) and
 * the payloads decrypted here like a browser would. Every fixture is created here.
 */
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // A throwaway VAPID pair used only by these tests (never by any server).
  process.env.VAPID_PUBLIC_KEY = "BOnvI02U6V1nNH7UE3HvCtBz7YzF3TpoknrkO_1L3lM5__GkTm2AtnDToi__maIaGb5H4Oo88xS67sWWkSuAyjA";
  process.env.VAPID_PRIVATE_KEY = "qOjQpdvuCnnsZnKiqwXlthRTcMI3fyXrUNItnvJ4goo";
  process.env.VAPID_SUBJECT = "mailto:ops@test.dev";
});

import { NOTIFICATION_TYPES, type NotificationType } from "@/lib/notifications";
import { createSession, invalidateSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { notifications, pushDeliveries, pushSubscriptions, sessions } from "@/server/db/schema";
import { createUser, primaryDeliverable, setupStudio, type Fixture, type TestUser } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as comments from "./comments";
import * as deliverables from "./deliverables";
import * as notificationService from "./notifications";
import * as projects from "./projects";
import * as push from "./push";

type Sent = { url: string; headers: Record<string, string>; body: Buffer };
const pushService = vi.fn<(sent: Sent) => Response>();
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  const body = Buffer.from(init.body as Uint8Array);
  return pushService({ url, headers: init.headers as Record<string, string>, body });
});

/** A browser: its push keys, and what it does with a message (RFC 8291, receiving side). */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, Math.floor(Math.random() * 255));
  return {
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    decrypt(body: Buffer) {
      const salt = body.subarray(0, 16);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const ciphertext = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
      const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", key, nonce);
      d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const padded = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
      return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString("utf8")) as { title: string; body: string; url: string; tag: string };
    },
  };
}

/** Signs `user` in on a new device and turns device notifications on there. */
async function device(user: TestUser) {
  const { token } = await createSession(user.id, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120" });
  const { hashToken } = await import("@/server/auth/crypto");
  const sessionId = hashToken(token);
  const b = browser();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${user.id}-${Math.random().toString(36).slice(2)}`;
  const actor = { ...user.actor, sessionId, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120" };
  await push.subscribePush(actor, { endpoint, ...b.keys });
  return { endpoint, sessionId, actor, browser: b };
}

let f: Fixture;
let cardId: string;
let cardKey: string;
let firstDeliverable: string;
let second: string;

const inboxIds = async (user: TestUser) => (await notificationService.listNotifications(user.actor, { limit: 100 })).items.map((n) => n.id);
const unread = (user: TestUser) => notificationService.unreadCount(user.id);

beforeAll(async () => {
  f = await setupStudio();
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Notified work", assigneeIds: [f.member.id] });
  cardId = card.id;
  cardKey = card.key;
  firstDeliverable = await primaryDeliverable(cardId);
  const detail = await deliverables.createDeliverable(f.manager.actor, { cardId, name: "Second piece", ownerId: f.member.id });
  second = detail.deliverables.find((d) => d.name === "Second piece")!.id;
});
beforeEach(() => {
  pushService.mockReset();
  pushService.mockImplementation(() => new Response(null, { status: 201 }));
});
afterEach(() => vi.useRealTimers());

describe("archived work in the inbox", () => {
  it("hides a card's notifications (and its deliverables') while archived, and restores them exactly", async () => {
    await comments.createComment(f.manager.actor, { cardId, body: "Card-wide note" });
    await comments.createComment(f.manager.actor, { cardId, body: "On the second piece", deliverableId: second });
    const before = await inboxIds(f.member);
    const unreadBefore = await unread(f.member);
    expect(unreadBefore).toBeGreaterThanOrEqual(2);
    // One read before archiving: it must come back read.
    await notificationService.markNotificationsRead(f.member.actor, { ids: [before[0]!] });
    const unreadAfterRead = await unread(f.member);

    await cardService.setCardArchived(f.manager.actor, { cardId, archived: true });
    const hidden = await inboxIds(f.member);
    expect(hidden.some((id) => before.includes(id))).toBe(false);
    expect(await unread(f.member)).toBe(unreadAfterRead - (before.length - 1));
    // "Mark all read" while hidden leaves the hidden ones alone.
    await notificationService.markNotificationsRead(f.member.actor, { all: true });

    const rows = await db.select().from(notifications).where(eq(notifications.userId, f.member.id));
    const countBefore = rows.length;
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: false });
    const back = await notificationService.listNotifications(f.member.actor, { limit: 100 });
    expect(before.every((id) => back.items.some((n) => n.id === id))).toBe(true);
    expect(back.items.find((n) => n.id === before[0])!.readAt).not.toBeNull();
    expect(back.items.filter((n) => before.slice(1).includes(n.id)).every((n) => n.readAt === null)).toBe(true);
    // Restoring resends nothing old (only a "restored" notice is new).
    const after = await db.select().from(notifications).where(eq(notifications.userId, f.member.id));
    expect(after.length - countBefore).toBe(1);
    expect(after.find((n) => !rows.some((r) => r.id === n.id))!.type).toBe("WORK_ARCHIVED");
  });

  it("hides only one deliverable's notifications when that deliverable is archived", async () => {
    await notificationService.markNotificationsRead(f.member.actor, { all: true, read: false });
    const all = await notificationService.listNotifications(f.member.actor, { limit: 100 });
    const aboutSecond = all.items.filter((n) => n.deliverable?.id === second).map((n) => n.id);
    const others = all.items.filter((n) => n.deliverable?.id !== second && n.card?.id === cardId).map((n) => n.id);
    expect(aboutSecond.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: second, archived: true });
    const visible = await inboxIds(f.member);
    expect(aboutSecond.some((id) => visible.includes(id))).toBe(false);
    expect(others.every((id) => visible.includes(id))).toBe(true);
    expect(await unread(f.member)).toBe(visible.length);
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: second, archived: false });
    const restored = await inboxIds(f.member);
    expect(aboutSecond.every((id) => restored.includes(id))).toBe(true);
  });

  it("hides notifications from archived projects, boards and columns, and sends no reminders there", async () => {
    const extraBoard = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Side board", columns: "roblox" });
    const col = (await board.getBoard(f.manager.actor, f.projectId, extraBoard.id)).columns[0]!;
    const sideCard = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: col.id, title: "On the side board", assigneeIds: [f.member.id] });
    const ids = (await notificationService.listNotifications(f.member.actor, { limit: 100 })).items.filter((n) => n.card?.id === sideCard.id).map((n) => n.id);
    expect(ids.length).toBe(1);
    await board.setBoardArchived(f.manager.actor, { boardId: extraBoard.id, archived: true });
    expect((await inboxIds(f.member)).some((id) => ids.includes(id))).toBe(false);
    // Nothing new is created about archived work either.
    const n = await db.transaction((tx) =>
      notificationService.notify(tx, { recipientIds: [f.member.id], actorId: f.manager.id, type: "DUE_SOON", studioId: f.studioId, projectId: f.projectId, cardId: sideCard.id, data: {} }),
    );
    expect(n).toEqual([]);
    await board.setBoardArchived(f.manager.actor, { boardId: extraBoard.id, archived: false });
    expect((await inboxIds(f.member)).some((id) => ids.includes(id))).toBe(true);

    await board.setColumnArchived(f.manager.actor, { columnId: col.id, archived: true });
    expect((await inboxIds(f.member)).some((id) => ids.includes(id))).toBe(false);
    await board.setColumnArchived(f.manager.actor, { columnId: col.id, archived: false });

    const p = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Archivable ${Date.now()}`, template: "roblox" });
    const pCol = (await board.getBoard(f.owner.actor, p.id)).columns[0]!;
    await cardService.createCard(f.manager.actor, { projectId: p.id, columnId: pCol.id, title: "In a project to archive", assigneeIds: [f.member.id] });
    const inProject = (await notificationService.listNotifications(f.member.actor, { limit: 100 })).items.filter((x) => x.project?.id === p.id).map((x) => x.id);
    expect(inProject.length).toBe(1);
    await projects.setProjectArchived(f.owner.actor, { projectId: p.id, archived: true });
    expect((await inboxIds(f.member)).some((id) => inProject.includes(id))).toBe(false);
    await projects.setProjectArchived(f.owner.actor, { projectId: p.id, archived: false });
    expect((await inboxIds(f.member)).some((id) => inProject.includes(id))).toBe(true);
  });

  it("links notifications to the card's board", async () => {
    const item = (await notificationService.listNotifications(f.member.actor, { limit: 100 })).items.find((n) => n.card?.id === cardId)!;
    expect(item.href).toMatch(new RegExp(`/b/1\\?card=${cardKey}`));
    expect(item.board).toMatchObject({ number: 1 });
  });
});

describe("channels per type", () => {
  it("supports every combination of in-app and device for every type", async () => {
    const person = await createUser("Channels");
    await db.insert((await import("@/server/db/schema")).studioMembers).values({ studioId: f.studioId, userId: person.id, role: "CONTRIBUTOR" });
    const dev = await device(person);
    const combos = [
      { inApp: true, push: true },
      { inApp: true, push: false },
      { inApp: false, push: true },
      { inApp: false, push: false },
    ];
    for (const type of NOTIFICATION_TYPES) {
      for (const combo of combos) {
        await notificationService.setNotificationPreference(person.actor, { type, ...combo });
        const unreadBefore = await unread(person);
        const notified = await db.transaction((tx) =>
          notificationService.notify(tx, { recipientIds: [person.id], actorId: f.manager.id, type, studioId: f.studioId, projectId: f.projectId, cardId, data: { cardKey, cardTitle: "Notified work" } }),
        );
        const [row] = await db.select().from(notifications).where(and(eq(notifications.userId, person.id), eq(notifications.type, type))).orderBy((await import("drizzle-orm")).desc(notifications.createdAt)).limit(1);
        const queued = row ? await db.select().from(pushDeliveries).where(eq(pushDeliveries.notificationId, row.id)) : [];
        const label = `${type} ${JSON.stringify(combo)}`;
        if (!combo.inApp && !combo.push) {
          expect(notified, label).toEqual([]);
          continue;
        }
        expect(notified, label).toEqual([person.id]);
        expect(row!.inbox, label).toBe(combo.inApp);
        expect(await unread(person), label).toBe(unreadBefore + (combo.inApp ? 1 : 0));
        expect(queued.map((q) => q.subscriptionId), label).toEqual(combo.push ? [(await push.pushStatus(dev.actor, { endpoint: dev.endpoint })).id] : []);
        // Device-only notifications never show in the inbox.
        if (!combo.inApp) expect((await inboxIds(person)).includes(row!.id), label).toBe(false);
        await db.delete(notifications).where(eq(notifications.id, row!.id));
      }
    }
    // Preferences persist per channel, independently.
    await notificationService.setNotificationPreference(person.actor, { type: "APPROVED", inApp: false });
    await notificationService.setNotificationPreference(person.actor, { type: "APPROVED", push: true });
    const prefs = await notificationService.getNotificationPreferences(person.actor);
    expect(prefs.pushAvailable).toBe(true);
    expect(prefs.types.find((t) => t.type === "APPROVED")).toMatchObject({ inApp: false, push: true, email: false });
  });

  it("defaults device delivery on for the important types and off for routine ones", async () => {
    const fresh = await createUser("Fresh");
    const prefs = await notificationService.getNotificationPreferences(fresh.actor);
    const on = prefs.types.filter((t) => t.push).map((t) => t.type as NotificationType);
    expect(on).toEqual(expect.arrayContaining(["ASSIGNED", "REVIEW_REQUESTED", "CHANGES_REQUESTED", "APPROVED", "UNBLOCKED", "DUE_SOON", "OVERDUE", "MENTIONED", "REPLY"]));
    expect(on).not.toContain("WATCHED_CARD");
    expect(prefs.types.every((t) => t.inApp)).toBe(true);
  });
});

describe("device notifications", () => {
  let dev: Awaited<ReturnType<typeof device>>;
  beforeAll(async () => {
    dev = await device(f.member2);
  });

  const queueOne = (type: NotificationType = "ASSIGNED", extra: Record<string, unknown> = {}) =>
    db.transaction((tx) =>
      notificationService.notify(tx, { recipientIds: [f.member2.id], actorId: f.manager.id, type, studioId: f.studioId, projectId: f.projectId, cardId, deliverableId: firstDeliverable, data: { cardKey, cardTitle: "Notified work", excerpt: "secret feedback text", ...extra } }),
    );

  it("sends an encrypted, signed push with a restrained preview and a deep link — once", async () => {
    await queueOne();
    const result = await push.processPushDeliveries();
    expect(result.sent).toBe(1);
    const call = pushService.mock.calls[0]![0];
    expect(call.url).toBe(dev.endpoint);
    expect(call.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(call.headers["Content-Encoding"]).toBe("aes128gcm");
    const payload = dev.browser.decrypt(call.body);
    expect(payload.body).toMatch(/made you responsible for/);
    expect(JSON.stringify(payload)).not.toContain("secret feedback text");
    expect(payload.url).toMatch(new RegExp(`/b/1\\?card=${cardKey}&d=1$`));
    // Nothing left to send: processing again (retries, a second worker) sends nothing more.
    expect((await push.processPushDeliveries()).sent).toBe(0);
    expect(pushService).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures with backoff, then gives up", async () => {
    pushService.mockImplementation(() => new Response("busy", { status: 503 }));
    await queueOne();
    expect((await push.processPushDeliveries()).retried).toBe(1);
    const [row] = await db.select().from(pushDeliveries).where(and(eq(pushDeliveries.userId, f.member2.id), eq(pushDeliveries.status, "QUEUED")));
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await db.update(pushDeliveries).set({ nextAttemptAt: new Date(Date.now() - 1000), attempts: push.MAX_PUSH_ATTEMPTS - 1 }).where(eq(pushDeliveries.id, row!.id));
    expect((await push.processPushDeliveries()).failed).toBe(1);
  });

  it("re-checks before sending: archived work, lost access and switched-off types are skipped", async () => {
    await queueOne();
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: firstDeliverable, archived: true }).catch(() => {});
    // (The primary deliverable may be the card's only one; archive the card instead if so.)
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: true });
    expect((await push.processPushDeliveries()).skipped).toBeGreaterThanOrEqual(1);
    await cardService.setCardArchived(f.manager.actor, { cardId, archived: false });
    await deliverables.setDeliverableArchived(f.manager.actor, { deliverableId: firstDeliverable, archived: false }).catch(() => {});

    await queueOne();
    await notificationService.setNotificationPreference(f.member2.actor, { type: "ASSIGNED", push: false });
    expect((await push.processPushDeliveries()).skipped).toBe(1);
    await notificationService.setNotificationPreference(f.member2.actor, { type: "ASSIGNED", push: true });

    const priv = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Revoked ${Date.now()}`, template: "roblox", visibility: "PRIVATE" });
    await projects.setProjectMember(f.owner.actor, { projectId: priv.id, userId: f.member2.id, member: true });
    const col = (await board.getBoard(f.owner.actor, priv.id)).columns[0]!;
    await cardService.createCard(f.manager.actor, { projectId: priv.id, columnId: col.id, title: "Private work", assigneeIds: [f.member2.id] });
    await projects.setProjectMember(f.owner.actor, { projectId: priv.id, userId: f.member2.id, member: false });
    const before = pushService.mock.calls.length;
    expect((await push.processPushDeliveries()).skipped).toBe(1);
    expect(pushService.mock.calls.length).toBe(before);
  });

  it("forgets devices the push service reports gone", async () => {
    const other = await device(f.member2);
    pushService.mockImplementation((sent) => new Response(null, { status: sent.url === other.endpoint ? 410 : 201 }));
    await queueOne();
    const result = await push.processPushDeliveries();
    expect(result.sent).toBe(1);
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, other.endpoint))).toHaveLength(0);
  });

  it("stops at sign-out, and moves a shared browser to whoever signs in there", async () => {
    const shared = await device(f.member2);
    // Someone else signs in on the same browser: the device detaches from the first account.
    const { token } = await createSession(f.viewer.id);
    const { hashToken } = await import("@/server/auth/crypto");
    const viewerActor = { ...f.viewer.actor, sessionId: hashToken(token) };
    expect(await push.pushStatus(viewerActor, { endpoint: shared.endpoint })).toMatchObject({ subscribed: false, detachedOtherAccount: true });
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, shared.endpoint))).toHaveLength(0);
    // Signing out ends the session and with it the device subscription.
    await invalidateSession(dev.sessionId);
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, dev.endpoint))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.id, dev.sessionId))).toHaveLength(0);
    await queueOne();
    expect(pushService).not.toHaveBeenCalled();
    expect((await push.processPushDeliveries()).sent).toBe(0);
  });

  it("only lets people manage their own devices, and refuses bad subscriptions", async () => {
    const mine = await device(f.member);
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, mine.endpoint));
    await expect(push.removePushDevice(f.member2.actor, { id: row!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await push.listPushDevices(mine.actor)).find((d) => d.id === row!.id)).toMatchObject({ label: "Edge on Windows", thisSession: true });
    await expect(push.subscribePush(mine.actor, { endpoint: "http://insecure.example.net/x", ...browser().keys })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(push.subscribePush(mine.actor, { endpoint: "https://127.0.0.1/x", ...browser().keys })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(push.subscribePush(mine.actor, { endpoint: "https://fcm.googleapis.com/fcm/send/y", p256dh: "AAAA", auth: "BBBB" })).rejects.toMatchObject({ code: "VALIDATION" });
    await push.removePushDevice(f.member.actor, { id: row!.id });
    expect(await push.listPushDevices(f.member.actor)).toHaveLength(0);
  });

  it("sends a test notification to the current device", async () => {
    const d = await device(f.manager);
    const result = await push.sendTestPush(d.actor, { endpoint: d.endpoint });
    expect(result.results).toEqual([expect.objectContaining({ ok: true })]);
    expect(d.browser.decrypt(pushService.mock.calls.at(-1)![0].body).body).toMatch(/working on this device/);
  });
});
