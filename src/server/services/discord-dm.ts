/**
 * Discord direct messages. Everyone who has connected their Discord account (Account → Security)
 * gets the notifications in DISCORD_DM_TYPES as DMs from the Forge bot; there are no per-type
 * settings, and disconnecting Discord stops them.
 *
 * Deliveries are queued by `notify` inside the event's transaction; this worker sends them after
 * commit, re-checking first that the notification's work is still live and open to the person and
 * that the same Discord account is still connected. Deadline reminders queued together go out as one
 * message. Discord only delivers DMs to people who share a server with the bot and allow DMs from
 * its members; when it refuses, DMs pause for that person, with the reason shown in their account
 * settings, until "Try again" or reconnecting succeeds.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { isDiscordDmType } from "@/lib/discord";
import { notificationSubject } from "@/lib/notifications";
import { now } from "../clock";
import { db } from "../db";
import { cards, deliverables, discordConnections, discordDmDeliveries, discordDmRecipients, oauthAccounts, studioMembers, studios, users } from "../db/schema";
import { appOrigin } from "../env";
import { invalid } from "../errors";
import type { Actor } from "./context";
import { discordApi, type ApiResult } from "./discord";
import { discordDmsConfigured } from "./discord-config";
import { buildDiscordMessage, discordTime, DM_DEFAULT_STYLE, DM_STYLES, dmSentence, escapeMarkdown, truncate, type DiscordMessage } from "./discord-message";
import { notificationLink, notificationStillDeliverable, type NotificationRecord } from "./notifications";

/** Retry delays after a failed send (attempt 1 → 30 s, …); after the last one the delivery is FAILED. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Older notifications aren't sent any more (like device notifications). */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Lines in one bundled deadline message. */
const BUNDLE_LIMIT = 10;

export const DM_UNREACHABLE =
  "Discord won't deliver Forge's messages to you. Make sure you're in a Discord server the Forge bot is in (your studio's server) and that you allow direct messages from that server's members, then try again.";
const DM_UNKNOWN_USER = "Discord couldn't find your account. Disconnect Discord here and connect it again.";

type Delivery = typeof discordDmDeliveries.$inferSelect;
type Recipient = typeof discordDmRecipients.$inferSelect;
type SendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; retryAfterMs: number | null; error: string; pause: string | null };

// ── Sending ─────────────────────────────────────────────────────────────────────────────────

function failure(res: ApiResult<unknown>): Extract<SendResult, { ok: false }> {
  // 50007: can't message this user (no shared server, or DMs from server members are off, or blocked).
  const pause = res.code === 50007 || (res.status === 403 && res.code !== 50013) ? DM_UNREACHABLE : res.code === 10013 ? DM_UNKNOWN_USER : null;
  const retryable = !pause && (res.status === 0 || res.status === 429 || res.status >= 500);
  return { ok: false, retryable, retryAfterMs: res.retryAfterMs, error: res.message || `HTTP ${res.status}`, pause };
}

async function openChannel(recipient: Recipient): Promise<{ id: string } | Extract<SendResult, { ok: false }>> {
  const open = await discordApi<{ id: string }>("/users/@me/channels", { method: "POST", body: { recipient_id: recipient.discordUserId } });
  if (!open.ok || !open.data?.id) return failure(open);
  await db.update(discordDmRecipients).set({ channelId: open.data.id, updatedAt: now() }).where(eq(discordDmRecipients.userId, recipient.userId));
  recipient.channelId = open.data.id;
  return { id: open.data.id };
}

/** Posts one message in the person's DM channel (opened on first use, reopened if Discord lost it). */
async function deliver(recipient: Recipient, message: DiscordMessage): Promise<SendResult> {
  const hadChannel = Boolean(recipient.channelId);
  let channelId = recipient.channelId;
  if (!channelId) {
    const opened = await openChannel(recipient);
    if (!("id" in opened)) return opened;
    channelId = opened.id;
  }
  let res = await discordApi<{ id: string }>(`/channels/${channelId}/messages`, { method: "POST", body: message });
  if (!res.ok && hadChannel && (res.code === 10003 || res.status === 404)) {
    const reopened = await openChannel(recipient);
    if (!("id" in reopened)) return reopened;
    res = await discordApi<{ id: string }>(`/channels/${reopened.id}/messages`, { method: "POST", body: message });
  }
  if (res.ok && res.data?.id) return { ok: true, messageId: res.data.id };
  return failure(res);
}

