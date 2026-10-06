/**
 * Connected Discord profiles: a member's Discord username (handle), display name and picture, kept
 * in step with Discord. Refreshed right after connecting or signing in with Discord, in the
 * background once a day while they use Forge (DISCORD_PROFILE_FRESH_MS), and on "Refresh Discord
 * profile" — never on every page view, and never instantly: changes appear after the next refresh.
 *
 * Studio-owned fields are never changed by a refresh: the studio display name and Forge username
 * stay as the person set them, and the Discord picture is shown only when they chose it. Accounts
 * are identified by the Discord account id, verified through OAuth on the server; nothing a browser
 * sends (a handle, an avatar URL) is trusted. Tokens are encrypted at rest and never leave the
 * server; a refresh holds a lease so two can't race over a rotating refresh token.
 */
import "server-only";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { accessibleProjectIds } from "../access";
import { seal, unseal } from "../auth/secret-box";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { oauthAccounts, users } from "../db/schema";
import { env } from "../env";
import { invalid } from "../errors";
import { renderAvatar } from "../media/process";
import { avatarKey as avatarStorageKey, storage } from "../storage";
import type { Actor } from "./context";
import { Effects } from "./effects";
import { avatarUrl } from "./users-lookup";

/** How long a refreshed profile counts as fresh before a background refresh (documented in the UI). */
export const DISCORD_PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;
/** After a failed refresh: 5 min, 30 min, 2 h, then every 12 h (or longer when Discord asks). */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const LEASE_MS = 60_000;
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
/** Discord's CDN: pictures are only ever downloaded from here, at paths built from validated ids. */
const DISCORD_CDN = "https://cdn.discordapp.com";

type Link = typeof oauthAccounts.$inferSelect;

export interface DiscordProfileFields {
  /** Unique username (handle); legacy accounts keep their #discriminator. */
  username: string;
  /** Display name (`global_name`), when set. */
  globalName: string | null;
  /** Avatar hash, or null for Discord's default picture. */
  avatar: string | null;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number | null;
}

/** Discord's user object (the fields Forge reads): https://discord.com/developers/docs/resources/user */
export interface DiscordUserObject {
  id: string;
  username: string;
  discriminator?: string | null;
  global_name?: string | null;
  avatar?: string | null;
}

const SNOWFLAKE = /^\d{5,25}$/;
const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;

/** The handle people know: the username, or "name#1234" for accounts that still have a discriminator. */
export function discordHandle(user: Pick<DiscordUserObject, "username" | "discriminator">): string {
  return user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username;
}

export function profileFromDiscordUser(user: DiscordUserObject): DiscordProfileFields {
  const avatar = typeof user.avatar === "string" && AVATAR_HASH.test(user.avatar) ? user.avatar : null;
  return { username: discordHandle(user).slice(0, 64), globalName: user.global_name?.trim().slice(0, 64) || null, avatar };
}

/**
 * A 256 px still of the picture, from Discord's CDN. Animated pictures ("a_" hashes) are fetched as
 * PNG, which is their first frame, so busy screens don't animate.
 */
export function discordAvatarCdnUrl(discordUserId: string, hash: string): string {
  if (!SNOWFLAKE.test(discordUserId) || !AVATAR_HASH.test(hash)) throw new Error("Not a Discord avatar.");
  return `${DISCORD_CDN}/avatars/${discordUserId}/${hash}.png?size=256`;
}

function tokenColumns(tokens: OAuthTokens) {
  return {
    accessToken: seal(tokens.accessToken),
    refreshToken: tokens.refreshToken ? seal(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresIn ? new Date(now().getTime() + tokens.expiresIn * 1000) : null,
  };
}

/**
 * Stores what Discord just told the server at sign-in or connection (identity verified through
 * OAuth), with the new tokens. The picture is downloaded afterwards (`scheduleDiscordAvatarCache`).
 */
export async function recordDiscordConnection(ex: Executor, accountId: string, profile: DiscordProfileFields, tokens: OAuthTokens | null) {
  const at = now();
  await ex
    .update(oauthAccounts)
    .set({
      providerUsername: profile.username,
      displayName: profile.globalName,
      avatarHash: profile.avatar,
      ...(tokens ? { ...tokenColumns(tokens), needsReauthAt: null } : {}),
      profileSyncedAt: at,
      syncError: null,
      syncFailures: 0,
      nextSyncAt: new Date(at.getTime() + DISCORD_PROFILE_FRESH_MS),
    })
    .where(eq(oauthAccounts.id, accountId));
}

async function discordLink(ex: Executor, userId: string): Promise<Link | null> {
  const [row] = await ex
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "discord")))
    .limit(1);
  return row ?? null;
}

