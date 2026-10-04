import { and, count, desc, eq, gt, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { isDiscordDmType } from "@/lib/discord";
import { channelDefault, NOTIFICATION_TYPES, notificationText, type NotificationChannelId, type NotificationType } from "@/lib/notifications";
import type { NotificationDTO } from "@/lib/types";
import { accessibleProjectIds } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import {
  assetVersions,
  boardColumns,
  boards,
  cards,
  deliverables,
  discordDmDeliveries,
  discordDmRecipients,
  notificationPreferences,
  notifications,
  oauthAccounts,
  projects,
  pushDeliveries,
  pushSubscriptions,
  sessions,
  studioMembers,
  studios,
  users,
} from "../db/schema";
import { appOrigin } from "../env";
import { invalid } from "../errors";
import type { Actor } from "./context";
import { discordDmsConfigured } from "./discord-config";
import { Effects } from "./effects";
import { emailDeliveryConfigured, sendEmail } from "./email";
import { filterProjectMembers } from "./members-query";
import { pushConfigured } from "./push-config";
import { loadUsers, toUserDTO } from "./users-lookup";

export type NotificationRecord = typeof notifications.$inferSelect;

export interface NotifyInput {
  recipientIds: Iterable<string>;
  actorId: string | null;
  type: NotificationType;
  studioId: string;
  projectId?: string | null;
  cardId?: string | null;
  deliverableId?: string | null;
  versionId?: string | null;
  commentId?: string | null;
  data?: Record<string, unknown>;
  /** Reach each person at most once with this key (reminders); repeats are ignored on every channel. */
  dedupeKey?: string;
}

/** Where a notification opens: the board the card is on, and within the card the deliverable, revision or comment. */
export function notificationPath(row: {
  studioSlug: string;
  projectSlug: string | null;
  boardNumber?: number | null;
  cardKey: string | null;
  deliverableNumber?: number | null;
  versionNumber?: number | null;
  commentId?: string | null;
}): string {
  const project = row.projectSlug ? `/${row.studioSlug}/${row.projectSlug}${row.boardNumber ? `/b/${row.boardNumber}` : ""}` : null;
  if (project && row.cardKey) {
    const params = new URLSearchParams({ card: row.cardKey });
    if (row.deliverableNumber) params.set("d", String(row.deliverableNumber));
    if (row.versionNumber) params.set("v", String(row.versionNumber));
    if (row.commentId) params.set("comment", row.commentId);
    return `${project}?${params.toString()}`;
  }
  if (project) return project;
  return `/${row.studioSlug}`;
}

// ── Archived work ───────────────────────────────────────────────────────────

/**
 * The notification's work is live: not in an archived project, and — when it's about a card or a
 * deliverable — not on an archived card, column or board, or an archived deliverable. Needs the
 * joins added by `withWork`. Archiving one deliverable hides only notifications about it; the
 * card's other notifications stay.
 */
export const workIsLive: SQL = and(
  or(isNull(notifications.projectId), isNull(projects.archivedAt)),
  or(isNull(notifications.cardId), and(isNull(cards.archivedAt), isNull(boardColumns.archivedAt), isNull(boards.archivedAt))),
  or(isNull(notifications.deliverableId), isNull(deliverables.archivedAt)),
)!;

/**
 * Adds the joins `workIsLive` reads (and the board, for links). Drizzle's builder changes type with
 * every join, so this is typed loosely and callers type the rows they select.
 */
function withWork(query: any): any {
  return query
    .leftJoin(projects, eq(projects.id, notifications.projectId))
    .leftJoin(cards, eq(cards.id, notifications.cardId))
    .leftJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .leftJoin(boards, eq(boards.id, cards.boardId))
    .leftJoin(deliverables, eq(deliverables.id, notifications.deliverableId));
}

/** Whether the work a new notification would be about is archived (then it isn't created at all). */
async function workArchived(ex: Executor, input: NotifyInput): Promise<boolean> {
  if (input.projectId) {
    const [p] = await ex.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, input.projectId));
    if (!p || p.archivedAt) return true;
  }
  if (input.cardId) {
    const [c] = await ex
      .select({ card: cards.archivedAt, column: boardColumns.archivedAt, board: boards.archivedAt })
      .from(cards)
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .where(eq(cards.id, input.cardId));
    if (!c || c.card || c.column || c.board) return true;
  }
  if (input.deliverableId) {
    const [d] = await ex.select({ archivedAt: deliverables.archivedAt }).from(deliverables).where(eq(deliverables.id, input.deliverableId));
    if (!d || d.archivedAt) return true;
  }
  return false;
}

