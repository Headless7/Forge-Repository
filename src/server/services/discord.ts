import "server-only";
import crypto from "node:crypto";
import { and, arrayContains, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { DISCORD_DIGEST_HOUR_UTC, DISCORD_EVENT_META, DISCORD_EVENTS, isDiscordEvent, type DiscordEventType } from "@/lib/discord";
import { roleHas } from "@/lib/permissions";
import { requireProject, requireStudio } from "../access";
import { hmac, safeEqual } from "../auth/crypto";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { boardColumns, boards, cardAssignees, cardReviewers, cards, deliverables, discordConnections, discordDeliveries, discordRoutes, projects, studios, users } from "../db/schema";
import { appOrigin, env } from "../env";
import { conflict, invalid, notFound } from "../errors";
import { audit } from "./activity";
import type { Actor } from "./context";
import { buildDiscordMessage, DISCORD_COLORS, discordTime, escapeMarkdown, eventSummary, feedButton, feedLabel, nameList, type DiscordMessage } from "./discord-message";

// ── Configuration ───────────────────────────────────────────────────────────────────────────

/** All four values are needed to connect servers and post (the client id/secret alone only enable sign-in). */
export function discordConfigured() {
  return Boolean(env.DISCORD_APPLICATION_ID && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_BOT_TOKEN);
}

/** What the bot may do in a server: view channels, send messages, embed links. Nothing else. */
export const DISCORD_BOT_PERMISSIONS = String((1n << 10n) | (1n << 11n) | (1n << 14n));

export function discordRedirectUri() {
  return `${appOrigin()}/api/integrations/discord/callback`;
}

// ── Discord API ─────────────────────────────────────────────────────────────────────────────

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Discord's JSON error code (10003 Unknown Channel, 50001 Missing Access, 50013 Missing Permissions…). */
  code: number | null;
  message: string;
  retryAfterMs: number | null;
}

export async function discordApi<T>(path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; basicAuth?: boolean } = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { "User-Agent": "DiscordBot (https://forge.local, 1)" };
  let body: string | undefined;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  headers.Authorization = init.basicAuth
    ? `Basic ${Buffer.from(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`).toString("base64")}`
    : `Bot ${env.DISCORD_BOT_TOKEN}`;
  try {
    const res = await fetch(`${env.DISCORD_API_BASE}${path}`, { method: init.method ?? "GET", headers, body, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as (T & { code?: number; message?: string; retry_after?: number }) | null;
    const retryAfter = res.status === 429 ? Number(json?.retry_after ?? res.headers.get("retry-after") ?? 5) : null;
    return {
      ok: res.ok,
      status: res.status,
      data: res.ok ? json : null,
      code: !res.ok && typeof json?.code === "number" ? json.code : null,
      message: !res.ok ? (json?.message ?? `HTTP ${res.status}`) : "",
      retryAfterMs: retryAfter !== null && Number.isFinite(retryAfter) ? Math.ceil(retryAfter * 1000) : null,
    };
  } catch (error) {
    return { ok: false, status: 0, data: null, code: null, message: error instanceof Error ? error.message : String(error), retryAfterMs: null };
  }
}

// ── Connecting a server ─────────────────────────────────────────────────────────────────────

interface ConnectState {
  studioId: string;
  userId: string;
  nonce: string;
  exp: number;
}

export const DISCORD_STATE_COOKIE = "forge_discord";

function encodeConnectState(value: ConnectState) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${hmac(`discord-connect:${payload}`)}`;
}

function decodeConnectState(cookie: string | null | undefined): ConnectState | null {
  if (!cookie) return null;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig || !safeEqual(hmac(`discord-connect:${payload}`), sig)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as ConnectState;
  } catch {
    return null;
  }
}

/** Starts "Add to server" for a studio (Admins and the Owner). Returns Discord's URL and a signed state cookie. */
export async function beginDiscordConnect(userId: string, studioId: string) {
  if (!discordConfigured()) throw invalid("Discord isn't set up on this Forge site.");
  const access = await requireStudio(userId, studioId, "studio.update");
  const nonce = crypto.randomBytes(18).toString("base64url");
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID!,
    // The bot (feeds and direct messages) and its slash commands; nothing else.
    scope: "bot applications.commands",
    permissions: DISCORD_BOT_PERMISSIONS,
    response_type: "code",
    redirect_uri: discordRedirectUri(),
    integration_type: "0",
    state: nonce,
  });
  return {
    url: `https://discord.com/oauth2/authorize?${params}`,
    cookie: encodeConnectState({ studioId: access.studioId, userId, nonce, exp: Date.now() + 10 * 60_000 }),
    studioSlug: access.studioSlug,
  };
}

