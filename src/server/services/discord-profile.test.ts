/**
 * Connected Discord profiles against a fake Discord (OAuth, the user resource and the CDN; no
 * network). Fixtures are created here, in the test database only. No bot token is set, so no
 * direct messages are queued.
 */
vi.hoisted(() => {
  process.env.DISCORD_CLIENT_ID = "100000000000000002";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_API_BASE = "http://discord.test/api/v10";
});

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeOAuth } from "@/server/auth/oauth";
import { seal, unseal } from "@/server/auth/secret-box";
import { db } from "@/server/db";
import { oauthAccounts, studioMembers, users } from "@/server/db/schema";
import { storage } from "@/server/storage";
import { expectAppError, pngBuffer, setupStudio } from "@/test/helpers";
import * as accounts from "./accounts";
import { cacheDiscordAvatar, discordAvatarCdnUrl, profileFromDiscordUser, syncDiscordProfile, type DiscordUserObject } from "./discord-profile";
import * as studios from "./studios";

const API = "http://discord.test/api/v10";
const meta = { ip: null, userAgent: "vitest" };
let seq = 0;
const snowflake = () => `${710_000_000_000_000_000n + BigInt(Date.now() % 1_000_000) * 1000n + BigInt(++seq)}`;
const hash = () => crypto.randomBytes(16).toString("hex");

/** What Discord currently knows about one account, and how it answers. */
interface FakeAccount {
  user: DiscordUserObject;
  accessToken: string;
  refreshToken: string;
}
let accountsByToken = new Map<string, FakeAccount>();
let meAnswer: { status: number; retryAfter?: number } | null = null;
let cdn: { status: number; type: string } = { status: 200, type: "image/png" };
let tokenDelayMs = 0;
let calls: string[] = [];
let revoked: string[] = [];
let png: Buffer;

