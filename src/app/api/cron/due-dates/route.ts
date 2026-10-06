import { NextResponse } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { env } from "@/server/env";
import { runDueDateReminders } from "@/server/services/due-dates";
import { deliverOutbox, scrubExpiredOutboxLinks } from "@/server/services/email";
import { sharedRateLimiter } from "@/server/rate-limit";
import { processStorageDeletions } from "@/server/services/purge";
import { processDiscordDeliveries, runDiscordDueDigests } from "@/server/services/discord";
import { processDiscordDmDeliveries } from "@/server/services/discord-dm";
import { processPushDeliveries } from "@/server/services/push";
import { evictStaleRobloxAssets } from "@/server/services/roblox";

export const dynamic = "force-dynamic";

/** For external schedulers (e.g. Vercel Cron): `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!env.CRON_SECRET || !safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  }
  const reminders = await runDueDateReminders();
  await deliverOutbox();
  const push = await processPushDeliveries(200);
  const discordDigests = await runDiscordDueDigests();
  const discord = await processDiscordDeliveries(200);
  const discordDms = await processDiscordDmDeliveries(200);
  const robloxAssetsFreed = await evictStaleRobloxAssets();
  await sharedRateLimiter.sweep();
  const emailLinksRemoved = await scrubExpiredOutboxLinks();
  const storageCleanup = await processStorageDeletions();
  return NextResponse.json({ ok: true, reminders, push, discord: { ...discord, digests: discordDigests, dms: discordDms }, robloxAssetsFreed, emailLinksRemoved, storageCleanup });
}