// ── The one place the shown picture is decided ─────────────────────────────────────────────

/**
 * Recomputes the picture everyone sees (users.avatarKey): the cached Discord picture when the person
 * chose Discord and there is one, otherwise their uploaded photo (or none: initials). Returns whether
 * it changed.
 */
export async function applyAvatarSource(ex: Executor, userId: string): Promise<boolean> {
  const [row] = await ex
    .select({ shown: users.avatarKey, custom: users.customAvatarKey, source: users.avatarSource, discord: oauthAccounts.avatarKey })
    .from(users)
    .leftJoin(oauthAccounts, and(eq(oauthAccounts.userId, users.id), eq(oauthAccounts.provider, "discord")))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return false;
  const shown = row.source === "discord" && row.discord ? row.discord : row.custom;
  if (shown === row.shown) return false;
  await ex.update(users).set({ avatarKey: shown }).where(eq(users.id, userId));
  return true;
}

/** Open boards and cards that show this person reload (their picture or Discord handle changed). */
export async function announceProfileChange(userId: string) {
  const fx = new Effects();
  for (const id of await accessibleProjectIds(userId)) fx.project(id);
  fx.flush();
}

// ── Pictures ────────────────────────────────────────────────────────────────────────────────

async function downloadDiscordAvatar(discordUserId: string, hash: string): Promise<Buffer> {
  const res = await fetch(discordAvatarCdnUrl(discordUserId, hash), { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "image/png,image/webp,image/*" } });
  if (!res.ok || !res.body) throw new Error(`Discord's CDN answered ${res.status}.`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^image\/(png|webp|gif|jpeg)$/.test(type)) throw new Error("Discord's CDN didn't send an image.");
  if (Number(res.headers.get("content-length") ?? 0) > MAX_AVATAR_BYTES) throw new Error("That picture is too large.");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AVATAR_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("That picture is too large.");
    }
    chunks.push(value);
  }
  // Decoding validates the bytes really are an image; the result is a 256 px still WebP.
  return renderAvatar(Buffer.concat(chunks));
}

/**
 * Makes our copy of the Discord picture match the stored avatar hash (downloads it when it changed;
 * removes it when the person removed their Discord picture), then updates the shown picture.
 */
export async function cacheDiscordAvatar(userId: string): Promise<"updated" | "unchanged" | "failed"> {
  const link = await discordLink(db, userId);
  if (!link) return "unchanged";
  const wanted = link.avatarHash ? avatarStorageKey(userId, `discord-${link.avatarHash}`) : null;
  const present = wanted ? Boolean(await storage().stat(wanted)) : true;
  if (wanted === link.avatarKey && present) {
    const changed = await applyAvatarSource(db, userId);
    if (changed) await announceProfileChange(userId);
    return changed ? "updated" : "unchanged";
  }
  let stored: string | null = null;
  if (link.avatarHash && wanted) {
    try {
      await storage().put(wanted, await downloadDiscordAvatar(link.providerAccountId, link.avatarHash), "image/webp");
      stored = wanted;
    } catch (error) {
      // The last good copy stays; the next refresh tries again.
      await db
        .update(oauthAccounts)
        .set({ syncError: "Forge couldn't download your Discord picture. It will try again.", nextSyncAt: new Date(now().getTime() + RETRY_DELAYS_MS[1]!) })
        .where(eq(oauthAccounts.id, link.id));
      console.warn("[discord] picture download failed", error instanceof Error ? error.message : error);
      return "failed";
    }
  }
  // Only if the picture is still the one just downloaded (a newer refresh or a disconnect wins).
  const [updated] = await db
    .update(oauthAccounts)
    .set({ avatarKey: stored })
    .where(and(eq(oauthAccounts.id, link.id), link.avatarHash ? eq(oauthAccounts.avatarHash, link.avatarHash) : isNull(oauthAccounts.avatarHash)))
    .returning({ id: oauthAccounts.id });
  if (!updated) {
    if (stored && stored !== link.avatarKey) await storage().delete(stored).catch(() => {});
    return "unchanged";
  }
  await applyAvatarSource(db, userId);
  if (link.avatarKey && link.avatarKey !== stored) await storage().delete(link.avatarKey).catch(() => {});
  await announceProfileChange(userId);
  return "updated";
}

