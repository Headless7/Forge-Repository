/** Notification emails: opt-in per type, sent only after commit, re-checked for access, retried. */
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.EMAIL_FROM = "Forge <noreply@test.dev>";
});

import { db } from "@/server/db";
import { emailOutbox, notifications } from "@/server/db/schema";
import { setupStudio, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import { deliverOutbox } from "./email";
import { notify, setNotificationPreference } from "./notifications";
import * as studios from "./studios";

const resendApi = vi.fn<(url: string, init: RequestInit) => Response>();
vi.stubGlobal("fetch", (url: string, init: RequestInit) => Promise.resolve(resendApi(url, init)));

let f: Fixture;
beforeAll(async () => {
  f = await setupStudio();
  await setNotificationPreference(f.member.actor, { type: "ASSIGNED", email: true });
});
beforeEach(() => {
  resendApi.mockReset();
  resendApi.mockReturnValue(new Response("{}", { status: 200 }));
});

const outboxFor = (email: string) => db.select().from(emailOutbox).where(and(eq(emailOutbox.to, email), eq(emailOutbox.template, "notification")));

describe("notification emails", () => {
  it("are sent only to people who switched the type on, with a link to the work", async () => {
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Emailed", assigneeIds: [f.member.id, f.member2.id] });
    expect(await outboxFor(f.member2.email)).toHaveLength(0); // didn't opt in
    const [queued] = await outboxFor(f.member.email);
    expect(queued).toMatchObject({ status: "QUEUED", userId: f.member.id, projectId: f.projectId });
    expect(queued!.textBody).toContain(`card=${card.key}`);
    await deliverOutbox();
    expect(resendApi).toHaveBeenCalledTimes(1);
    expect((await outboxFor(f.member.email)).find((e) => e.id === queued!.id)).toMatchObject({ status: "SENT" });
  });

  it("are never sent for a change that was rolled back", async () => {
    const before = (await outboxFor(f.member.email)).length;
    await expect(
      db.transaction(async (tx) => {
        await notify(tx, { recipientIds: [f.member.id], actorId: f.manager.id, type: "ASSIGNED", studioId: f.studioId, projectId: f.projectId, data: { cardKey: "X-1", cardTitle: "Rolled back" } });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(await outboxFor(f.member.email)).toHaveLength(before);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, f.member.id), eq(notifications.data, { cardKey: "X-1", cardTitle: "Rolled back" })))).toHaveLength(0);
  });

  it("are skipped when the recipient lost access before sending", async () => {
    const g = await setupStudio();
    await setNotificationPreference(g.member.actor, { type: "ASSIGNED", email: true });
    await cardService.createCard(g.manager.actor, { projectId: g.projectId, columnId: g.columns.vfx, title: "Then removed", assigneeIds: [g.member.id] });
    await studios.removeMember(g.admin.actor, { studioId: g.studioId, userId: g.member.id });
    await deliverOutbox();
    expect(resendApi).not.toHaveBeenCalled();
    const [row] = await outboxFor(g.member.email);
    expect(row).toMatchObject({ status: "SKIPPED" });
  });

  it("retry with backoff when the provider fails", async () => {
    resendApi.mockReturnValue(new Response("server error", { status: 500 }));
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Flaky", assigneeIds: [f.member.id] });
    const started = Date.now();
    await deliverOutbox();
    const [row] = (await outboxFor(f.member.email)).filter((e) => e.textBody.includes("Flaky"));
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(started + 55_000);
    // Not due yet: a second run doesn't hammer the provider.
    resendApi.mockClear();
    await deliverOutbox();
    expect(resendApi).not.toHaveBeenCalled();
  });
});