/**
 * People with notifications about some work — told to refresh their inbox and badge when that work
 * is archived or restored (the notifications disappear or come back with their read state).
 */
export async function inboxAudience(ex: Executor, about: { cardId?: string; deliverableId?: string; projectId?: string }): Promise<string[]> {
  const where = about.deliverableId
    ? eq(notifications.deliverableId, about.deliverableId)
    : about.cardId
      ? eq(notifications.cardId, about.cardId)
      : about.projectId
        ? eq(notifications.projectId, about.projectId)
        : undefined;
  if (!where) return [];
  const rows = await ex.selectDistinct({ userId: notifications.userId }).from(notifications).where(where);
  return rows.map((r) => r.userId);
}

// ── Preferences ─────────────────────────────────────────────────────────────

type ChannelChoices = Partial<Record<NotificationChannelId, boolean>>;

async function choicesFor(ex: Executor, userIds: string[], type: NotificationType): Promise<Map<string, ChannelChoices>> {
  const out = new Map<string, ChannelChoices>();
  if (!userIds.length) return out;
  const rows = await ex
    .select({ userId: notificationPreferences.userId, channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(inArray(notificationPreferences.userId, userIds), eq(notificationPreferences.type, type)));
  for (const r of rows) {
    if (r.channel === "DISCORD") continue;
    out.set(r.userId, { ...out.get(r.userId), [r.channel]: r.enabled });
  }
  return out;
}

/** Whether `channel` is on for this person and type (their choice, or the channel's default). */
export async function channelEnabled(ex: Executor, userId: string, type: NotificationType, channel: NotificationChannelId): Promise<boolean> {
  const choice = (await choicesFor(ex, [userId], type)).get(userId)?.[channel];
  return choice ?? channelDefault(type, channel);
}

/** Devices that can receive pushes right now: subscribed in a sign-in session that hasn't ended. */
async function liveSubscriptions(ex: Executor, userIds: string[]) {
  if (!userIds.length) return [];
  return ex
    .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
    .where(and(inArray(pushSubscriptions.userId, userIds), gt(sessions.expiresAt, now())));
}

/**
 * People who get Discord direct messages: they connected a Discord account and messaging them
 * isn't paused (a pause belongs to the account it happened with; a newly connected one starts fresh).
 */
async function discordDmUsers(ex: Executor, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length || !discordDmsConfigured()) return new Set();
  const rows = await ex
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .leftJoin(discordDmRecipients, and(eq(discordDmRecipients.userId, oauthAccounts.userId), eq(discordDmRecipients.discordUserId, oauthAccounts.providerAccountId)))
    .where(and(eq(oauthAccounts.provider, "discord"), inArray(oauthAccounts.userId, userIds), isNull(discordDmRecipients.pausedAt)));
  return new Set(rows.map((r) => r.userId));
}

// ── Creating notifications ──────────────────────────────────────────────────