/** After a connection or Discord sign-in: fetch the picture without holding up the response. */
export function scheduleDiscordAvatarCache(userId: string) {
  if (process.env.NODE_ENV === "test") return;
  setTimeout(() => void cacheDiscordAvatar(userId).catch((error) => console.error("[discord] picture refresh failed", error)), 0);
}

// ── Refreshing from Discord ─────────────────────────────────────────────────────────────────

function discordOAuthConfigured() {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}

function clientAuth() {
  return `Basic ${Buffer.from(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`).toString("base64")}`;
}

function retryAfterMs(res: Response, json: { retry_after?: number } | null): number | null {
  const header = Number(res.headers.get("retry-after"));
  const seconds = typeof json?.retry_after === "number" ? json.retry_after : Number.isFinite(header) && header > 0 ? header : null;
  return seconds === null ? null : Math.ceil(seconds * 1000);
}

export type Outcome = "updated" | "unchanged" | "busy" | "not-due" | "not-connected" | "reconnect" | "retry";

/** Discord no longer accepts our authorization: forget the tokens, keep the last profile, ask to reconnect. */
async function needsReconnect(link: Link, message: string): Promise<Outcome> {
  await db
    .update(oauthAccounts)
    .set({ accessToken: null, refreshToken: null, tokenExpiresAt: null, needsReauthAt: now(), syncError: message, nextSyncAt: null })
    .where(eq(oauthAccounts.id, link.id));
  return "reconnect";
}

/** A temporary failure: keep the last good profile and try again later (Discord's wait wins when longer). */
async function retryLater(link: Link, message: string, waitMs: number | null = null): Promise<Outcome> {
  const failures = link.syncFailures + 1;
  const delay = Math.max(waitMs ?? 0, RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1]!);
  await db
    .update(oauthAccounts)
    .set({ syncError: message, syncFailures: failures, nextSyncAt: new Date(now().getTime() + delay) })
    .where(eq(oauthAccounts.id, link.id));
  return "retry";
}

/** Exchanges the refresh token for new tokens; the rotated refresh token is stored before anything else happens. */
async function refreshTokens(link: Link, refreshToken: string): Promise<{ accessToken: string } | { outcome: Outcome }> {
  let res: Response;
  try {
    res = await fetch(`${env.DISCORD_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { authorization: clientAuth(), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { outcome: await retryLater(link, "Forge couldn't reach Discord. It will try again.") };
  }
  const json = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; retry_after?: number } | null;
  if (res.ok && json?.access_token) {
    const tokens = { accessToken: json.access_token, refreshToken: json.refresh_token ?? refreshToken, expiresIn: json.expires_in ?? null };
    await db.update(oauthAccounts).set(tokenColumns(tokens)).where(eq(oauthAccounts.id, link.id));
    return { accessToken: tokens.accessToken };
  }
  if (res.status === 429) return { outcome: await retryLater(link, "Discord asked Forge to wait before refreshing.", retryAfterMs(res, json)) };
  if (res.status === 400 || res.status === 401) return { outcome: await needsReconnect(link, "Discord no longer accepts Forge's access to your profile. Reconnect Discord to keep it in sync.") };
  return { outcome: await retryLater(link, `Discord didn't answer (${res.status}). Forge will try again.`) };
}

async function fetchMe(accessToken: string): Promise<{ status: number; user: DiscordUserObject | null; waitMs: number | null }> {
  try {
    const res = await fetch(`${env.DISCORD_API_BASE}/users/@me`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json().catch(() => null)) as (DiscordUserObject & { retry_after?: number }) | null;
    const user = res.ok && json && typeof json.id === "string" && typeof json.username === "string" ? json : null;
    return { status: res.status, user, waitMs: retryAfterMs(res, json) };
  } catch {
    return { status: 0, user: null, waitMs: null };
  }
}

