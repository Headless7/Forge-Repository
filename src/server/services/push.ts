/**
 * Device notifications (Web Push): subscriptions per signed-in browser, and the durable delivery
 * queue. Deliveries are queued by `notify` inside the event's transaction; this worker sends them
 * after commit, re-checking everything first — the notification and its work still exist and
 * aren't archived, the person can still open the project, they still want this type on their
 * devices, and the device's sign-in session hasn't ended. Failures retry with backoff; push
 * services that report a subscription gone (404/410) make us forget that device.
 */
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { notificationText, type NotificationType } from "@/lib/notifications";
import { now } from "../clock";
import { db } from "../db";
import { pushDeliveries, pushSubscriptions, sessions, users } from "../db/schema";
import { forbidden, invalid, notFound } from "../errors";
import { fromB64url, isAcceptableEndpoint, sendPush, type PushResult } from "../push/web-push";
import type { Actor } from "./context";
import { channelEnabled, notificationLink, notificationStillDeliverable } from "./notifications";
import { pushConfigured, vapidKeys } from "./push-config";

/** Retry delays after a failed send (attempt 1 → 30 s, …); after the last one the delivery is FAILED. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const MAX_PUSH_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Older notifications aren't pushed any more (a device that comes back tomorrow doesn't need yesterday's pings). */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A device whose pushes keep failing permanently is forgotten. */
const MAX_DEVICE_FAILURES = 5;
const MAX_DEVICES_PER_USER = 20;

export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function validKeys(input: { p256dh: string; auth: string }) {
  try {
    const key = fromB64url(input.p256dh);
    const auth = fromB64url(input.auth);
    return key.length === 65 && key[0] === 4 && auth.length === 16;
  } catch {
    return false;
  }
}

export function pushPublicConfig() {
  const keys = vapidKeys();
  return { available: Boolean(keys), publicKey: keys?.publicKey ?? null };
}

/**
 * Whether this browser's subscription (identified by its endpoint) delivers to the signed-in
 * person. A device last used by someone else is detached here: the endpoint now belongs to a
 * browser the current account is using, so the previous account must stop reaching it.
 */
export async function pushStatus(actor: Actor, input: { endpoint: string }) {
  const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint));
  if (!row) return { subscribed: false };
  if (row.userId !== actor.userId) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
    return { subscribed: false, detachedOtherAccount: true };
  }
  if (actor.sessionId && row.sessionId !== actor.sessionId) {
    // Same person, new sign-in on this device: keep the device, tie it to the current session.
    await db.update(pushSubscriptions).set({ sessionId: actor.sessionId, updatedAt: now() }).where(eq(pushSubscriptions.id, row.id));
  }
  return { subscribed: true, id: row.id };
}

/** Registers (or re-binds) this browser for the signed-in person and session. */
export async function subscribePush(actor: Actor, input: { endpoint: string; p256dh: string; auth: string }) {
  if (!pushConfigured()) throw invalid("Device notifications aren't set up on this server.");
  if (!actor.sessionId) throw forbidden();
  if (!isAcceptableEndpoint(input.endpoint)) throw invalid("This browser's push service isn't supported.");
  if (!validKeys(input)) throw invalid("Invalid push subscription.");
  const label = deviceLabel(actor.userAgent);
  const id = await db.transaction(async (tx) => {
    // An endpoint belongs to one browser; whoever registers it now is who it notifies.
    await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, input.endpoint), sql`${pushSubscriptions.userId} <> ${actor.userId}`));
    const [row] = await tx
      .insert(pushSubscriptions)
      .values({ userId: actor.userId, sessionId: actor.sessionId!, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, label, userAgent: actor.userAgent?.slice(0, 300) ?? null })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { sessionId: actor.sessionId!, p256dh: input.p256dh, auth: input.auth, label, userAgent: actor.userAgent?.slice(0, 300) ?? null, failures: 0, updatedAt: now() },
      })
      .returning({ id: pushSubscriptions.id });
    const extra = await tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, actor.userId))
      .orderBy(desc(pushSubscriptions.updatedAt))
      .offset(MAX_DEVICES_PER_USER);
    if (extra.length) await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, extra.map((e) => e.id)));
    return row!.id;
  });
  return { subscribed: true, id };
}