function fakeAccount(overrides: Partial<DiscordUserObject> = {}): FakeAccount {
  const n = ++seq;
  const account = {
    user: { id: snowflake(), username: `tester${n}`, global_name: `Tester ${n}`, avatar: hash(), discriminator: "0", ...overrides },
    accessToken: `access-${n}-${hash()}`,
    refreshToken: `refresh-${n}-${hash()}`,
  };
  accountsByToken.set(account.accessToken, account);
  accountsByToken.set(account.refreshToken, account);
  return account;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  calls = [];
  revoked = [];
  meAnswer = null;
  cdn = { status: 200, type: "image/png" };
  tokenDelayMs = 0;
  png ??= await pngBuffer(64, 64, "#5865f2");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.replace(/\?.*$/, "")}`);
      if (url.startsWith("https://cdn.discordapp.com/avatars/")) {
        return cdn.status === 200 ? new Response(new Uint8Array(png), { status: 200, headers: { "content-type": cdn.type } }) : new Response("missing", { status: cdn.status });
      }
      if (url === `${API}/users/@me`) {
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
        const account = accountsByToken.get(token);
        if (!account || account.accessToken !== token) return json(401, { message: "401: Unauthorized", code: 0 });
        if (meAnswer) return json(meAnswer.status, { message: "nope", retry_after: meAnswer.retryAfter });
        return json(200, account.user);
      }
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (url === `${API}/oauth2/token` && method === "POST") {
        if (tokenDelayMs) await new Promise((r) => setTimeout(r, tokenDelayMs));
        const account = accountsByToken.get(form.get("refresh_token") ?? "");
        if (!account || account.refreshToken !== form.get("refresh_token")) return json(400, { error: "invalid_grant" });
        // Discord rotates both tokens on every refresh.
        account.accessToken = `access-r${++seq}-${hash()}`;
        account.refreshToken = `refresh-r${seq}-${hash()}`;
        accountsByToken.set(account.accessToken, account);
        accountsByToken.set(account.refreshToken, account);
        return json(200, { access_token: account.accessToken, refresh_token: account.refreshToken, expires_in: 604800, token_type: "Bearer", scope: "identify email" });
      }
      if (url === `${API}/oauth2/token/revoke`) {
        revoked.push(form.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      return json(404, { message: "Unknown" });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Connects (or signs in with) a Discord account through the server-side OAuth path. */
async function connect(userId: string | null, account: FakeAccount, expiresIn = 604800) {
  const discord = profileFromDiscordUser(account.user);
  return completeOAuth(
    "discord",
    { id: account.user.id, email: null, emailVerified: false, username: account.user.username, displayName: discord.globalName ?? account.user.username, discord },
    userId,
    meta,
    { accessToken: account.accessToken, refreshToken: account.refreshToken, expiresIn },
  );
}

async function linkOf(userId: string) {
  const [row] = await db.select().from(oauthAccounts).where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "discord")));
  return row;
}
async function userRow(userId: string) {
  return (await db.select().from(users).where(eq(users.id, userId)))[0]!;
}
const actorOf = (userId: string) => ({ userId });

describe("connecting Discord", () => {
  it("stores the profile and encrypted tokens, and uses the Discord picture by default without an uploaded photo", async () => {
    const f = await setupStudio();
    const account = fakeAccount({ global_name: "Lena on Discord" });
    await connect(f.member.id, account);

    const link = await linkOf(f.member.id);
    expect(link).toMatchObject({ providerUsername: account.user.username, displayName: "Lena on Discord", avatarHash: account.user.avatar, providerAccountId: account.user.id });
    // Tokens are encrypted at rest and readable only by the server.
    expect(link!.accessToken).not.toContain(account.accessToken);
    expect(unseal(link!.accessToken)).toBe(account.accessToken);
    expect(unseal(link!.refreshToken)).toBe(account.refreshToken);
    expect((await userRow(f.member.id)).avatarSource).toBe("discord");

    expect(await cacheDiscordAvatar(f.member.id)).toBe("updated");
    const cached = (await linkOf(f.member.id))!.avatarKey!;
    expect(cached).toMatch(new RegExp(`^avatars/${f.member.id}/discord-${account.user.avatar}\\.webp$`));
    expect(await storage().stat(cached)).not.toBeNull();
    expect((await userRow(f.member.id)).avatarKey).toBe(cached);
    expect(calls.filter((c) => c.startsWith("GET https://cdn.discordapp.com/avatars/"))).toEqual([`GET https://cdn.discordapp.com/avatars/${account.user.id}/${account.user.avatar}.png`]);

    // The profile reports the connection, never the tokens.
    const profile = await accounts.getProfile(actorOf(f.member.id));
    expect(profile.discordProfile).toMatchObject({ username: account.user.username, displayName: "Lena on Discord", hasAvatar: true, state: "ok" });
    expect(JSON.stringify(profile)).not.toContain(account.accessToken);
    expect(JSON.stringify(profile)).not.toContain(account.refreshToken);
    // Teammates see the handle beside the studio name, and the same picture everywhere.
    const seen = (await studios.listMembers(f.manager.actor, f.studioId)).find((m) => m.id === f.member.id)!;
    expect(seen.discord).toEqual({ username: account.user.username, displayName: "Lena on Discord" });
    expect(seen.displayName).toBe("Member");
    expect(seen.avatarUrl).toContain(`discord-${account.user.avatar}`);
  });

  it("keeps an uploaded photo, and switches between it and the Discord picture on request", async () => {
    const f = await setupStudio();
    await accounts.setAvatar(actorOf(f.member.id), await pngBuffer(80, 80, "#22c3b6"));
    const custom = (await userRow(f.member.id)).customAvatarKey!;
    expect(custom).toBeTruthy();

    await connect(f.member.id, fakeAccount());
    await cacheDiscordAvatar(f.member.id);
    expect(await userRow(f.member.id)).toMatchObject({ avatarSource: "custom", avatarKey: custom });

    await accounts.chooseAvatarSource(actorOf(f.member.id), { source: "discord" });
    const discordKey = (await linkOf(f.member.id))!.avatarKey!;
    expect(await userRow(f.member.id)).toMatchObject({ avatarSource: "discord", avatarKey: discordKey, customAvatarKey: custom });

    // Uploading a new photo switches back to it (and replaces the old upload).
    await accounts.setAvatar(actorOf(f.member.id), await pngBuffer(80, 80, "#f5a524"));
    const replaced = await userRow(f.member.id);
    expect(replaced.avatarSource).toBe("custom");
    expect(replaced.avatarKey).toBe(replaced.customAvatarKey);
    expect(replaced.customAvatarKey).not.toBe(custom);
    expect(await storage().stat(custom)).toBeNull();

    await accounts.chooseAvatarSource(actorOf(f.member.id), { source: "discord" });
    expect((await userRow(f.member.id)).avatarKey).toBe(discordKey);
    // Choosing Discord needs a connected account.
    await expectAppError(accounts.chooseAvatarSource(actorOf(f.member2.id), { source: "discord" }), "VALIDATION");
  });
});