async function runSync(link: Link): Promise<Outcome> {
  let access = unseal(link.accessToken);
  const refresh = unseal(link.refreshToken);
  if (!access && !refresh) return needsReconnect(link, "Reconnect Discord so Forge can keep your Discord profile up to date.");
  let refreshed = false;
  if (refresh && (!access || (link.tokenExpiresAt && link.tokenExpiresAt.getTime() < now().getTime() + 60_000))) {
    const result = await refreshTokens(link, refresh);
    if ("outcome" in result) return result.outcome;
    access = result.accessToken;
    refreshed = true;
  }
  let me = await fetchMe(access!);
  if (me.status === 401 && refresh && !refreshed) {
    const result = await refreshTokens(link, refresh);
    if ("outcome" in result) return result.outcome;
    me = await fetchMe(result.accessToken);
  }
  if (me.status === 401) return needsReconnect(link, "Discord no longer accepts Forge's access to your profile. Reconnect Discord to keep it in sync.");
  if (me.status === 429) return retryLater(link, "Discord asked Forge to wait before refreshing.", me.waitMs);
  if (!me.user) return retryLater(link, me.status ? `Discord didn't answer (${me.status}). Forge will try again.` : "Forge couldn't reach Discord. It will try again.");
  // The tokens must still belong to the connected account; accounts are never re-linked silently.
  if (me.user.id !== link.providerAccountId) return needsReconnect(link, "Discord answered for a different account. Reconnect Discord.");

  const profile = profileFromDiscordUser(me.user);
  const changed = profile.username !== link.providerUsername || profile.globalName !== link.displayName || profile.avatar !== link.avatarHash;
  const at = now();
  await db
    .update(oauthAccounts)
    .set({
      providerUsername: profile.username,
      displayName: profile.globalName,
      avatarHash: profile.avatar,
      profileSyncedAt: at,
      syncError: null,
      syncFailures: 0,
      needsReauthAt: null,
      nextSyncAt: new Date(at.getTime() + DISCORD_PROFILE_FRESH_MS),
    })
    .where(eq(oauthAccounts.id, link.id));
  const picture = await cacheDiscordAvatar(link.userId);
  if (changed && picture !== "updated") await announceProfileChange(link.userId);
  return changed || picture === "updated" ? "updated" : "unchanged";
}

/**
 * Refreshes the connected Discord profile. Without `force`, only when it's due (stale, or its retry
 * time came). One refresh per account at a time: the others get "busy".
 */
export async function syncDiscordProfile(userId: string, options: { force?: boolean } = {}): Promise<Outcome> {
  if (!discordOAuthConfigured()) return "not-connected";
  const at = now();
  const lease = new Date(at.getTime() + LEASE_MS);
  const [link] = await db
    .update(oauthAccounts)
    .set({ syncLeaseUntil: lease })
    .where(
      and(
        eq(oauthAccounts.userId, userId),
        eq(oauthAccounts.provider, "discord"),
        or(isNull(oauthAccounts.syncLeaseUntil), lte(oauthAccounts.syncLeaseUntil, at)),
        options.force ? undefined : and(isNull(oauthAccounts.needsReauthAt), or(isNull(oauthAccounts.nextSyncAt), lte(oauthAccounts.nextSyncAt, at))),
      ),
    )
    .returning();
  if (!link) {
    const current = await discordLink(db, userId);
    if (!current) return "not-connected";
    return current.syncLeaseUntil && current.syncLeaseUntil.getTime() > at.getTime() ? "busy" : "not-due";
  }
  try {
    return await runSync(link);
  } catch (error) {
    console.error("[discord] profile refresh failed", error);
    return retryLater(link, "Forge couldn't refresh your Discord profile. It will try again.");
  } finally {
    await db.update(oauthAccounts).set({ syncLeaseUntil: null }).where(and(eq(oauthAccounts.id, link.id), eq(oauthAccounts.syncLeaseUntil, lease)));
  }
}

const g = globalThis as unknown as { __forgeDiscordProfileChecks?: Map<string, number> };
const checkedAt = (g.__forgeDiscordProfileChecks ??= new Map<string, number>());
const CHECK_EVERY_MS = 10 * 60_000;

/**
 * While someone uses Forge: refresh their Discord profile in the background when it's stale.
 * Looks at most every few minutes per person and never delays the page.
 */
