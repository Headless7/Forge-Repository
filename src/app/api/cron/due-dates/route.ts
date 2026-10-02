import { NextResponse } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { env } from "@/server/env";
import { runDueDateReminders } from "@/server/services/due-dates";
import { deliverOutbox } from "@/server/services/email";
import { sharedRateLimiter } from "@/server/rate-limit";
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
  const robloxAssetsFreed = await evictStaleRobloxAssets();
  await sharedRateLimiter.sweep();
  return NextResponse.json({ ok: true, reminders, robloxAssetsFreed });
}