describe("refreshing a Discord profile", () => {
  it("picks up a new handle and picture, but never changes the studio name", async () => {
    const f = await setupStudio();
    const account = fakeAccount();
    await connect(f.member.id, account);
    await cacheDiscordAvatar(f.member.id);
    const before = (await linkOf(f.member.id))!.avatarKey!;

    account.user = { ...account.user, username: "renamed_on_discord", global_name: "New Discord Name", avatar: `a_${hash()}` };
    expect(await syncDiscordProfile(f.member.id, { force: true })).toBe("updated");
    const link = (await linkOf(f.member.id))!;
    expect(link).toMatchObject({ providerUsername: "renamed_on_discord", displayName: "New Discord Name", syncFailures: 0, syncError: null });
    // Animated pictures are fetched as a still (PNG).
    expect(calls).toContain(`GET https://cdn.discordapp.com/avatars/${account.user.id}/${account.user.avatar}.png`);
    expect(link.avatarKey).not.toBe(before);
    expect(await storage().stat(before)).toBeNull();
    expect((await userRow(f.member.id)).avatarKey).toBe(link.avatarKey);
    expect((await userRow(f.member.id)).displayName).toBe("Member");

    // Removing the Discord picture (Discord's default one) falls back to initials here.
    account.user = { ...account.user, avatar: null, global_name: null };
    await syncDiscordProfile(f.member.id, { force: true });
    const cleared = (await linkOf(f.member.id))!;
    expect(cleared).toMatchObject({ avatarHash: null, avatarKey: null, displayName: null });
    expect((await userRow(f.member.id)).avatarKey).toBeNull();
    expect((await accounts.getProfile(actorOf(f.member.id))).discordProfile).toMatchObject({ hasAvatar: false, avatarUrl: null });

    // Fresh profiles aren't fetched again until the interval passes.
    calls = [];
    expect(await syncDiscordProfile(f.member.id)).toBe("not-due");
    expect(calls).toEqual([]);
  });

  it("refreshes expired tokens, storing the rotated refresh token", async () => {
    const f = await setupStudio();
    const account = fakeAccount();
    await connect(f.member.id, account, 1);
    await db.update(oauthAccounts).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(oauthAccounts.userId, f.member.id));
    const oldRefresh = account.refreshToken;

    expect(["updated", "unchanged"]).toContain(await syncDiscordProfile(f.member.id, { force: true }));
    expect(calls.filter((c) => c === `POST ${API}/oauth2/token`)).toHaveLength(1);
    const link = (await linkOf(f.member.id))!;
    expect(unseal(link.refreshToken)).toBe(account.refreshToken);
    expect(account.refreshToken).not.toBe(oldRefresh);
    expect(link.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("asks to reconnect when Discord no longer accepts the authorization, keeping the last profile", async () => {
    const f = await setupStudio();
    const account = fakeAccount();
    await connect(f.member.id, account);
    // The person revoked Forge in Discord: both tokens stop working.
    accountsByToken.delete(account.accessToken);
    accountsByToken.delete(account.refreshToken);

    expect(await syncDiscordProfile(f.member.id, { force: true })).toBe("reconnect");
    const link = (await linkOf(f.member.id))!;
    expect(link).toMatchObject({ accessToken: null, refreshToken: null, providerUsername: account.user.username });
    expect(link.needsReauthAt).not.toBeNull();
    expect((await accounts.getProfile(actorOf(f.member.id))).discordProfile).toMatchObject({ state: "reconnect", username: account.user.username });
    // No background attempts until they reconnect.
    calls = [];
    expect(await syncDiscordProfile(f.member.id)).toBe("not-due");
    expect(calls).toEqual([]);

    // Reconnecting (the same Discord account, while signed in) restores syncing.
    const again = fakeAccount();
    again.user = { ...account.user };
    accountsByToken.set(again.accessToken, again);
    await connect(f.member.id, again);
    expect((await accounts.getProfile(actorOf(f.member.id))).discordProfile).toMatchObject({ state: "ok" });
    expect(await linkOf(f.member.id)).toMatchObject({ needsReauthAt: null });
  });

  it("backs off on rate limits and failures, keeping the last good profile", async () => {
    const f = await setupStudio();
    const account = fakeAccount();
    await connect(f.member.id, account);

    meAnswer = { status: 429, retryAfter: 120 };
    expect(await syncDiscordProfile(f.member.id, { force: true })).toBe("retry");
    let link = (await linkOf(f.member.id))!;
    expect(link.syncFailures).toBe(1);
    expect(link.nextSyncAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 115_000);
    expect(link.providerUsername).toBe(account.user.username);
    expect((await accounts.getProfile(actorOf(f.member.id))).discordProfile).toMatchObject({ state: "retrying" });

    meAnswer = { status: 503 };
    expect(await syncDiscordProfile(f.member.id, { force: true })).toBe("retry");
    link = (await linkOf(f.member.id))!;
    expect(link.syncFailures).toBe(2);
    expect(link.nextSyncAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 29 * 60_000);
    // Not due yet: nothing is requested.
    calls = [];
    expect(await syncDiscordProfile(f.member.id)).toBe("not-due");
    expect(calls).toEqual([]);

    meAnswer = null;
    await syncDiscordProfile(f.member.id, { force: true });
    expect(await linkOf(f.member.id)).toMatchObject({ syncFailures: 0, syncError: null });
  });

  it("runs one refresh at a time, so a rotating refresh token is used once", async () => {
    const f = await setupStudio();
    await connect(f.member.id, fakeAccount(), 1);
    await db.update(oauthAccounts).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(oauthAccounts.userId, f.member.id));
    tokenDelayMs = 150;
    const results = await Promise.all([syncDiscordProfile(f.member.id, { force: true }), syncDiscordProfile(f.member.id, { force: true }), syncDiscordProfile(f.member.id, { force: true })]);
    expect(results.filter((r) => r === "busy")).toHaveLength(2);
    expect(calls.filter((c) => c === `POST ${API}/oauth2/token`)).toHaveLength(1);
    expect((await linkOf(f.member.id))!.syncLeaseUntil).toBeNull();
  });

  it("never re-links: tokens answering for another Discord account ask to reconnect", async () => {
    const f = await setupStudio();
    const account = fakeAccount();
    await connect(f.member.id, account);
    account.user = { ...account.user, id: snowflake() };
    expect(await syncDiscordProfile(f.member.id, { force: true })).toBe("reconnect");
    expect((await linkOf(f.member.id))!.providerAccountId).not.toBe(account.user.id);
  });

  it("downloads pictures only from Discord's CDN, and only images", async () => {
    expect(() => discordAvatarCdnUrl("not-an-id", hash())).toThrow();
    expect(() => discordAvatarCdnUrl("123456789012345678", "../../evil")).toThrow();
    expect(discordAvatarCdnUrl("123456789012345678", `a_${"0".repeat(32)}`)).toBe(`https://cdn.discordapp.com/avatars/123456789012345678/a_${"0".repeat(32)}.png?size=256`);
    // Anything that isn't a well-formed hash is treated as no picture.
    expect(profileFromDiscordUser({ id: "1", username: "x", avatar: "https://evil.example/a.png" }).avatar).toBeNull();

    const f = await setupStudio();
    await connect(f.member.id, fakeAccount());
    cdn = { status: 200, type: "text/html" };
    expect(await cacheDiscordAvatar(f.member.id)).toBe("failed");
    expect((await linkOf(f.member.id))!.avatarKey).toBeNull();
    expect((await accounts.getProfile(actorOf(f.member.id))).discordProfile).toMatchObject({ state: "retrying" });
    cdn = { status: 404, type: "image/png" };
    expect(await cacheDiscordAvatar(f.member.id)).toBe("failed");
    cdn = { status: 200, type: "image/png" };
    expect(await cacheDiscordAvatar(f.member.id)).toBe("updated");
  });
});

describe("Discord names", () => {
  it("copies the Discord display name once (or the username), and never keeps it in sync", async () => {
    const f = await setupStudio();
    const account = fakeAccount({ global_name: "Lena F." });
    await connect(f.member.id, account);
    const before = await userRow(f.member.id);

    expect((await accounts.copyDiscordDisplayName(actorOf(f.member.id))).displayName).toBe("Lena F.");
    expect((await userRow(f.member.id)).username).toBe(before.username); // mentions keep working
    account.user = { ...account.user, global_name: "Someone Else" };
    await syncDiscordProfile(f.member.id, { force: true });
    expect((await userRow(f.member.id)).displayName).toBe("Lena F.");

    account.user = { ...account.user, global_name: null };
    await syncDiscordProfile(f.member.id, { force: true });
    expect((await accounts.copyDiscordDisplayName(actorOf(f.member.id))).displayName).toBe(account.user.username);
    await expectAppError(accounts.copyDiscordDisplayName(actorOf(f.member2.id)), "VALIDATION");
  });
});

describe("disconnecting and linking", () => {
  it("revokes access, removes the Discord picture and handle, and keeps the uploaded photo and name", async () => {
    const f = await setupStudio();
    await db.update(users).set({ passwordHash: "scrypt$1$1$1$x$y" }).where(eq(users.id, f.member.id));
    await accounts.setAvatar(actorOf(f.member.id), await pngBuffer(80, 80, "#22c3b6"));
    const custom = (await userRow(f.member.id)).customAvatarKey!;
    const account = fakeAccount();
    await connect(f.member.id, account);
    await accounts.chooseAvatarSource(actorOf(f.member.id), { source: "discord" });
    await cacheDiscordAvatar(f.member.id);
    const cached = (await linkOf(f.member.id))!.avatarKey!;
    await accounts.copyDiscordDisplayName(actorOf(f.member.id));
    const name = (await userRow(f.member.id)).displayName;

    await accounts.disconnectOAuth(actorOf(f.member.id), { provider: "discord" });
    expect(revoked).toEqual([account.refreshToken]);
    expect(await linkOf(f.member.id)).toBeUndefined();
    expect(await storage().stat(cached)).toBeNull();
    expect(await userRow(f.member.id)).toMatchObject({ avatarSource: "custom", avatarKey: custom, displayName: name });
    expect((await studios.listMembers(f.manager.actor, f.studioId)).find((m) => m.id === f.member.id)!.discord).toBeNull();
    // Nothing is refreshed any more.
    expect(await syncDiscordProfile(f.member.id, { force: true })).toBe("not-connected");
  });

  it("won't remove someone's only way to sign in", async () => {
    const f = await setupStudio();
    await connect(f.member.id, fakeAccount()); // fixture users have no password
    await expectAppError(accounts.disconnectOAuth(actorOf(f.member.id), { provider: "discord" }), "VALIDATION");
    expect(await linkOf(f.member.id)).toBeDefined();
  });

  it("links one Discord account to one Forge account, and one Discord account per person", async () => {
    const f = await setupStudio();
    const first = fakeAccount();
    await connect(f.member.id, first);
    await expectAppError(connect(f.member2.id, first), "CONFLICT"); // someone else's Discord
    await expectAppError(connect(f.member.id, fakeAccount()), "CONFLICT"); // a second Discord account
    expect((await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, f.member.id))).length).toBe(1);
    expect(await db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, f.member2.id))).toEqual([]);
    // Signing in with the linked Discord account reaches its own Forge account, and refreshes the profile.
    first.user = { ...first.user, username: "seen_at_sign_in" };
    const { session } = await connect(null, first);
    expect(session.token).toBeTruthy();
    expect((await linkOf(f.member.id))!.providerUsername).toBe("seen_at_sign_in");
  });
});