/**
 * Finishes "Add to server": the state must match the signed cookie and the person who started it,
 * who must still be an Admin or the Owner. The server comes from Discord's token response, not the
 * (forgeable) query string.
 */
export async function completeDiscordConnect(input: { userId: string | null; cookie: string | null | undefined; state: string | null; code: string | null }, meta: Omit<Actor, "userId"> = {}) {
  const state = decodeConnectState(input.cookie);
  if (!state || !input.state || !safeEqual(state.nonce, input.state) || state.exp < Date.now()) throw invalid("Connecting Discord expired or was tampered with. Please try again.");
  if (!input.userId || input.userId !== state.userId) throw invalid("Sign in as the person who started connecting Discord, then try again.");
  if (!input.code) throw invalid("Discord didn't confirm the connection. Please try again.");
  const access = await requireStudio(input.userId, state.studioId, "studio.update");
  const token = await discordApi<{ guild?: { id: string; name: string; icon: string | null } }>("/oauth2/token", {
    method: "POST",
    basicAuth: true,
    form: { grant_type: "authorization_code", code: input.code, redirect_uri: discordRedirectUri() },
  });
  const guild = token.data?.guild;
  if (!token.ok || !guild) throw invalid(`Discord didn't confirm which server Forge was added to${token.message ? ` (${token.message})` : ""}. Please try again.`);
  await db.transaction(async (tx) => {
    const [previous] = await tx.select().from(discordConnections).where(eq(discordConnections.studioId, access.studioId));
    // Feeds point at channels of the old server: they can't carry over.
    if (previous && previous.guildId !== guild.id) await tx.delete(discordRoutes).where(eq(discordRoutes.studioId, access.studioId));
    await tx
      .insert(discordConnections)
      .values({ studioId: access.studioId, guildId: guild.id, guildName: guild.name, guildIcon: guild.icon, connectedById: input.userId, connectedAt: now() })
      .onConflictDoUpdate({
        target: discordConnections.studioId,
        set: { guildId: guild.id, guildName: guild.name, guildIcon: guild.icon, connectedById: input.userId, connectedAt: now(), lostAt: null },
      });
    await audit(tx, { userId: input.userId!, ...meta }, { studioId: access.studioId, action: "discord.connected", targetType: "studio", targetId: access.studioId, data: { guildId: guild.id, guildName: guild.name } });
  });
  return { studioSlug: access.studioSlug, guildName: guild.name };
}

/** Where to send someone back after "Add to server" (from the signed state), even when it failed. */
export async function studioSlugForConnectState(cookie: string | null | undefined): Promise<string | null> {
  const state = decodeConnectState(cookie);
  if (!state) return null;
  const [row] = await db.select({ slug: studios.slug }).from(studios).where(eq(studios.id, state.studioId));
  return row?.slug ?? null;
}

/** Removes the connection and every feed; the bot leaves the server unless another studio still uses it. */
export async function disconnectDiscord(actor: Actor, studioId: string) {
  const access = await requireStudio(actor.userId, studioId, "studio.update");
  const [connection] = await db.select().from(discordConnections).where(eq(discordConnections.studioId, access.studioId));
  if (!connection) return { ok: true as const };
  await db.transaction(async (tx) => {
    await tx.delete(discordRoutes).where(eq(discordRoutes.studioId, access.studioId));
    await tx.delete(discordConnections).where(eq(discordConnections.studioId, access.studioId));
    await audit(tx, actor, { studioId: access.studioId, action: "discord.disconnected", targetType: "studio", targetId: access.studioId, data: { guildId: connection.guildId, guildName: connection.guildName } });
  });
  const [stillUsed] = await db.select({ studioId: discordConnections.studioId }).from(discordConnections).where(eq(discordConnections.guildId, connection.guildId)).limit(1);
  if (!stillUsed && discordConfigured()) await discordApi(`/users/@me/guilds/${connection.guildId}`, { method: "DELETE" });
  return { ok: true as const };
}

export interface DiscordStatusDTO {
  configured: boolean;
  canConnect: boolean;
  connection: { guildName: string; connectedAt: string; connectedBy: string | null; lost: boolean } | null;
}

