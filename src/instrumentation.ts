/**
 * Starts lightweight in-process schedulers when running on a long-lived Node
 * server (local dev, `next start`, containers). Serverless deployments should
 * disable ENABLE_INPROCESS_JOBS and call /api/cron/due-dates from a scheduler.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { productionWarnings } = await import("./server/env");
  for (const warning of productionWarnings()) console.warn(`[forge] production config: ${warning}`);
  if (process.env.ENABLE_INPROCESS_JOBS === "false") return;
  const g = globalThis as unknown as { __forgeJobsStarted?: boolean };
  if (g.__forgeJobsStarted) return;
  g.__forgeJobsStarted = true;

  const { runDueDateReminders } = await import("./server/services/due-dates");
  const { deliverOutbox } = await import("./server/services/email");
  const { evictStaleRobloxAssets } = await import("./server/services/roblox");
  const { recoverMediaJobs } = await import("./server/services/media");
  const { sharedRateLimiter } = await import("./server/rate-limit");
  const { processStorageDeletions } = await import("./server/services/purge");
  const { processPushDeliveries } = await import("./server/services/push");
  const { processDiscordDeliveries, runDiscordDueDigests } = await import("./server/services/discord");

  const safely = (name: string, fn: () => Promise<unknown>) => () =>
    fn().catch((error) => console.error(`[forge] scheduled job "${name}" failed`, error));

  // The media queue is in memory: pick up work a restart interrupted, rebuild out-of-date
  // Roblox previews, and free uploads that were never finished.
  setTimeout(safely("media-recovery", recoverMediaJobs), 5_000);
  setTimeout(safely("due-dates", runDueDateReminders), 15_000);
  setInterval(safely("due-dates", runDueDateReminders), 5 * 60_000);
  setInterval(safely("email-outbox", deliverOutbox), 60_000);
  // Device notifications go out right after each event; this catches retries and anything missed.
  setTimeout(safely("push-delivery", () => processPushDeliveries()), 20_000);
  setInterval(safely("push-delivery", () => processPushDeliveries()), 60_000);
  // Discord feeds: like device notifications, plus the once-a-day deadline summary.
  setTimeout(safely("discord-delivery", () => processDiscordDeliveries()), 25_000);
  setInterval(safely("discord-delivery", () => processDiscordDeliveries()), 60_000);
  setInterval(safely("discord-digest", () => runDiscordDueDigests()), 5 * 60_000);
  // Roblox assets fetched for previews are freed after 7 days without being requested.
  setTimeout(safely("roblox-cache", evictStaleRobloxAssets), 60_000);
  setInterval(safely("roblox-cache", evictStaleRobloxAssets), 60 * 60_000);
  setInterval(safely("rate-limits", () => sharedRateLimiter.sweep()), 60 * 60_000);
  // Files freed by permanent deletions: removed once unreferenced, retried until it succeeds.
  setTimeout(safely("storage-cleanup", processStorageDeletions), 30_000);
  setInterval(safely("storage-cleanup", processStorageDeletions), 5 * 60_000);
}