describe("who sees Discord details", () => {
  it("only people who may already see the member in that studio", async () => {
    const f = await setupStudio();
    await connect(f.member.id, fakeAccount());
    expect((await studios.memberProfile(f.viewer.actor, f.studioId, f.member.id)).discord).not.toBeNull();
    await expectAppError(studios.memberProfile(f.outsider.actor, f.studioId, f.member.id), "NOT_FOUND");
    await expectAppError(studios.memberProfile(f.outsider.actor, f.otherStudioId, f.member.id), "NOT_FOUND");
    // A projects-only collaborator on no shared project doesn't see them either.
    await db.update(studioMembers).set({ access: "PROJECTS" }).where(and(eq(studioMembers.studioId, f.studioId), eq(studioMembers.userId, f.member2.id)));
    await expectAppError(studios.memberProfile(f.member2.actor, f.studioId, f.member.id), "NOT_FOUND");
  });
});

describe("token encryption", () => {
  it("opens only what it sealed, with this server's key", () => {
    const sealed = seal("secret-token");
    expect(sealed).not.toContain("secret-token");
    expect(unseal(sealed)).toBe("secret-token");
    const [v, iv, tag, data] = sealed.split(".");
    expect(unseal([v, iv, tag, `${data!.slice(0, -2)}AA`].join("."))).toBeNull();
    expect(unseal("v2.x.y.z")).toBeNull();
    expect(unseal(null)).toBeNull();
  });
});