export async function discordStatus(actor: Actor, studioId: string): Promise<DiscordStatusDTO> {
  const access = await requireStudio(actor.userId, studioId);
  const [row] = await db
    .select({ c: discordConnections, by: users.displayName })
    .from(discordConnections)
    .leftJoin(users, eq(users.id, discordConnections.connectedById))
    .where(eq(discordConnections.studioId, access.studioId));
  return {
    configured: discordConfigured(),
    canConnect: roleHas(access.role, "studio.update"),
    connection: row
      ? {
          guildName: row.c.guildName,
          connectedAt: row.c.connectedAt.toISOString(),
          connectedBy: row.by ?? null,
          lost: Boolean(row.c.lostAt),
        }
      : null,
  };
}

async function activeConnection(ex: Executor, studioId: string) {
  const [connection] = await ex.select().from(discordConnections).where(and(eq(discordConnections.studioId, studioId), isNull(discordConnections.lostAt)));
  return connection ?? null;
}

async function markLost(guildId: string) {
  await db.update(discordConnections).set({ lostAt: now() }).where(and(eq(discordConnections.guildId, guildId), isNull(discordConnections.lostAt)));
}

// ── Channels and feeds ──────────────────────────────────────────────────────────────────────

export interface DiscordChannelDTO {
  id: string;
  name: string;
  category: string | null;
}

/** Text and announcement channels the bot can see, in Discord's order. */
export async function listDiscordChannels(actor: Actor, projectId: string): Promise<DiscordChannelDTO[]> {
  const access = await requireProject(actor.userId, projectId, "board.manage");
  return channelsOf(access.studioId);
}

async function channelsOf(studioId: string): Promise<DiscordChannelDTO[]> {
  if (!discordConfigured()) throw invalid("Discord isn't set up on this Forge site.");
  const connection = await activeConnection(db, studioId);
  if (!connection) throw invalid("Connect a Discord server in studio settings first.");
  const res = await discordApi<Array<{ id: string; name: string; type: number; position: number; parent_id: string | null }>>(`/guilds/${connection.guildId}/channels`);
  if (!res.ok || !res.data) {
    if (res.code === 10004 || res.code === 50001 || res.status === 404) {
      await markLost(connection.guildId);
      throw invalid(`Forge is no longer in ${connection.guildName}. An Admin can reconnect it in studio settings.`);
    }
    throw invalid(`Couldn't load the Discord channels (${res.message}). Please try again.`);
  }
  const categories = new Map(res.data.filter((c) => c.type === 4).map((c) => [c.id, c]));
  return res.data
    .filter((c) => c.type === 0 || c.type === 5)
    .sort((a, b) => {
      const pa = a.parent_id ? (categories.get(a.parent_id)?.position ?? 0) : -1;
      const pb = b.parent_id ? (categories.get(b.parent_id)?.position ?? 0) : -1;
      return pa - pb || a.position - b.position;
    })
    .map((c) => ({ id: c.id, name: c.name, category: c.parent_id ? (categories.get(c.parent_id)?.name ?? null) : null }));
}

