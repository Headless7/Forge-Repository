import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { NOTIFICATION_TYPES, type NotificationChannelId, type NotificationType } from "@/lib/notifications";
import type { NotificationDTO } from "@/lib/types";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { cards, notificationPreferences, notifications, projects, studioMembers, studios } from "../db/schema";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { loadUsers, toUserDTO } from "./users-lookup";

export type NotificationRecord = typeof notifications.$inferSelect;

/**
 * External delivery channels (Discord DMs/webhooks, email digests …) plug in here.
 * In-app delivery is the notifications table itself and is always active.
 */
export interface NotificationChannel {
  readonly id: Exclude<NotificationChannelId, "IN_APP">;
  deliver(records: NotificationRecord[]): Promise<void>;
}

const channels: NotificationChannel[] = [];

export function registerNotificationChannel(channel: NotificationChannel) {
  if (!channels.some((c) => c.id === channel.id)) channels.push(channel);
}

export interface NotifyInput {
  recipientIds: Iterable<string>;
  actorId: string | null;
  type: NotificationType;
  studioId: string;
  projectId?: string | null;
  cardId?: string | null;
  commentId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Creates in-app notifications (inside the caller's transaction) for recipients who
 * are still studio members and haven't opted out. Returns who was notified.
 */
export async function notify(ex: Executor, input: NotifyInput): Promise<string[]> {
  const candidates = [...new Set(input.recipientIds)].filter((id) => id && id !== input.actorId);
  if (candidates.length === 0) return [];

  const [members, optOuts] = await Promise.all([
    ex
      .select({ userId: studioMembers.userId })
      .from(studioMembers)
      .where(and(eq(studioMembers.studioId, input.studioId), inArray(studioMembers.userId, candidates))),
    ex
      .select({ userId: notificationPreferences.userId })
      .from(notificationPreferences)
      .where(
        and(
          inArray(notificationPreferences.userId, candidates),
          eq(notificationPreferences.type, input.type),
          eq(notificationPreferences.channel, "IN_APP"),
          eq(notificationPreferences.enabled, false),
        ),
      ),
  ]);
  const memberSet = new Set(members.map((m) => m.userId));
  const optOutSet = new Set(optOuts.map((o) => o.userId));
  const recipients = candidates.filter((id) => memberSet.has(id) && !optOutSet.has(id));
  if (recipients.length === 0) return [];

  const createdAt = now();
  const inserted = await ex
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        userId,
        studioId: input.studioId,
        projectId: input.projectId ?? null,
        cardId: input.cardId ?? null,
        commentId: input.commentId ?? null,
        actorId: input.actorId,
        type: input.type,
        data: input.data ?? {},
        createdAt,
      })),
    )
    .returning();

  if (channels.length) {
    // External channels run outside the request path and never block the write.
    queueMicrotask(() => {
      for (const channel of channels) {
        channel.deliver(inserted).catch((error) => console.error(`[forge] ${channel.id} delivery failed`, error));
      }
    });
  }
  return recipients;
}

function notificationHref(row: {
  studioSlug: string;
  projectSlug: string | null;
  cardKey: string | null;
  commentId: string | null;
}): string {
  if (row.projectSlug && row.cardKey) {
    const params = new URLSearchParams({ card: row.cardKey });
    if (row.commentId) params.set("comment", row.commentId);
    return `/${row.studioSlug}/${row.projectSlug}?${params.toString()}`;
  }
  if (row.projectSlug) return `/${row.studioSlug}/${row.projectSlug}`;
  return `/${row.studioSlug}`;
}

export async function listNotifications(
  actor: Actor,
  options: { unreadOnly?: boolean; before?: string; limit?: number } = {},
): Promise<{ items: NotificationDTO[]; unreadCount: number }> {
  const conditions = [eq(notifications.userId, actor.userId)];
  if (options.unreadOnly) conditions.push(isNull(notifications.readAt));
  if (options.before) conditions.push(lt(notifications.createdAt, new Date(options.before)));

  const rows = await db
    .select({
      n: notifications,
      studioSlug: studios.slug,
      studioName: studios.name,
      projectSlug: projects.slug,
      projectName: projects.name,
      projectIcon: projects.icon,
      projectKey: projects.key,
      cardNumber: cards.number,
      cardTitle: cards.title,
    })
    .from(notifications)
    .innerJoin(studios, eq(studios.id, notifications.studioId))
    // Only show notifications from studios the user still belongs to.
    .innerJoin(
      studioMembers,
      and(eq(studioMembers.studioId, notifications.studioId), eq(studioMembers.userId, actor.userId)),
    )
    .leftJoin(projects, eq(projects.id, notifications.projectId))
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(options.limit ?? 30, 100));

  const actors = await loadUsers(rows.map((r) => r.n.actorId).filter((id): id is string => Boolean(id)));
  const items = await Promise.all(
    rows.map(async (r) => {
      const cardKey = r.projectKey && r.cardNumber != null ? `${r.projectKey}-${r.cardNumber}` : null;
      const actorRow = r.n.actorId ? actors.get(r.n.actorId) : undefined;
      return {
        id: r.n.id,
        type: r.n.type,
        actor: actorRow ? await toUserDTO(actorRow) : null,
        studio: { id: r.n.studioId, slug: r.studioSlug, name: r.studioName },
        project:
          r.n.projectId && r.projectSlug
            ? { id: r.n.projectId, slug: r.projectSlug, name: r.projectName ?? "", icon: r.projectIcon ?? "🎮" }
            : null,
        card: r.n.cardId && cardKey ? { id: r.n.cardId, key: cardKey, title: r.cardTitle ?? "" } : null,
        commentId: r.n.commentId,
        data: r.n.data,
        readAt: r.n.readAt?.toISOString() ?? null,
        createdAt: r.n.createdAt.toISOString(),
        href: notificationHref({
          studioSlug: r.studioSlug,
          projectSlug: r.projectSlug,
          cardKey,
          commentId: r.n.commentId,
        }),
      } satisfies NotificationDTO;
    }),
  );
  return { items, unreadCount: await unreadCount(actor.userId) };
}

export async function unreadCount(userId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(notifications)
    .innerJoin(studioMembers, and(eq(studioMembers.studioId, notifications.studioId), eq(studioMembers.userId, userId)))
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows[0]?.value ?? 0;
}

export async function markNotificationsRead(actor: Actor, input: { ids?: string[]; all?: boolean; read?: boolean }) {
  const read = input.read ?? true;
  const where = input.all
    ? eq(notifications.userId, actor.userId)
    : and(eq(notifications.userId, actor.userId), inArray(notifications.id, input.ids ?? []));
  if (!input.all && !input.ids?.length) return { updated: 0 };
  const updated = await db
    .update(notifications)
    .set({ readAt: read ? now() : null })
    .where(where)
    .returning({ id: notifications.id });
  new Effects().notify([actor.userId]).flush(actor.clientId);
  return { updated: updated.length };
}

export async function getNotificationPreferences(actor: Actor) {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, actor.userId));
  const disabled = new Set(rows.filter((r) => !r.enabled).map((r) => `${r.type}:${r.channel}`));
  return NOTIFICATION_TYPES.map((type) => ({ type, inApp: !disabled.has(`${type}:IN_APP`) }));
}

export async function setNotificationPreference(actor: Actor, input: { type: NotificationType; inApp: boolean }) {
  await db
    .insert(notificationPreferences)
    .values({ userId: actor.userId, type: input.type, channel: "IN_APP", enabled: input.inApp })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.type, notificationPreferences.channel],
      set: { enabled: input.inApp },
    });
  return getNotificationPreferences(actor);
}