export async function unsubscribePush(actor: Actor, input: { endpoint: string }) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, input.endpoint), eq(pushSubscriptions.userId, actor.userId)));
  return { subscribed: false };
}

/** The person's devices (never their endpoints, which are secret). */
export async function listPushDevices(actor: Actor) {
  const rows = await db
    .select({ id: pushSubscriptions.id, label: pushSubscriptions.label, createdAt: pushSubscriptions.createdAt, lastSuccessAt: pushSubscriptions.lastSuccessAt, failures: pushSubscriptions.failures, sessionId: pushSubscriptions.sessionId })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, actor.userId))
    .orderBy(desc(pushSubscriptions.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label || "Browser",
    createdAt: r.createdAt.toISOString(),
    lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
    failing: r.failures > 0,
    thisSession: Boolean(actor.sessionId && r.sessionId === actor.sessionId),
  }));
}

export async function removePushDevice(actor: Actor, input: { id: string }) {
  const removed = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, input.id), eq(pushSubscriptions.userId, actor.userId)))
    .returning({ id: pushSubscriptions.id });
  if (!removed.length) throw notFound("Device");
  return listPushDevices(actor);
}

/** Sends a test notification straight to one of the person's devices (or all of them). */
export async function sendTestPush(actor: Actor, input: { endpoint?: string | null }) {
  const keys = vapidKeys();
  if (!keys) throw invalid("Device notifications aren't set up on this server.");
  const devices = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, actor.userId), input.endpoint ? eq(pushSubscriptions.endpoint, input.endpoint) : undefined));
  if (!devices.length) throw notFound("Device");
  const results: Array<{ id: string; label: string; ok: boolean; error?: string }> = [];
  for (const d of devices) {
    const result = await sendPush(
      d,
      { title: "Forge", body: "Device notifications are working on this device.", url: "/account/notifications", tag: `test-${d.id}`, test: true },
      keys,
      { ttlSeconds: 60 * 60, urgency: "high" },
    );
    await afterSend(d.id, result);
    results.push({ id: d.id, label: d.label, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
  }
  return { results };
}

async function afterSend(subscriptionId: string, result: PushResult) {
  if (result.ok) {
    await db.update(pushSubscriptions).set({ failures: 0, lastSuccessAt: now() }).where(eq(pushSubscriptions.id, subscriptionId));
  } else if (result.gone) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId));
  } else if (!result.retryable) {
    const [row] = await db
      .update(pushSubscriptions)
      .set({ failures: sql`${pushSubscriptions.failures} + 1` })
      .where(eq(pushSubscriptions.id, subscriptionId))
      .returning({ failures: pushSubscriptions.failures });
    if (row && row.failures >= MAX_DEVICE_FAILURES) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscriptionId));
  }
}

async function finish(id: string, status: "SENT" | "SKIPPED" | "FAILED", error: string | null = null) {
  await db.update(pushDeliveries).set({ status, error, sentAt: status === "SENT" ? now() : null }).where(eq(pushDeliveries.id, id));
}

/**
 * Sends due device notifications. Rows are claimed (SENDING, attempt counted) before sending so
 * several workers never send the same one; a claim that's never finished (crash) is picked up
 * again after 5 minutes. On the device, the notification id is the tag, so a repeat replaces the
 * shown notification instead of adding a second one.
 */