export interface DiscordFeedDTO {
  id: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  boardId: string | null;
  boardName: string | null;
  channelId: string;
  channelName: string;
  events: DiscordEventType[];
  privateProject: boolean;
  privateConfirmed: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

async function feedRows(where: ReturnType<typeof eq>) {
  const rows = await db
    .select({ r: discordRoutes, projectName: projects.name, projectSlug: projects.slug, visibility: projects.visibility, boardName: boards.name })
    .from(discordRoutes)
    .innerJoin(projects, eq(projects.id, discordRoutes.projectId))
    .leftJoin(boards, eq(boards.id, discordRoutes.boardId))
    .where(where)
    .orderBy(asc(projects.name), asc(discordRoutes.createdAt));
  return rows.map(
    ({ r, projectName, projectSlug, visibility, boardName }): DiscordFeedDTO => ({
      id: r.id,
      projectId: r.projectId,
      projectName,
      projectSlug,
      boardId: r.boardId,
      boardName: boardName ?? null,
      channelId: r.channelId,
      channelName: r.channelName,
      events: r.events.filter(isDiscordEvent),
      privateProject: visibility === "PRIVATE",
      privateConfirmed: Boolean(r.privateConfirmedAt),
      lastSentAt: r.lastSentAt?.toISOString() ?? null,
      lastError: r.lastError,
      lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
    }),
  );
}

/** A project's feeds (Managers and above). */
export async function listProjectFeeds(actor: Actor, projectId: string) {
  const access = await requireProject(actor.userId, projectId, "board.manage");
  return feedRows(eq(discordRoutes.projectId, access.project.id));
}

/** Every feed in the studio (Admins and the Owner, for the overview in studio settings). */
export async function listStudioFeeds(actor: Actor, studioId: string) {
  const access = await requireStudio(actor.userId, studioId, "studio.update");
  return feedRows(eq(discordRoutes.studioId, access.studioId));
}

export async function saveDiscordFeed(
  actor: Actor,
  input: { projectId: string; feedId?: string | null; boardId: string | null; channelId: string; events: string[]; confirmPrivate: boolean },
): Promise<DiscordFeedDTO> {
  const access = await requireProject(actor.userId, input.projectId, "board.manage");
  const events = [...new Set(input.events.filter(isDiscordEvent))];
  if (!events.length) throw invalid("Choose at least one kind of event.");
  if (input.boardId) {
    const [board] = await db.select({ id: boards.id }).from(boards).where(and(eq(boards.id, input.boardId), eq(boards.projectId, access.project.id), isNull(boards.archivedAt)));
    if (!board) throw invalid("That board isn't in this project.");
  }
  const channel = (await channelsOf(access.studioId)).find((c) => c.id === input.channelId);
  if (!channel) throw invalid("That channel isn't in the connected Discord server (or Forge can't see it).");
  const existing = input.feedId
    ? (await db.select().from(discordRoutes).where(and(eq(discordRoutes.id, input.feedId), eq(discordRoutes.projectId, access.project.id))))[0]
    : undefined;
  if (input.feedId && !existing) throw notFound("Feed");
  const isPrivate = access.project.visibility === "PRIVATE";
  const confirmed = existing?.privateConfirmedAt && existing.channelId === input.channelId;
  if (isPrivate && !confirmed && !input.confirmPrivate) {
    throw invalid(`This project is private. Confirm that everyone who can read #${channel.name} may see its activity.`);
  }
  const [duplicate] = await db
    .select({ id: discordRoutes.id })
    .from(discordRoutes)
    .where(
      and(
        eq(discordRoutes.projectId, access.project.id),
        eq(discordRoutes.channelId, channel.id),
        input.boardId ? eq(discordRoutes.boardId, input.boardId) : isNull(discordRoutes.boardId),
        existing ? ne(discordRoutes.id, existing.id) : sql`true`,
      ),
    )
    .limit(1);
  if (duplicate) throw conflict(`#${channel.name} already gets this ${input.boardId ? "board" : "project"}'s events.`);
  const confirmation = isPrivate && input.confirmPrivate && !confirmed ? { privateConfirmedAt: now(), privateConfirmedById: actor.userId } : {};
  const values = { boardId: input.boardId, channelId: channel.id, channelName: channel.name, events, updatedAt: now(), lastError: null, lastErrorAt: null, ...confirmation };
  const id = await db.transaction(async (tx) => {
    const [row] = existing
      ? await tx.update(discordRoutes).set(values).where(eq(discordRoutes.id, existing.id)).returning({ id: discordRoutes.id })
      : await tx.insert(discordRoutes).values({ ...values, studioId: access.studioId, projectId: access.project.id, createdById: actor.userId }).returning({ id: discordRoutes.id });
    await audit(tx, actor, { studioId: access.studioId, action: existing ? "discord.feed_updated" : "discord.feed_added", targetType: "project", targetId: access.project.id, data: { channel: channel.name, events } });
    return row!.id;
  });
  return (await feedRows(eq(discordRoutes.id, id)))[0]!;
}

async function loadFeed(actor: Actor, feedId: string) {
  const [route] = await db.select().from(discordRoutes).where(eq(discordRoutes.id, feedId));
  if (!route) throw notFound("Feed");
  const access = await requireProject(actor.userId, route.projectId, "board.manage");
  return { route, access };
}

export async function deleteDiscordFeed(actor: Actor, feedId: string) {
  const { route, access } = await loadFeed(actor, feedId);
  await db.transaction(async (tx) => {
    await tx.delete(discordRoutes).where(eq(discordRoutes.id, route.id));
    await audit(tx, actor, { studioId: access.studioId, action: "discord.feed_removed", targetType: "project", targetId: route.projectId, data: { channel: route.channelName } });
  });
  return { ok: true as const };
}

/** Posts a test message now (not queued) and reports the outcome. */
export async function testDiscordFeed(actor: Actor, feedId: string): Promise<{ ok: boolean; error: string | null }> {
  const { route, access } = await loadFeed(actor, feedId);
  const connection = await activeConnection(db, access.studioId);
  if (!connection) return { ok: false, error: "Discord isn't connected for this studio." };
  const url = `${appOrigin()}/${access.studioSlug}/${access.project.slug}`;
  const [board] = route.boardId ? await db.select({ name: boards.name }).from(boards).where(eq(boards.id, route.boardId)) : [];
  const events = DISCORD_EVENTS.filter((e) => route.events.includes(e));
  const message = buildDiscordMessage({
    type: "TEST",
    author: "🧪 Test message",
    title: `${access.project.name} posts here`,
    url,
    description: ["This channel gets:", ...events.map((e) => `${DISCORD_EVENT_META[e].emoji} ${DISCORD_EVENT_META[e].label}`)].join("\n"),
    footer: `${access.project.name} · ${board?.name ?? "all boards"}`,
    buttonLabel: "Open the project",
  });
  const result = await postMessage(route, message);
  return { ok: result.ok, error: result.ok ? null : result.routeError ?? result.error };
}

// ── Queueing events ─────────────────────────────────────────────────────────────────────────

export interface DiscordEventPayload {
  type: DiscordEventType;
  projectId: string;
  boardId: string | null;
  cardId?: string;
  deliverableId?: string | null;
  actorId?: string | null;
  versionNumber?: number | null;
  resubmission?: boolean;
  /** DUE_DIGEST: the day (YYYY-MM-DD, UTC). */
  day?: string;
  at: string;
}

/**
 * Queues a feed message for every matching feed, inside the caller's transaction (so it's sent only
 * if the change commits, and exactly once per feed thanks to the dedupe key). Cheap when nothing
 * is connected.
 */
export async function queueDiscordEvent(tx: Executor, event: DiscordEventPayload, dedupeKey: string): Promise<number> {
  if (!discordConfigured()) return 0;
  const routes = await tx
    .select({ id: discordRoutes.id })
    .from(discordRoutes)
    .innerJoin(discordConnections, and(eq(discordConnections.studioId, discordRoutes.studioId), isNull(discordConnections.lostAt)))
    .where(
      and(
        eq(discordRoutes.projectId, event.projectId),
        event.boardId ? or(isNull(discordRoutes.boardId), eq(discordRoutes.boardId, event.boardId)) : isNull(discordRoutes.boardId),
        arrayContains(discordRoutes.events, [event.type]),
      ),
    );
  if (!routes.length) return 0;
  const inserted = await tx
    .insert(discordDeliveries)
    .values(routes.map((r) => ({ routeId: r.id, event, dedupeKey })))
    .onConflictDoNothing()
    .returning({ id: discordDeliveries.id });
  return inserted.length;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Sends queued feed messages shortly after an event commits (the minutely job is the safety net). */
export function scheduleDiscordDelivery() {
  if (process.env.NODE_ENV === "test" || timer || !discordConfigured()) return;
  timer = setTimeout(() => {
    timer = null;
    void processDiscordDeliveries().catch((error) => console.error("[discord] delivery failed", error));
  }, 250);
}

/** Once a day per feed with the summary on: overdue work and work due in the next two days. */
export async function runDiscordDueDigests(at: Date = now()): Promise<number> {
  if (!discordConfigured() || at.getUTCHours() < DISCORD_DIGEST_HOUR_UTC) return 0;
  const day = at.toISOString().slice(0, 10);
  const routes = await db
    .select({ id: discordRoutes.id, projectId: discordRoutes.projectId, boardId: discordRoutes.boardId })
    .from(discordRoutes)
    .innerJoin(discordConnections, and(eq(discordConnections.studioId, discordRoutes.studioId), isNull(discordConnections.lostAt)))
    .where(arrayContains(discordRoutes.events, ["DUE_DIGEST"]));
  if (!routes.length) return 0;
  const inserted = await db
    .insert(discordDeliveries)
    .values(routes.map((r) => ({ routeId: r.id, dedupeKey: `digest:${day}`, event: { type: "DUE_DIGEST", projectId: r.projectId, boardId: r.boardId, day, at: at.toISOString() } satisfies DiscordEventPayload })))
    .onConflictDoNothing()
    .returning({ id: discordDeliveries.id });
  if (inserted.length) scheduleDiscordDelivery();
  return inserted.length;
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
/** Older than this, a feed message is no longer news. */
const STALE_AFTER_MS = 24 * 60 * 60_000;

type RouteRow = typeof discordRoutes.$inferSelect;

async function postMessage(route: RouteRow, message: DiscordMessage): Promise<{ ok: true; messageId: string } | { ok: false; retryable: boolean; retryAfterMs: number | null; error: string; routeError: string | null }> {
  const res = await discordApi<{ id: string }>(`/channels/${route.channelId}/messages`, { method: "POST", body: message });
  if (res.ok && res.data) {
    await db.update(discordRoutes).set({ lastSentAt: now(), lastError: null, lastErrorAt: null }).where(eq(discordRoutes.id, route.id));
    return { ok: true, messageId: res.data.id };
  }
  const channel = `#${route.channelName}`;
  let routeError: string | null = null;
  if (res.code === 10003 || res.status === 404) routeError = `${channel} no longer exists. Choose another channel for this feed.`;
  else if (res.code === 50001 || res.code === 50013 || res.status === 403) routeError = `Forge can't post in ${channel}. In Discord, let the Forge bot view the channel, send messages and embed links there.`;
  if (routeError) await db.update(discordRoutes).set({ lastError: routeError, lastErrorAt: now() }).where(eq(discordRoutes.id, route.id));
  const retryable = !routeError && (res.status === 0 || res.status === 429 || res.status >= 500);
  return { ok: false, retryable, retryAfterMs: res.retryAfterMs, error: res.message, routeError };
}

function projectLink(studioSlug: string, projectSlug: string) {
  return `${appOrigin()}/${studioSlug}/${projectSlug}`;
}

/** The message for a queued event, built from current data; or why it should no longer be sent. */
async function messageFor(route: RouteRow, event: DiscordEventPayload): Promise<{ message: DiscordMessage } | { skip: string }> {
  const [project] = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug, key: projects.key, visibility: projects.visibility, archivedAt: projects.archivedAt, studioSlug: studios.slug })
    .from(projects)
    .innerJoin(studios, eq(studios.id, projects.studioId))
    .where(eq(projects.id, event.projectId));
  if (!project) return { skip: "The project was deleted." };
  if (project.archivedAt) return { skip: "The project is archived." };
  if (project.visibility === "PRIVATE" && !route.privateConfirmedAt) return { skip: "Private project: posting to this channel wasn't confirmed." };
  if (event.type === "DUE_DIGEST") return digestMessage(route, event, project);

  if (!event.cardId) return { skip: "Nothing to show." };
  const [card] = await db
    .select({ id: cards.id, number: cards.number, title: cards.title, dueAt: cards.dueAt, archivedAt: cards.archivedAt, boardNumber: boards.number, boardName: boards.name, boardArchivedAt: boards.archivedAt, columnArchivedAt: boardColumns.archivedAt })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .where(eq(cards.id, event.cardId));
  if (!card || card.archivedAt || card.boardArchivedAt || card.columnArchivedAt) return { skip: "The card was archived or removed." };
  const live = await db
    .select({ id: deliverables.id, name: deliverables.name, number: deliverables.number, dueAt: deliverables.dueAt })
    .from(deliverables)
    .where(and(eq(deliverables.cardId, card.id), isNull(deliverables.archivedAt)));
  const deliverable = event.deliverableId ? live.find((d) => d.id === event.deliverableId) : undefined;
  if (event.deliverableId && !deliverable) return { skip: "The deliverable was archived or removed." };
  const multi = live.length > 1;
  const [actor] = event.actorId ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, event.actorId)) : [];
  const key = `${project.key}-${card.number}`;
  const url = `${projectLink(project.studioSlug, project.slug)}/b/${card.boardNumber}?card=${encodeURIComponent(key)}${multi && deliverable ? `&d=${deliverable.number}` : ""}`;

  // Who's involved and by when: names only (they never ping), the deadline in each reader's time zone.
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  const [assigned, reviewing] = await Promise.all([
    db.select({ name: users.displayName }).from(cardAssignees).innerJoin(users, eq(users.id, cardAssignees.userId)).where(eq(cardAssignees.cardId, card.id)).orderBy(asc(cardAssignees.createdAt)),
    event.type === "REVIEW_SUBMITTED"
      ? db.select({ name: users.displayName }).from(cardReviewers).innerJoin(users, eq(users.id, cardReviewers.userId)).where(eq(cardReviewers.cardId, card.id)).orderBy(asc(cardReviewers.createdAt))
      : Promise.resolve([]),
  ]);
  if (assigned.length) fields.push({ name: "Assigned", value: nameList(assigned.map((a) => a.name)), inline: true });
  if (reviewing.length) fields.push({ name: reviewing.length === 1 ? "Reviewer" : "Reviewers", value: nameList(reviewing.map((r) => r.name)), inline: true });
  const due = event.type === "COMPLETED" || event.type === "PUBLISHED" ? null : discordTime((deliverable?.dueAt ?? card.dueAt)?.toISOString(), "R");
  if (due) fields.push({ name: "Due", value: due, inline: true });

  return {
    message: buildDiscordMessage({
      type: event.type,
      author: feedLabel(event.type, event.resubmission),
      title: `${key} ${card.title}${multi && deliverable ? ` · ${deliverable.name}` : ""}`,
      url,
      description: eventSummary({
        type: event.type,
        actor: actor?.name ?? null,
        versionNumber: event.versionNumber,
        deliverable: multi && deliverable ? deliverable.name : null,
        resubmission: event.resubmission,
      }),
      fields,
      footer: `${project.name} · ${card.boardName}`,
      timestamp: event.at,
      buttonLabel: feedButton(event.type),
    }),
  };
}