/** The person's connected Discord account and DM state (a fresh row when the account changed), or null. */
async function recipientFor(userId: string): Promise<Recipient | null> {
  const [link] = await db
    .select({ discordUserId: oauthAccounts.providerAccountId })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "discord")));
  if (!link) return null;
  const [row] = await db.select().from(discordDmRecipients).where(eq(discordDmRecipients.userId, userId));
  if (row && row.discordUserId === link.discordUserId) return row;
  const fresh = { discordUserId: link.discordUserId, channelId: null, welcomedAt: null, pausedAt: null, pausedReason: null, updatedAt: now() };
  const [saved] = await db
    .insert(discordDmRecipients)
    .values({ userId, ...fresh })
    .onConflictDoUpdate({ target: discordDmRecipients.userId, set: fresh })
    .returning();
  return saved!;
}

async function pause(userId: string, reason: string) {
  await db.update(discordDmRecipients).set({ pausedAt: now(), pausedReason: reason, updatedAt: now() }).where(eq(discordDmRecipients.userId, userId));
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The deadline of what the notification is about: the deliverable's own, else the card's. */
async function workDueAt(n: NotificationRecord): Promise<string | null> {
  if (n.deliverableId) {
    const [d] = await db.select({ dueAt: deliverables.dueAt }).from(deliverables).where(eq(deliverables.id, n.deliverableId));
    if (d?.dueAt) return d.dueAt.toISOString();
  }
  if (!n.cardId) return null;
  const [c] = await db.select({ dueAt: cards.dueAt }).from(cards).where(eq(cards.id, n.cardId));
  return c?.dueAt?.toISOString() ?? null;
}

/**
 * One notification: a label saying what kind it is, the card as the title link, one sentence that
 * doesn't repeat the card, the project and the work's deadline, and a button for the next step.
 */
async function notificationMessage(n: NotificationRecord, link: Awaited<ReturnType<typeof notificationLink>>, actorName: string | null): Promise<DiscordMessage> {
  const data = n.data as Record<string, unknown>;
  const style = DM_STYLES[n.type] ?? DM_DEFAULT_STYLE;
  const cardTitle = str(data.cardTitle);
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (link.projectName) fields.push({ name: "Project", value: escapeMarkdown(link.projectName), inline: true });
  if (n.type !== "DUE_SOON" && n.type !== "OVERDUE") {
    const due = discordTime(await workDueAt(n), "R");
    if (due) fields.push({ name: "Due", value: due, inline: true });
  }
  const [studio] = await db.select({ name: studios.name }).from(studios).where(eq(studios.id, n.studioId));
  return buildDiscordMessage({
    type: "TEST",
    color: style.color,
    author: style.label,
    title: link.cardKey && cardTitle ? `${link.cardKey} ${cardTitle}` : (cardTitle ?? link.projectName ?? "Forge"),
    url: `${appOrigin()}${link.path}`,
    description: dmSentence(n.type, data, actorName),
    fields,
    footer: studio?.name ?? "Forge",
    timestamp: n.createdAt.toISOString(),
    buttonLabel: style.button,
  });
}

/** Several deadline reminders at once: one list, overdue first, then by deadline. */
function deadlineBundle(items: Array<{ n: NotificationRecord; path: string }>, studioSlug: string, studioName: string): DiscordMessage {
  const dueOf = (n: NotificationRecord) => Date.parse(str((n.data as Record<string, unknown>).dueAt) ?? "") || 0;
  const sorted = [...items].sort((a, b) => dueOf(a.n) - dueOf(b.n));
  const overdue = items.filter((i) => i.n.type === "OVERDUE").length;
  const soon = items.length - overdue;
  const lines = sorted.slice(0, BUNDLE_LIMIT).map(({ n, path }) => {
    const subject = notificationSubject(n.data as Record<string, unknown>) || "Your work";
    const when = discordTime(str((n.data as Record<string, unknown>).dueAt), "R");
    const late = n.type === "OVERDUE";
    return `${late ? "🚨" : "⏰"} [${escapeMarkdown(truncate(subject, 120))}](${appOrigin()}${path}) · ${late ? `was due ${when ?? "earlier"}` : `due ${when ?? "soon"}`}`;
  });
  if (items.length > BUNDLE_LIMIT) lines.push(`…and ${items.length - BUNDLE_LIMIT} more in your calendar.`);
  return buildDiscordMessage({
    type: "TEST",
    color: overdue ? DM_STYLES.OVERDUE!.color : DM_STYLES.DUE_SOON!.color,
    author: overdue ? "🚨 Your deadlines" : "⏰ Your deadlines",
    title: [overdue ? `${overdue} overdue` : null, soon ? `${soon} due within 24 hours` : null].filter(Boolean).join(", "),
    url: `${appOrigin()}/${studioSlug}/calendar`,
    description: lines.join("\n"),
    footer: studioName,
    buttonLabel: "Open my calendar",
  });
}

function welcomeMessage(): DiscordMessage {
  return buildDiscordMessage({
    type: "TEST",
    color: DM_DEFAULT_STYLE.color,
    author: "👋 Welcome",
    title: "Forge is connected",
    url: `${appOrigin()}/account/security`,
    description: [
      "I'll message you here when:",
      "⏰ your work is due soon or overdue",
      "📥 there's something for you to review, or a decision on your work",
      "👤 you're assigned to a card or made its reviewer",
      "💬 someone mentions you or replies to you",
      "",
      "To stop these messages, disconnect Discord in your Forge account settings.",
    ].join("\n"),
    footer: "Forge",
    buttonLabel: "Account settings",
  });
}

// ── Queue ───────────────────────────────────────────────────────────────────────────────────

async function finish(ids: string[], status: "SENT" | "SKIPPED" | "FAILED", error: string | null = null, messageId: string | null = null) {
  if (!ids.length) return;
  await db
    .update(discordDmDeliveries)
    .set({ status, error, messageId, sentAt: status === "SENT" ? now() : null })
    .where(inArray(discordDmDeliveries.id, ids));
}

async function requeue(rows: Delivery[], error: string, retryAfterMs: number | null) {
  const attempts = Math.max(...rows.map((r) => r.attempts));
  if (attempts >= MAX_ATTEMPTS) return finish(rows.map((r) => r.id), "FAILED", error).then(() => "failed" as const);
  // Discord's rate limit says exactly how long to wait; otherwise back off.
  const wait = retryAfterMs ?? RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
  await db
    .update(discordDmDeliveries)
    .set({ status: "QUEUED", error, nextAttemptAt: new Date(Date.now() + wait) })
    .where(inArray(discordDmDeliveries.id, rows.map((r) => r.id)));
  return "retried" as const;
}

/**
 * Sends due direct messages. Rows are claimed (SENDING, attempt counted) before sending so several
 * workers never send the same one; a claim that's never finished (crash) is picked up again after
 * 5 minutes. Each person's rows are handled together so deadline reminders can share a message.
 */
export async function processDiscordDmDeliveries(limit = 50): Promise<{ sent: number; skipped: number; failed: number; retried: number }> {
  const totals = { sent: 0, skipped: 0, failed: 0, retried: 0 };
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: discordDmDeliveries.id })
      .from(discordDmDeliveries)
      .where(and(or(eq(discordDmDeliveries.status, "QUEUED"), eq(discordDmDeliveries.status, "SENDING")), lte(discordDmDeliveries.nextAttemptAt, sql`now()`)))
      .orderBy(asc(discordDmDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(discordDmDeliveries)
      .set({ status: "SENDING", attempts: sql`${discordDmDeliveries.attempts} + 1`, nextAttemptAt: sql`now() + interval '5 minutes'` })
      .where(inArray(discordDmDeliveries.id, due.map((d) => d.id)))
      .returning();
  });
  if (!claimed.length) return totals;
  if (!discordDmsConfigured()) {
    await finish(claimed.map((d) => d.id), "SKIPPED", "Discord is no longer set up on the server.");
    totals.skipped += claimed.length;
    return totals;
  }

  const byUser = new Map<string, Delivery[]>();
  for (const d of [...claimed].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) byUser.set(d.userId, [...(byUser.get(d.userId) ?? []), d]);

  for (const [userId, rows] of byUser) {
    try {
      const recipient = await recipientFor(userId);
      if (!recipient) {
        await finish(rows.map((r) => r.id), "SKIPPED", "Discord was disconnected.");
        totals.skipped += rows.length;
        continue;
      }
      // What to send: the welcome, single notifications, and deadline reminders grouped per studio.
      const messages: Array<{ rows: Delivery[]; message: DiscordMessage; welcome?: boolean }> = [];
      const deadlines = new Map<string, Array<{ row: Delivery; n: NotificationRecord; path: string }>>();
      const skip = async (row: Delivery, reason: string) => {
        await finish([row.id], "SKIPPED", reason);
        totals.skipped++;
      };
      for (const row of rows) {
        if (row.kind === "WELCOME") {
          messages.push({ rows: [row], message: welcomeMessage(), welcome: true });
          continue;
        }
        if (recipient.pausedAt) {
          await skip(row, "Paused: Discord refused an earlier message.");
          continue;
        }
        const n = row.notificationId ? await notificationStillDeliverable(db, row.notificationId) : null;
        if (!n || n.userId !== userId) {
          await skip(row, "The work was archived or removed, or access was lost.");
          continue;
        }
        if (Date.now() - n.createdAt.getTime() > STALE_AFTER_MS) {
          await skip(row, "Too old to send.");
          continue;
        }
        if (!isDiscordDmType(n.type)) {
          await skip(row, "Not sent as a direct message.");
          continue;
        }
        const link = await notificationLink(db, n);
        if (n.type === "DUE_SOON" || n.type === "OVERDUE") {
          deadlines.set(n.studioId, [...(deadlines.get(n.studioId) ?? []), { row, n, path: link.path }]);
          continue;
        }
        const [actor] = n.actorId ? await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, n.actorId)) : [];
        messages.push({ rows: [row], message: await notificationMessage(n, link, actor?.displayName ?? null) });
      }
      for (const [studioId, items] of deadlines) {
        if (items.length === 1) {
          const only = items[0]!;
          messages.push({ rows: [only.row], message: await notificationMessage(only.n, await notificationLink(db, only.n), null) });
          continue;
        }
        const [studio] = await db.select({ slug: studios.slug, name: studios.name }).from(studios).where(eq(studios.id, studioId));
        messages.push({ rows: items.map((i) => i.row), message: deadlineBundle(items, studio?.slug ?? "", studio?.name ?? "Forge") });
      }

      let paused = false;
      for (const { rows: group, message, welcome } of messages) {
        if (paused) {
          await finish(group.map((r) => r.id), "SKIPPED", "Paused: Discord refused an earlier message.");
          totals.skipped += group.length;
          continue;
        }
        const result = await deliver(recipient, message);
        if (result.ok) {
          await finish(group.map((r) => r.id), "SENT", null, result.messageId);
          if (welcome) await db.update(discordDmRecipients).set({ welcomedAt: now(), pausedAt: null, pausedReason: null, updatedAt: now() }).where(eq(discordDmRecipients.userId, userId));
          totals.sent += group.length;
        } else if (result.pause) {
          await pause(userId, result.pause);
          await finish(group.map((r) => r.id), "FAILED", result.error);
          totals.failed += group.length;
          paused = true;
        } else if (result.retryable) {
          const outcome = await requeue(group, result.error, result.retryAfterMs);
          totals[outcome] += group.length;
        } else {
          await finish(group.map((r) => r.id), "FAILED", result.error);
          totals.failed += group.length;
        }
      }
    } catch (error) {
      // Unexpected (database hiccup): retry like a transient failure.
      const message = error instanceof Error ? error.message : String(error);
      const pending = await db
        .select()
        .from(discordDmDeliveries)
        .where(and(inArray(discordDmDeliveries.id, rows.map((r) => r.id)), eq(discordDmDeliveries.status, "SENDING")))
        .catch(() => [] as Delivery[]);
      if (pending.length) {
        const outcome = await requeue(pending, message, null).catch(() => "failed" as const);
        totals[outcome] += pending.length;
      }
    }
  }
  return totals;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Sends queued direct messages shortly after an event commits (the minutely job is the safety net). */