/** Queues notification emails in the caller's transaction: they're sent only if it commits. */
async function queueEmails(ex: Executor, input: NotifyInput, recipients: Array<{ userId: string; notificationId: string }>) {
  if (!recipients.length) return;
  const [studio] = await ex.select({ slug: studios.slug }).from(studios).where(eq(studios.id, input.studioId));
  const [project] = input.projectId ? await ex.select({ slug: projects.slug }).from(projects).where(eq(projects.id, input.projectId)) : [];
  const [card] = input.cardId ? await ex.select({ boardNumber: boards.number }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId)).where(eq(cards.id, input.cardId)) : [];
  const [deliverable] = input.deliverableId ? await ex.select({ number: deliverables.number }).from(deliverables).where(eq(deliverables.id, input.deliverableId)) : [];
  const [version] = input.versionId ? await ex.select({ number: assetVersions.versionNumber }).from(assetVersions).where(eq(assetVersions.id, input.versionId)) : [];
  const to = recipients.map((r) => r.userId);
  const people = await ex.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, [...to, ...(input.actorId ? [input.actorId] : [])]));
  const actorName = people.find((p) => p.id === input.actorId)?.displayName ?? null;
  const data = input.data ?? {};
  const text = notificationText(input.type, data, actorName);
  const url = `${appOrigin()}${notificationPath({
    studioSlug: studio?.slug ?? "",
    projectSlug: project?.slug ?? null,
    boardNumber: card?.boardNumber,
    cardKey: typeof data.cardKey === "string" ? data.cardKey : null,
    deliverableNumber: deliverable?.number,
    versionNumber: version?.number,
    commentId: input.commentId,
  })}`;
  for (const r of recipients) {
    const person = people.find((p) => p.id === r.userId);
    if (!person) continue;
    await sendEmail(
      ex,
      {
        to: person.email,
        template: "notification",
        subject: text.length > 110 ? `${text.slice(0, 107)}…` : text,
        lines: [text, ...(typeof data.excerpt === "string" && data.excerpt ? [`“${data.excerpt}”`] : []), "You can choose which emails you get in Forge's notification settings."],
        action: { label: "Open in Forge", url },
      },
      { userId: person.id, projectId: input.projectId ?? null, notificationId: r.notificationId },
    );
  }
}

/**
 * Notifies people (inside the caller's transaction) who can still see the work — studio members
 * who can open the project — about live (not archived) work. The actor is never notified of their
 * own action. Each person's channels are decided independently from their choices for this type:
 *  - in-app: an inbox entry counting towards the unread badge;
 *  - device: a queued push to each of their subscribed devices (even with in-app off);
 *  - email: a queued email, when the server can send email;
 *  - Discord: a queued direct message, for the types in DISCORD_DM_TYPES, to people who connected
 *    their Discord account (not a per-type choice).
 * One record per person backs all channels, so dedupe keys hold across them. Deliveries are queued
 * in the transaction and sent only after it commits. Returns who was notified on any channel.
 */