export function maybeRefreshDiscordProfile(userId: string) {
  if (process.env.NODE_ENV === "test" || !discordOAuthConfigured()) return;
  const t = Date.now();
  if ((checkedAt.get(userId) ?? 0) > t - CHECK_EVERY_MS) return;
  checkedAt.set(userId, t);
  if (checkedAt.size > 10_000) checkedAt.clear();
  void syncDiscordProfile(userId).catch((error) => console.error("[discord] background profile refresh failed", error));
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

export interface DiscordProfileDTO {
  username: string | null;
  displayName: string | null;
  /** Our copy of the Discord picture (null when there's none, or it hasn't been fetched yet). */
  avatarUrl: string | null;
  /** The Discord account has its own picture (not Discord's default one). */
  hasAvatar: boolean;
  syncedAt: string | null;
  /** ok · syncing (in progress, or not fetched yet) · retrying (temporary failure) · reconnect (authorization gone) */
  state: "ok" | "syncing" | "retrying" | "reconnect";
  message: string | null;
  freshHours: number;
}

export async function discordProfileStatus(userId: string): Promise<DiscordProfileDTO | null> {
  const link = await discordLink(db, userId);
  if (!link) return null;
  const at = now().getTime();
  const authorized = Boolean(link.accessToken || link.refreshToken) && !link.needsReauthAt;
  const state: DiscordProfileDTO["state"] = !authorized
    ? "reconnect"
    : link.syncLeaseUntil && link.syncLeaseUntil.getTime() > at
      ? "syncing"
      : link.syncError
        ? "retrying"
        : link.profileSyncedAt
          ? "ok"
          : "syncing";
  return {
    username: link.providerUsername,
    displayName: link.displayName,
    avatarUrl: await avatarUrl(link.avatarKey),
    hasAvatar: Boolean(link.avatarHash),
    syncedAt: link.profileSyncedAt?.toISOString() ?? null,
    state,
    message: state === "reconnect" ? (link.syncError ?? "Reconnect Discord so Forge can keep your Discord profile up to date.") : link.syncError,
    freshHours: DISCORD_PROFILE_FRESH_MS / 3_600_000,
  };
}

/** "Use Discord profile picture" on or off. Turning it on needs a connected Discord account. */
export async function setAvatarSource(actor: Actor, source: "custom" | "discord") {
  if (source === "discord" && !(await discordLink(db, actor.userId))) throw invalid("Connect Discord first.");
  await db.update(users).set({ avatarSource: source }).where(eq(users.id, actor.userId));
  if (await applyAvatarSource(db, actor.userId)) await announceProfileChange(actor.userId);
}

/** "Use my Discord display name": a one-time copy (display name, else username) — never kept in sync. */
export async function useDiscordDisplayName(actor: Actor) {
  const link = await discordLink(db, actor.userId);
  if (!link) throw invalid("Connect Discord first.");
  const name = (link.displayName ?? link.providerUsername ?? "").trim().slice(0, 60);
  if (!name) throw invalid("Forge hasn't loaded your Discord profile yet. Refresh it first.");
  await db.update(users).set({ displayName: name }).where(eq(users.id, actor.userId));
  await announceProfileChange(actor.userId);
  return name;
}

/** Revokes Forge's Discord authorization (best effort: the tokens are deleted either way). */
export async function revokeDiscordAuthorization(link: Pick<Link, "accessToken" | "refreshToken">) {
  const token = unseal(link.refreshToken) ?? unseal(link.accessToken);
  if (!token || !discordOAuthConfigured()) return;
  await fetch(`${env.DISCORD_API_BASE}/oauth2/token/revoke`, {
    method: "POST",
    headers: { authorization: clientAuth(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, token_type_hint: unseal(link.refreshToken) ? "refresh_token" : "access_token" }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

/** After disconnecting: the uploaded photo (or initials) is shown again and the Discord copy is removed. */
export async function forgetDiscordPicture(userId: string, cachedKey: string | null) {
  await db.update(users).set({ avatarSource: "custom" }).where(eq(users.id, userId));
  await applyAvatarSource(db, userId);
  if (cachedKey) await storage().delete(cachedKey).catch(() => {});
  await announceProfileChange(userId);
}