export function scheduleDiscordDmDelivery() {
  if (process.env.NODE_ENV === "test" || timer || !discordDmsConfigured()) return;
  timer = setTimeout(() => {
    timer = null;
    void processDiscordDmDeliveries().catch((error) => console.error("[discord] direct message delivery failed", error));
  }, 250);
}

// ── Connecting and disconnecting ────────────────────────────────────────────────────────────

/** After someone connects a Discord account: start fresh (no pause) and say hello. */
export async function onDiscordAccountLinked(userId: string, discordUserId: string) {
  if (!discordDmsConfigured()) return;
  const fresh = { discordUserId, channelId: null, welcomedAt: null, pausedAt: null, pausedReason: null, updatedAt: now() };
  await db.insert(discordDmRecipients).values({ userId, ...fresh }).onConflictDoUpdate({ target: discordDmRecipients.userId, set: fresh });
  await db.insert(discordDmDeliveries).values({ userId, kind: "WELCOME", dedupeKey: `welcome:${Date.now()}` }).onConflictDoNothing();
  scheduleDiscordDmDelivery();
}

/** After someone disconnects Discord: nothing more goes out (queued messages are skipped). */
export async function onDiscordAccountUnlinked(userId: string) {
  await db.delete(discordDmRecipients).where(eq(discordDmRecipients.userId, userId));
  await db
    .update(discordDmDeliveries)
    .set({ status: "SKIPPED", error: "Discord was disconnected." })
    .where(and(eq(discordDmDeliveries.userId, userId), eq(discordDmDeliveries.status, "QUEUED")));
}