export async function notify(ex: Executor, input: NotifyInput): Promise<string[]> {
  let candidates = [...new Set(input.recipientIds)].filter((id) => id && id !== input.actorId);
  if (candidates.length === 0) return [];

  if (input.projectId) {
    const [project] = await ex.select().from(projects).where(eq(projects.id, input.projectId));
    if (!project) return [];
    candidates = await filterProjectMembers(project, candidates, ex);
  } else {
    const members = await ex
      .select({ userId: studioMembers.userId })
      .from(studioMembers)
      .where(and(eq(studioMembers.studioId, input.studioId), inArray(studioMembers.userId, candidates)));
    const memberSet = new Set(members.map((m) => m.userId));
    candidates = candidates.filter((id) => memberSet.has(id));
  }
  if (candidates.length === 0) return [];
  if (await workArchived(ex, input)) return [];

  const choices = await choicesFor(ex, candidates, input.type);
  const on = (userId: string, channel: NotificationChannelId) => choices.get(userId)?.[channel] ?? channelDefault(input.type, channel);
  const devices = pushConfigured() ? await liveSubscriptions(ex, candidates) : [];
  const emailOn = emailDeliveryConfigured();
  const dms = isDiscordDmType(input.type) ? await discordDmUsers(ex, candidates) : new Set<string>();
  const plan = candidates
    .map((userId) => ({
      userId,
      inbox: on(userId, "IN_APP"),
      devices: on(userId, "PUSH") ? devices.filter((d) => d.userId === userId).map((d) => d.id) : [],
      email: emailOn && on(userId, "EMAIL"),
      discord: dms.has(userId),
    }))
    .filter((p) => p.inbox || p.devices.length || p.email || p.discord);
  if (plan.length === 0) return [];

  const createdAt = now();
  const inserted = await ex
    .insert(notifications)
    .values(
      plan.map((p) => ({
        userId: p.userId,
        studioId: input.studioId,
        projectId: input.projectId ?? null,
        cardId: input.cardId ?? null,
        deliverableId: input.deliverableId ?? null,
        versionId: input.versionId ?? null,
        commentId: input.commentId ?? null,
        actorId: input.actorId,
        type: input.type,
        data: input.data ?? {},
        dedupeKey: input.dedupeKey ?? null,
        inbox: p.inbox,
        createdAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: notifications.id, userId: notifications.userId });

  const byUser = new Map(plan.map((p) => [p.userId, p]));
  const pushRows = inserted.flatMap((n) => (byUser.get(n.userId)?.devices ?? []).map((subscriptionId) => ({ notificationId: n.id, subscriptionId, userId: n.userId })));
  if (pushRows.length) await ex.insert(pushDeliveries).values(pushRows).onConflictDoNothing();
  const dmRows = inserted.filter((n) => byUser.get(n.userId)?.discord).map((n) => ({ userId: n.userId, notificationId: n.id, dedupeKey: `notification:${n.id}` }));
  if (dmRows.length) await ex.insert(discordDmDeliveries).values(dmRows).onConflictDoNothing();
  await queueEmails(
    ex,
    input,
    inserted.filter((n) => byUser.get(n.userId)?.email).map((n) => ({ userId: n.userId, notificationId: n.id })),
  );
  return inserted.map((n) => n.userId);
}

/**
 * The notifications one event produces, most specific first. Each person gets at most one of
 * them — e.g. the reviewer of a submission gets the review request, not also the watcher update.
 * `separate` entries are about other work (a dependant that became ready) and reach their people
 * even if the event already notified them, while still sparing them the generic updates after.
 */
export class NotificationBatch {
  private entries: Array<{ input: NotifyInput; separate: boolean }> = [];

  add(input: NotifyInput, options: { separate?: boolean } = {}) {
    this.entries.push({ input, separate: Boolean(options.separate) });
    return this;
  }

  async send(ex: Executor): Promise<string[]> {
    const claimed = new Set<string>();
    const notified: string[] = [];
    for (const { input, separate } of this.entries) {
      const ids = [...new Set(input.recipientIds)].filter((id) => separate || !claimed.has(id));
      for (const id of ids) claimed.add(id);
      notified.push(...(await notify(ex, { ...input, recipientIds: ids })));
    }
    return [...new Set(notified)];
  }
}

// ── The inbox ───────────────────────────────────────────────────────────────

/** Notifications about projects the user can no longer open (removed, made private) stay hidden. */
async function openProjectsOnly(userId: string) {
  const ids = [...(await accessibleProjectIds(userId))];
  return ids.length ? or(isNull(notifications.projectId), inArray(notifications.projectId, ids)) : isNull(notifications.projectId);
}

/**
 * What the inbox shows (list, unread count, "mark all read"): in-app notifications of studios the
 * person still belongs to, in projects they can still open, about work that isn't archived.
 */
async function inboxConditions(userId: string) {
  return and(eq(notifications.userId, userId), eq(notifications.inbox, true), await openProjectsOnly(userId), workIsLive);
}

/** Cursor: "<createdAt ISO>|<id>" — stable even for several notifications created at once. */
function parseCursor(before: string | undefined) {
  if (!before) return null;
  const [at, id] = before.split("|");
  const date = new Date(at ?? "");
  if (Number.isNaN(date.getTime())) throw invalid("Invalid cursor.");
  return { date, id: id ?? null };
}

export async function listNotifications(
  actor: Actor,
  options: { unreadOnly?: boolean; before?: string; limit?: number } = {},
): Promise<{ items: NotificationDTO[]; unreadCount: number; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 30, 100);
  const conditions = [await inboxConditions(actor.userId)];
  if (options.unreadOnly) conditions.push(isNull(notifications.readAt));
  const cursor = parseCursor(options.before);
  if (cursor) {
    conditions.push(
      cursor.id
        ? or(lt(notifications.createdAt, cursor.date), and(eq(notifications.createdAt, cursor.date), lt(notifications.id, cursor.id)))!
        : lt(notifications.createdAt, cursor.date),
    );
  }

  const rows = await withWork(
    db
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
        boardNumber: boards.number,
        boardName: boards.name,
        deliverableNumber: deliverables.number,
        deliverableName: deliverables.name,
        versionNumber: assetVersions.versionNumber,
      })
      .from(notifications)
      .innerJoin(studios, eq(studios.id, notifications.studioId))
      // Only show notifications from studios the user still belongs to.
      .innerJoin(studioMembers, and(eq(studioMembers.studioId, notifications.studioId), eq(studioMembers.userId, actor.userId))),
  )
    .leftJoin(assetVersions, eq(assetVersions.id, notifications.versionId))
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);

  type Row = {
    n: NotificationRecord;
    studioSlug: string;
    studioName: string;
    projectSlug: string | null;
    projectName: string | null;
    projectIcon: string | null;
    projectKey: string | null;
    cardNumber: number | null;
    cardTitle: string | null;
    boardNumber: number | null;
    boardName: string | null;
    deliverableNumber: number | null;
    deliverableName: string | null;
    versionNumber: number | null;
  };
  const page = (rows as Row[]).slice(0, limit);
  const actors = await loadUsers(page.map((r) => r.n.actorId).filter((id): id is string => Boolean(id)));
  const items = await Promise.all(
    page.map(async (r) => {
      const cardKey = r.projectKey && r.cardNumber != null ? `${r.projectKey}-${r.cardNumber}` : null;
      const actorRow = r.n.actorId ? actors.get(r.n.actorId) : undefined;
      return {
        id: r.n.id,
        type: r.n.type as NotificationType,
        actor: actorRow ? await toUserDTO(actorRow) : null,
        studio: { id: r.n.studioId, slug: r.studioSlug, name: r.studioName },
        project:
          r.n.projectId && r.projectSlug
            ? { id: r.n.projectId, slug: r.projectSlug, name: r.projectName ?? "", icon: r.projectIcon ?? "🎮" }
            : null,
        board: r.n.cardId && r.boardNumber != null ? { number: r.boardNumber, name: r.boardName ?? "" } : null,
        card: r.n.cardId && cardKey ? { id: r.n.cardId, key: cardKey, title: r.cardTitle ?? "" } : null,
        deliverable: r.n.deliverableId && r.deliverableNumber != null ? { id: r.n.deliverableId, number: r.deliverableNumber, name: r.deliverableName ?? "" } : null,
        versionNumber: r.versionNumber ?? null,
        commentId: r.n.commentId,
        data: r.n.data,
        readAt: r.n.readAt?.toISOString() ?? null,
        createdAt: r.n.createdAt.toISOString(),
        href: notificationPath({
          studioSlug: r.studioSlug,
          projectSlug: r.projectSlug,
          boardNumber: r.boardNumber,
          cardKey,
          deliverableNumber: r.deliverableNumber,
          versionNumber: r.versionNumber,
          commentId: r.n.commentId,
        }),
      } satisfies NotificationDTO;
    }),
  );
  const last = page.at(-1);
  return {
    items,
    unreadCount: await unreadCount(actor.userId),
    nextCursor: rows.length > limit && last ? `${last.n.createdAt.toISOString()}|${last.n.id}` : null,
  };
}

