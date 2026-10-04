/** Tutorial progress: per person, idempotent, concurrency-safe. Fixtures are created here (test database only). */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { TIPS } from "@/lib/tutorial";
import { db } from "@/server/db";
import { tutorialProgress } from "@/server/db/schema";
import { createUser, expectAppError } from "@/test/helpers";
import { dismissTip, resetTutorial, setTipsEnabled, tutorialState } from "./tutorial";

describe("tutorial progress", () => {
  it("starts with tips on and nothing seen (existing users get tips only as they use features)", async () => {
    const u = await createUser("Fresh");
    expect(await tutorialState(u.id)).toEqual({ enabled: true, seen: {} });
  });

  it("records dismissals idempotently, and a version only ever grows", async () => {
    const u = await createUser("Dismisser");
    await dismissTip(u.actor, { tipId: "card.workspace", version: 1 });
    await dismissTip(u.actor, { tipId: "card.workspace", version: 1 });
    expect((await tutorialState(u.id)).seen).toEqual({ "card.workspace": 1 });
    const rows = await db.select().from(tutorialProgress).where(eq(tutorialProgress.userId, u.id));
    expect(rows).toHaveLength(1);
    // A stale client asking for an older version can't lower it; a newer one is capped at the current definition.
    await dismissTip(u.actor, { tipId: "card.workspace", version: 99 });
    expect((await tutorialState(u.id)).seen["card.workspace"]).toBe(TIPS["card.workspace"].version);
  });

  it("rejects unknown tips", async () => {
    const u = await createUser("Unknown");
    await expectAppError(dismissTip(u.actor, { tipId: "made.up", version: 1 }), "VALIDATION");
    await expectAppError(dismissTip(u.actor, { tipId: "__proto__", version: 1 }), "VALIDATION");
  });

  it("keeps each person's progress to themselves", async () => {
    const [a, b] = await Promise.all([createUser("Alice"), createUser("Bob")]);
    await dismissTip(a.actor, { tipId: "board.status", version: 1 });
    await setTipsEnabled(a.actor, false);
    expect(await tutorialState(b.id)).toEqual({ enabled: true, seen: {} });
    await resetTutorial(b.actor);
    expect(await tutorialState(a.id)).toEqual({ enabled: false, seen: { "board.status": 1 } });
  });

  it("keeps every dismissal when several devices save at once", async () => {
    const u = await createUser("Many devices");
    const tips = ["card.workspace", "card.revisions", "card.feedback", "board.status", "board.my-work", "schedule.dates"] as const;
    await Promise.all([...tips.map((tipId) => dismissTip(u.actor, { tipId, version: 1 })), ...tips.map((tipId) => dismissTip(u.actor, { tipId, version: 1 }))]);
    expect(Object.keys((await tutorialState(u.id)).seen).sort()).toEqual([...tips].sort());
  });

  it("turns tips off and on, and reset forgets progress and turns tips back on", async () => {
    const u = await createUser("Settings");
    await setTipsEnabled(u.actor, false);
    await setTipsEnabled(u.actor, false);
    expect((await tutorialState(u.id)).enabled).toBe(false);
    await dismissTip(u.actor, { tipId: "card.canvas", version: 1 });
    expect(await resetTutorial(u.actor)).toEqual({ enabled: true, seen: {} });
    expect(await tutorialState(u.id)).toEqual({ enabled: true, seen: {} });
    await setTipsEnabled(u.actor, true);
    expect((await tutorialState(u.id)).enabled).toBe(true);
  });
});
