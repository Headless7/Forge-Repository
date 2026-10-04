import "server-only";
import { eq, sql } from "drizzle-orm";
import { isTipId, TIPS, type TutorialStateDTO } from "@/lib/tutorial";
import { now } from "../clock";
import { db } from "../db";
import { tutorialProgress, tutorialSettings } from "../db/schema";
import { invalid } from "../errors";
import type { Actor } from "./context";

/** A person's tutorial progress: whether tips are on, and the version of each tip they dismissed. */
export async function tutorialState(userId: string): Promise<TutorialStateDTO> {
  const [settings, rows] = await Promise.all([
    db.select({ enabled: tutorialSettings.tipsEnabled }).from(tutorialSettings).where(eq(tutorialSettings.userId, userId)),
    db.select({ tipId: tutorialProgress.tipId, version: tutorialProgress.version }).from(tutorialProgress).where(eq(tutorialProgress.userId, userId)),
  ]);
  return {
    enabled: settings[0]?.enabled ?? true,
    // Tips that no longer exist are left out (their rows are harmless).
    seen: Object.fromEntries(rows.filter((r) => isTipId(r.tipId)).map((r) => [r.tipId, r.version])),
  };
}

/**
 * Retires a tip. Idempotent and safe to run concurrently: one row per tip, and the stored version
 * only grows, so a stale or repeated request never brings an older tip back.
 */
export async function dismissTip(actor: Actor, input: { tipId: string; version: number }) {
  if (!isTipId(input.tipId)) throw invalid("Unknown tip.");
  const version = Math.min(input.version, TIPS[input.tipId].version);
  await db
    .insert(tutorialProgress)
    .values({ userId: actor.userId, tipId: input.tipId, version, dismissedAt: now() })
    .onConflictDoUpdate({
      target: [tutorialProgress.userId, tutorialProgress.tipId],
      set: { version: sql`greatest(${tutorialProgress.version}, excluded.version)`, dismissedAt: sql`excluded.dismissed_at` },
    });
  return { ok: true as const };
}

export async function setTipsEnabled(actor: Actor, enabled: boolean) {
  await db
    .insert(tutorialSettings)
    .values({ userId: actor.userId, tipsEnabled: enabled, updatedAt: now() })
    .onConflictDoUpdate({ target: tutorialSettings.userId, set: { tipsEnabled: enabled, updatedAt: now() } });
  return { enabled };
}

/** Forgets every dismissed tip and turns tips back on. Nothing is shown until features are used again. */
export async function resetTutorial(actor: Actor): Promise<TutorialStateDTO> {
  await db.transaction(async (tx) => {
    await tx.delete(tutorialProgress).where(eq(tutorialProgress.userId, actor.userId));
    await tx
      .insert(tutorialSettings)
      .values({ userId: actor.userId, tipsEnabled: true, resetAt: now(), updatedAt: now() })
      .onConflictDoUpdate({ target: tutorialSettings.userId, set: { tipsEnabled: true, resetAt: now(), updatedAt: now() } });
  });
  return { enabled: true, seen: {} };
}