export interface DiscordDmStatusDTO {
  /** The server can send direct messages (the bot is set up). */
  available: boolean;
  /** Connected and not paused: notifications go out as DMs. */
  active: boolean;
  paused: boolean;
  reason: string | null;
  /** Discord servers connected to the person's studios (where the Forge bot is). */
  servers: string[];
}

export async function discordDmStatus(userId: string): Promise<DiscordDmStatusDTO> {
  const available = discordDmsConfigured();
  const [link] = await db.select({ id: oauthAccounts.providerAccountId }).from(oauthAccounts).where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "discord")));
  if (!available || !link) return { available, active: false, paused: false, reason: null, servers: [] };
  const [row] = await db.select().from(discordDmRecipients).where(and(eq(discordDmRecipients.userId, userId), eq(discordDmRecipients.discordUserId, link.id)));
  const paused = Boolean(row?.pausedAt);
  const servers = paused
    ? (
        await db
          .selectDistinct({ name: discordConnections.guildName })
          .from(discordConnections)
          .innerJoin(studioMembers, and(eq(studioMembers.studioId, discordConnections.studioId), eq(studioMembers.userId, userId)))
          .where(isNull(discordConnections.lostAt))
      ).map((s) => s.name)
    : [];
  return { available, active: !paused, paused, reason: row?.pausedReason ?? null, servers };
}

/** "Try again": sends a short message right away; if Discord accepts it, DMs resume. */
export async function retryDiscordDms(actor: Actor): Promise<DiscordDmStatusDTO> {
  if (!discordDmsConfigured()) throw invalid("Discord isn't set up on this Forge server.");
  const recipient = await recipientFor(actor.userId);
  if (!recipient) throw invalid("Connect your Discord account first.");
  const result = await deliver(
    recipient,
    buildDiscordMessage({
      type: "TEST",
      color: DM_STYLES.APPROVED!.color,
      author: "✅ All set",
      title: "Direct messages from Forge are working",
      url: `${appOrigin()}/account/security`,
      description: "You'll get your deadline, review, assignment and mention notifications here again.",
      footer: "Forge",
      buttonLabel: "Account settings",
    }),
  );
  if (result.ok) {
    await db.update(discordDmRecipients).set({ pausedAt: null, pausedReason: null, updatedAt: now() }).where(eq(discordDmRecipients.userId, actor.userId));
    return discordDmStatus(actor.userId);
  }
  if (result.pause) {
    await pause(actor.userId, result.pause);
    throw invalid(result.pause);
  }
  throw invalid(`Discord didn't accept the message (${result.error}). Please try again in a minute.`);
}