const DAY_MS = 24 * 60 * 60_000;

async function digestMessage(route: RouteRow, event: DiscordEventPayload, project: { id: string; name: string; slug: string; key: string; studioSlug: string }): Promise<{ message: DiscordMessage } | { skip: string }> {
  const at = new Date(event.at);
  const horizon = new Date(at.getTime() + 2 * DAY_MS);
  const liveCard = and(eq(cards.projectId, project.id), isNull(cards.archivedAt), isNull(boards.archivedAt), isNull(boardColumns.archivedAt), route.boardId ? eq(cards.boardId, route.boardId) : sql`true`);
  const [cardRows, deliverableRows] = await Promise.all([
    db
      .select({ id: cards.id, number: cards.number, title: cards.title, dueAt: cards.dueAt, boardNumber: boards.number })
      .from(cards)
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .where(and(liveCard, isNotNull(cards.dueAt), lte(cards.dueAt, horizon), ne(cards.state, "APPROVED"))),
    db
      .select({ id: cards.id, number: cards.number, title: cards.title, name: deliverables.name, dNumber: deliverables.number, dueAt: deliverables.dueAt, boardNumber: boards.number })
      .from(deliverables)
      .innerJoin(cards, eq(cards.id, deliverables.cardId))
      .innerJoin(boards, eq(boards.id, cards.boardId))
      .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
      .where(and(liveCard, isNull(deliverables.archivedAt), isNotNull(deliverables.dueAt), lte(deliverables.dueAt, horizon), ne(deliverables.state, "APPROVED"))),
  ]);
  const base = projectLink(project.studioSlug, project.slug);
  const items = [
    ...cardRows.map((c) => ({ cardId: c.id, due: c.dueAt!, text: `${project.key}-${c.number} ${c.title}`, url: `${base}/b/${c.boardNumber}?card=${project.key}-${c.number}` })),
    ...deliverableRows.map((d) => ({ cardId: d.id, due: d.dueAt!, text: `${project.key}-${d.number} ${d.title} · ${d.name}`, url: `${base}/b/${d.boardNumber}?card=${project.key}-${d.number}&d=${d.dNumber}` })),
  ].sort((a, b) => a.due.getTime() - b.due.getTime());
  if (!items.length) return { skip: "Nothing overdue or due soon." };
  const shown = items.slice(0, 10);
  const more = items.length - shown.length;
  // Who's on each card (names only; they never ping).
  const people = shown.length
    ? await db
        .select({ cardId: cardAssignees.cardId, name: users.displayName })
        .from(cardAssignees)
        .innerJoin(users, eq(users.id, cardAssignees.userId))
        .where(inArray(cardAssignees.cardId, [...new Set(shown.map((i) => i.cardId))]))
        .orderBy(asc(cardAssignees.createdAt))
    : [];
  const line = (i: (typeof items)[number]) => {
    const late = i.due < at;
    const when = discordTime(i.due.toISOString(), "R");
    const who = people.filter((p) => p.cardId === i.cardId).map((p) => p.name);
    return `${late ? "🚨" : "⏰"} [${escapeMarkdown(i.text)}](${i.url}) · ${late ? "was due" : "due"} ${when}${who.length ? ` · ${nameList(who, 2)}` : ""}`;
  };
  const overdue = items.filter((i) => i.due < at).length;
  return {
    message: buildDiscordMessage({
      type: "DUE_DIGEST",
      color: overdue ? DISCORD_COLORS.CHANGES_REQUESTED : DISCORD_COLORS.REVIEW_SUBMITTED,
      author: feedLabel("DUE_DIGEST"),
      title: `${project.name}: ${overdue ? `${overdue} overdue, ` : ""}${items.length - overdue} due soon`,
      url: base,
      description: [...shown.map(line), ...(more ? [`…and ${more} more in Forge.`] : [])].join("\n"),
      footer: `${project.name}${route.boardId ? "" : " · all boards"}`,
      timestamp: event.at,
      buttonLabel: feedButton("DUE_DIGEST"),
    }),
  };
}