export async function unreadCount(userId: string): Promise<number> {
  const rows = await withWork(
    db
      .select({ value: count() })
      .from(notifications)
      .innerJoin(studioMembers, and(eq(studioMembers.studioId, notifications.studioId), eq(studioMembers.userId, userId))),
  ).where(and(await inboxConditions(userId), isNull(notifications.readAt)));
  return (rows as Array<{ value: number }>)[0]?.value ?? 0;
}

/**
 * Marks notifications read or unread. "All" covers only what the inbox shows: notifications hidden
 * with archived work keep their state, so restoring the work brings them back exactly as they were.
 */
export async function markNotificationsRead(actor: Actor, input: { ids?: string[]; all?: boolean; read?: boolean }) {
  const read = input.read ?? true;
  if (!input.all && !input.ids?.length) return { updated: 0 };
  let ids = input.ids ?? [];
  if (input.all) {
    const visible = await withWork(db.select({ id: notifications.id }).from(notifications)).where(
      and(await inboxConditions(actor.userId), read ? isNull(notifications.readAt) : undefined),
    );
    ids = (visible as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) return { updated: 0 };
  }
  const updated = await db
    .update(notifications)
    .set({ readAt: read ? now() : null })
    .where(and(eq(notifications.userId, actor.userId), inArray(notifications.id, ids)))
    .returning({ id: notifications.id });
  new Effects().notify([actor.userId]).flush(actor.clientId);
  return { updated: updated.length };
}

// ── Delivery checks (device and email workers) ──────────────────────────────