export async function processPushDeliveries(limit = 50): Promise<{ sent: number; skipped: number; failed: number; retried: number }> {
  const totals = { sent: 0, skipped: 0, failed: 0, retried: 0 };
  const keys = vapidKeys();
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: pushDeliveries.id })
      .from(pushDeliveries)
      .where(and(or(eq(pushDeliveries.status, "QUEUED"), eq(pushDeliveries.status, "SENDING")), lte(pushDeliveries.nextAttemptAt, sql`now()`)))
      .orderBy(asc(pushDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(pushDeliveries)
      .set({ status: "SENDING", attempts: sql`${pushDeliveries.attempts} + 1`, nextAttemptAt: sql`now() + interval '5 minutes'` })
      .where(inArray(pushDeliveries.id, due.map((d) => d.id)))
      .returning();
  });

  for (const delivery of claimed) {
    try {
      if (!keys) {
        await finish(delivery.id, "SKIPPED", "Device notifications are no longer set up on the server.");
        totals.skipped++;
        continue;
      }
      const n = await notificationStillDeliverable(db, delivery.notificationId);
      if (!n) {
        await finish(delivery.id, "SKIPPED", "The work was archived or removed, or access was lost.");
        totals.skipped++;
        continue;
      }
      if (Date.now() - n.createdAt.getTime() > STALE_AFTER_MS) {
        await finish(delivery.id, "SKIPPED", "Too old to push.");
        totals.skipped++;
        continue;
      }
      if (!(await channelEnabled(db, n.userId, n.type as NotificationType, "PUSH"))) {
        await finish(delivery.id, "SKIPPED", "Device notifications for this type were switched off.");
        totals.skipped++;
        continue;
      }
      const [device] = await db
        .select({ sub: pushSubscriptions })
        .from(pushSubscriptions)
        .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
        .where(and(eq(pushSubscriptions.id, delivery.subscriptionId), eq(pushSubscriptions.userId, n.userId), gt(sessions.expiresAt, now())));
      if (!device) {
        await finish(delivery.id, "SKIPPED", "The device signed out.");
        totals.skipped++;
        continue;
      }
      const [actorRow] = n.actorId ? await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, n.actorId)) : [];
      const link = await notificationLink(db, n);
      // Restrained preview: who and what, never comment or feedback text.
      const payload = {
        title: link.projectName ?? "Forge",
        body: notificationText(n.type as NotificationType, n.data, actorRow?.displayName ?? null),
        url: link.path,
        tag: n.id,
        notificationId: n.id,
        timestamp: n.createdAt.getTime(),
      };
      const urgent = ["REVIEW_REQUESTED", "CHANGES_REQUESTED", "MENTIONED", "OVERDUE"].includes(n.type);
      const result = await sendPush(device.sub, payload, keys, { urgency: urgent ? "high" : "normal" });
      await afterSend(device.sub.id, result);
      if (result.ok) {
        await finish(delivery.id, "SENT");
        totals.sent++;
      } else if (result.gone) {
        // The subscription row (and with it this delivery) is gone.
        totals.skipped++;
      } else if (result.retryable && delivery.attempts < MAX_PUSH_ATTEMPTS) {
        await db
          .update(pushDeliveries)
          .set({ status: "QUEUED", error: result.error, nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[delivery.attempts - 1]!) })
          .where(eq(pushDeliveries.id, delivery.id));
        totals.retried++;
      } else {
        await finish(delivery.id, "FAILED", result.error);
        totals.failed++;
      }
    } catch (error) {
      // Unexpected (database hiccup): retry like a transient failure.
      const message = error instanceof Error ? error.message : String(error);
      if (delivery.attempts < MAX_PUSH_ATTEMPTS) {
        await db
          .update(pushDeliveries)
          .set({ status: "QUEUED", error: message, nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[delivery.attempts - 1]!) })
          .where(eq(pushDeliveries.id, delivery.id))
          .catch(() => {});
        totals.retried++;
      } else {
        await finish(delivery.id, "FAILED", message).catch(() => {});
        totals.failed++;
      }
    }
  }
  return totals;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Sends queued device notifications shortly after an event commits (the minutely job is the safety net). */
export function schedulePushDelivery() {
  if (process.env.NODE_ENV === "test" || timer || !pushConfigured()) return;
  timer = setTimeout(() => {
    timer = null;
    void processPushDeliveries().catch((error) => console.error("[push] delivery failed", error));
  }, 250);
}