async function finish(id: string, status: "SENT" | "SKIPPED" | "FAILED", error: string | null = null, messageId: string | null = null) {
  await db.update(discordDeliveries).set({ status, error, messageId, sentAt: status === "SENT" ? now() : null }).where(eq(discordDeliveries.id, id));
}

/**
 * Sends due feed messages. Rows are claimed (SENDING, attempt counted) before sending so several
 * workers never send the same one; a claim that's never finished is picked up again after 5
 * minutes. Rate limits wait as long as Discord asks; broken channels are reported on the feed.
 */
export async function processDiscordDeliveries(limit = 50): Promise<{ sent: number; skipped: number; failed: number; retried: number }> {
  const totals = { sent: 0, skipped: 0, failed: 0, retried: 0 };
  if (!discordConfigured()) return totals;
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: discordDeliveries.id })
      .from(discordDeliveries)
      .where(and(inArray(discordDeliveries.status, ["QUEUED", "SENDING"]), lte(discordDeliveries.nextAttemptAt, sql`now()`)))
      .orderBy(asc(discordDeliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(discordDeliveries)
      .set({ status: "SENDING", attempts: sql`${discordDeliveries.attempts} + 1`, nextAttemptAt: sql`now() + interval '5 minutes'` })
      .where(inArray(discordDeliveries.id, due.map((d) => d.id)))
      .returning();
  });

  for (const delivery of claimed) {
    const retry = async (error: string, delayMs?: number | null) => {
      if (delivery.attempts < MAX_ATTEMPTS) {
        const wait = delayMs ?? RETRY_DELAYS_MS[Math.min(delivery.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
        await db.update(discordDeliveries).set({ status: "QUEUED", error, nextAttemptAt: new Date(Date.now() + wait) }).where(eq(discordDeliveries.id, delivery.id));
        totals.retried++;
      } else {
        await finish(delivery.id, "FAILED", error);
        totals.failed++;
      }
    };
    try {
      const [row] = await db
        .select({ route: discordRoutes, lostAt: discordConnections.lostAt })
        .from(discordRoutes)
        .innerJoin(discordConnections, eq(discordConnections.studioId, discordRoutes.studioId))
        .where(eq(discordRoutes.id, delivery.routeId));
      if (!row || row.lostAt) {
        await finish(delivery.id, "SKIPPED", "Discord is no longer connected for this studio.");
        totals.skipped++;
        continue;
      }
      const event = delivery.event as DiscordEventPayload;
      if (event.type !== "DUE_DIGEST" && Date.now() - new Date(event.at).getTime() > STALE_AFTER_MS) {
        await finish(delivery.id, "SKIPPED", "Too old to post.");
        totals.skipped++;
        continue;
      }
      if (!row.route.events.includes(event.type)) {
        await finish(delivery.id, "SKIPPED", "This feed no longer gets these events.");
        totals.skipped++;
        continue;
      }
      const built = await messageFor(row.route, event);
      if ("skip" in built) {
        await finish(delivery.id, "SKIPPED", built.skip);
        totals.skipped++;
        continue;
      }
      const result = await postMessage(row.route, built.message);
      if (result.ok) {
        await finish(delivery.id, "SENT", null, result.messageId);
        totals.sent++;
      } else if (result.retryable) {
        await retry(result.error, result.retryAfterMs);
      } else {
        await finish(delivery.id, "FAILED", result.routeError ?? result.error);
        totals.failed++;
      }
    } catch (error) {
      await retry(error instanceof Error ? error.message : String(error)).catch(() => {});
    }
  }
  return totals;
}

/** A feed's queued and finished messages, oldest first (tests and diagnostics). */
export async function discordDeliveriesFor(routeId: string) {
  return db.select().from(discordDeliveries).where(eq(discordDeliveries.routeId, routeId)).orderBy(asc(discordDeliveries.createdAt));
}