/**
 * Whether a queued delivery of this notification is still appropriate: the notification exists,
 * its work isn't archived, and the recipient is still in the studio and can still open the project.
 */
export async function notificationStillDeliverable(ex: Executor, notificationId: string): Promise<NotificationRecord | null> {
  const rows = await withWork(
    ex
      .select({ n: notifications })
      .from(notifications)
      .innerJoin(studioMembers, and(eq(studioMembers.studioId, notifications.studioId), eq(studioMembers.userId, notifications.userId))),
  ).where(and(eq(notifications.id, notificationId), workIsLive));
  const n = (rows as Array<{ n: NotificationRecord }>)[0]?.n;
  if (!n) return null;
  if (n.projectId && !(await accessibleProjectIds(n.userId, n.studioId, ex)).has(n.projectId)) return null;
  return n;
}

/** Link data for a notification (device notifications build their deep link from it at send time). */
export async function notificationLink(ex: Executor, n: NotificationRecord): Promise<{ path: string; projectName: string | null; cardKey: string | null }> {
  const rows = await withWork(
    ex
      .select({
        studioSlug: studios.slug,
        projectSlug: projects.slug,
        projectName: projects.name,
        projectKey: projects.key,
        cardNumber: cards.number,
        boardNumber: boards.number,
        deliverableNumber: deliverables.number,
      })
      .from(notifications)
      .innerJoin(studios, eq(studios.id, notifications.studioId)),
  )
    .where(eq(notifications.id, n.id))
    .limit(1);
  const r = (rows as Array<{ studioSlug: string; projectSlug: string | null; projectName: string | null; projectKey: string | null; cardNumber: number | null; boardNumber: number | null; deliverableNumber: number | null }>)[0];
  const [version] = n.versionId ? await ex.select({ number: assetVersions.versionNumber }).from(assetVersions).where(eq(assetVersions.id, n.versionId)) : [];
  const cardKey = r?.projectKey && r.cardNumber != null ? `${r.projectKey}-${r.cardNumber}` : null;
  return {
    path: r
      ? notificationPath({ studioSlug: r.studioSlug, projectSlug: r.projectSlug, boardNumber: r.boardNumber, cardKey, deliverableNumber: r.deliverableNumber, versionNumber: version?.number, commentId: n.commentId })
      : "/",
    projectName: r?.projectName ?? null,
    cardKey,
  };
}

// ── Preferences ─────────────────────────────────────────────────────────────

export async function getNotificationPreferences(actor: Actor) {
  const rows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, actor.userId));
  const chosen = new Map(rows.map((r) => [`${r.type}:${r.channel}`, r.enabled]));
  const value = (type: NotificationType, channel: NotificationChannelId) => chosen.get(`${type}:${channel}`) ?? channelDefault(type, channel);
  return {
    /** Email is offered only when the server can actually send it. */
    emailAvailable: emailDeliveryConfigured(),
    /** Device notifications need the server's push keys (VAPID). */
    pushAvailable: pushConfigured(),
    types: NOTIFICATION_TYPES.map((type) => ({ type, inApp: value(type, "IN_APP"), push: value(type, "PUSH"), email: value(type, "EMAIL") })),
  };
}

/**
 * Sets one type's channels. Each channel is stored separately, so changing one never touches the
 * others — and never asks the browser for anything (device permission is a separate, explicit step).
 */
export async function setNotificationPreference(actor: Actor, input: { type: NotificationType; inApp?: boolean; push?: boolean; email?: boolean }) {
  const set = async (channel: NotificationChannelId, enabled: boolean) =>
    db
      .insert(notificationPreferences)
      .values({ userId: actor.userId, type: input.type, channel, enabled })
      .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.type, notificationPreferences.channel], set: { enabled } });
  if (input.inApp !== undefined) await set("IN_APP", input.inApp);
  if (input.push !== undefined) {
    if (input.push && !pushConfigured()) throw invalid("Device notifications aren't set up on this server.");
    await set("PUSH", input.push);
  }
  if (input.email !== undefined) {
    if (input.email && !emailDeliveryConfigured()) throw invalid("Email delivery isn't set up on this server.");
    await set("EMAIL", input.email);
  }
  return getNotificationPreferences(actor);
}
