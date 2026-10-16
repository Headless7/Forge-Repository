/**
 * Discord team feeds against a fake Discord API (no network). Fixtures are created here, in the
 * test database only.
 */
vi.hoisted(() => {
  process.env.DISCORD_APPLICATION_ID = "100000000000000001";
  process.env.DISCORD_CLIENT_ID = "100000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_API_BASE = "http://discord.test/api/v10";
});

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { cards, discordConnections, discordRoutes, projects as projectRows, users } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as discord from "./discord";
import * as media from "./media";
import * as production from "./production";
import * as projects from "./projects";
import * as reviews from "./reviews";

/** Each test gets its own servers, so studios from other tests never share them. */
let guild = { id: "", name: "Test Guild", icon: null as string | null };
/** A second server, with channels of its own. */
let other = { id: "", name: "Community", icon: null as string | null };
/** A third server, for the "first server again" cases. */
let third = { id: "", name: "Playtesters", icon: null as string | null };
/** The server Discord says Forge was just added to. */
let connecting = guild;
/** Servers that answer as if the bot was removed. */
let gone = new Set<string>();
let guildSeq = 0;
const REVIEWS = "800000000000000001";
const RELEASES = "800000000000000002";
const COMMUNITY_NEWS = "810000000000000001";
const COMMUNITY_DEVLOG = "810000000000000002";
const PLAYTEST = "820000000000000001";

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}
let calls: Call[] = [];
/** Responses for message posts, in order; once used up every post succeeds. */
let postReplies: Array<{ status: number; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  postReplies = [];
  gone = new Set();
  const id = () => `9${String(Date.now()).slice(-9)}${String(++guildSeq).padStart(8, "0")}`;
  guild = { id: id(), name: "Test Guild", icon: null };
  other = { id: id(), name: "Community", icon: null };
  third = { id: id(), name: "Playtesters", icon: null };
  connecting = guild;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/v10", "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (init.headers as Record<string, string>)["Content-Type"]?.includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body)) : null;
      calls.push({ method, path, body, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
      const json = (status: number, payload: unknown) => new Response(payload === null ? null : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (method === "POST" && path === "/oauth2/token") return json(200, { access_token: "x", token_type: "Bearer", guild: connecting });
      const listed = /^\/guilds\/(\d+)\/channels$/.exec(path)?.[1];
      if (method === "GET" && listed && gone.has(listed)) return json(404, { message: "Unknown Guild", code: 10004 });
      if (method === "GET" && path === `/guilds/${guild.id}/channels`) {
        return json(200, [
          { id: "700000000000000001", name: "Text", type: 4, position: 0, parent_id: null },
          { id: REVIEWS, name: "reviews", type: 0, position: 0, parent_id: "700000000000000001" },
          { id: RELEASES, name: "releases", type: 5, position: 1, parent_id: "700000000000000001" },
          { id: "800000000000000009", name: "Voice", type: 2, position: 2, parent_id: null },
        ]);
      }
      if (method === "GET" && path === `/guilds/${other.id}/channels`) {
        return json(200, [
          { id: COMMUNITY_NEWS, name: "news", type: 5, position: 0, parent_id: null },
          { id: COMMUNITY_DEVLOG, name: "devlog", type: 0, position: 1, parent_id: null },
        ]);
      }
      if (method === "GET" && path === `/guilds/${third.id}/channels`) return json(200, [{ id: PLAYTEST, name: "playtest", type: 0, position: 0, parent_id: null }]);
      if (method === "POST" && /^\/channels\/\d+\/messages$/.test(path)) {
        const reply = postReplies.shift() ?? { status: 200, body: { id: `m${calls.length}` } };
        return json(reply.status, reply.body);
      }
      if (method === "DELETE" && /^\/users\/@me\/guilds\/\d+$/.test(path)) return new Response(null, { status: 204 });
      return json(404, { message: "Unknown", code: 0 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => calls.filter((c) => c.method === "POST" && c.path.startsWith("/channels/"));

/** "Add to server" for the fixture's studio, the way Discord's install screen finishes it. */
async function connect(f: Fixture, server = guild) {
  connecting = server;
  const start = await discord.beginDiscordConnect(f.admin.id, f.studioId);
  const state = new URL(start.url).searchParams.get("state");
  return discord.completeDiscordConnect({ userId: f.admin.id, cookie: start.cookie, state, code: "code" });
}

const serverOf = async (projectId: string) => (await db.select({ guildId: projectRows.discordGuildId }).from(projectRows).where(eq(projectRows.id, projectId)))[0]!.guildId;

async function approvedWorkFixture(f: Fixture, title: string) {
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id] });
  const version = await media.createVersion(f.member.actor, { cardId: card.id });
  await upload(f.member.actor, card.id, { name: "v1.png", type: "image/png", buffer: await pngBuffer() }, "version", version.id);
  return { card, deliverableId: await primaryDeliverable(card.id) };
}

describe("connecting a Discord server", () => {
  it("is for Admins and the Owner, checks the signed state, and takes the server from Discord", async () => {
    const f = await setupStudio();
    await expectAppError(discord.beginDiscordConnect(f.manager.id, f.studioId), "FORBIDDEN");
    await expectAppError(discord.beginDiscordConnect(f.outsider.id, f.studioId), "NOT_FOUND");

    const start = await discord.beginDiscordConnect(f.admin.id, f.studioId);
    const params = new URL(start.url).searchParams;
    expect(params.get("scope")).toBe("bot applications.commands"); // the bot and its commands, nothing else
    expect(params.get("permissions")).toBe(String(1024 + 2048 + 16384)); // view, send, embed links only
    expect(params.get("redirect_uri")).toMatch(/\/api\/integrations\/discord\/callback$/);
    const state = params.get("state");

    // Forged or mismatched state, or someone else finishing it, is refused.
    await expectAppError(discord.completeDiscordConnect({ userId: f.admin.id, cookie: `${start.cookie}x`, state, code: "c" }), "VALIDATION");
    await expectAppError(discord.completeDiscordConnect({ userId: f.admin.id, cookie: start.cookie, state: "other", code: "c" }), "VALIDATION");
    await expectAppError(discord.completeDiscordConnect({ userId: f.owner.id, cookie: start.cookie, state, code: "c" }), "VALIDATION");

    const done = await discord.completeDiscordConnect({ userId: f.admin.id, cookie: start.cookie, state, code: "c" });
    expect(done.guildName).toBe("Test Guild");
    const status = await discord.discordStatus(f.member.actor, f.studioId);
    expect(status).toMatchObject({ configured: true, canConnect: false, servers: [{ guildId: guild.id, guildName: "Test Guild", lost: false, projects: [] }] }); // members don't get the project lists
    const forAdmin = await discord.discordStatus(f.admin.actor, f.studioId);
    expect(forAdmin.canConnect).toBe(true);
    expect(forAdmin.servers[0]!.projects.map((p) => p.id)).toContain(f.projectId);
  });
});

describe("Discord feeds", () => {
  it("are managed by Managers and above, only for real channels, with private projects confirmed", async () => {
    const f = await setupStudio();
    await connect(f);
    const channels = await discord.listDiscordChannels(f.manager.actor, f.projectId);
    expect(channels.map((c) => [c.name, c.category])).toEqual([
      ["reviews", "Text"],
      ["releases", "Text"],
    ]); // text and announcement channels, not voice
    await expectAppError(discord.listDiscordChannels(f.member.actor, f.projectId), "FORBIDDEN");
    await expectAppError(discord.saveDiscordFeed(f.member.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false }), "FORBIDDEN");
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: "800000000000000077", events: ["APPROVED"], confirmPrivate: false }), "VALIDATION");
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: [], confirmPrivate: false }), "VALIDATION");

    const feed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED", "APPROVED"], confirmPrivate: false });
    expect(feed).toMatchObject({ channelName: "reviews", events: ["REVIEW_SUBMITTED", "APPROVED"], privateProject: false });
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false }), "CONFLICT");

    const secret = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Secret ${Date.now()}`, template: "empty", visibility: "PRIVATE" });
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: secret.id, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false }), "VALIDATION");
    const confirmed = await discord.saveDiscordFeed(f.manager.actor, { projectId: secret.id, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: true });
    expect(confirmed).toMatchObject({ privateProject: true, privateConfirmed: true });

    expect((await discord.listProjectFeeds(f.manager.actor, f.projectId)).length).toBe(1);
    expect((await discord.listStudioFeeds(f.admin.actor, f.studioId)).length).toBe(2);
    await expectAppError(discord.listStudioFeeds(f.manager.actor, f.studioId), "FORBIDDEN");
  });

  it("queue review and production events with the change, once per feed, and post them safely", async () => {
    const f = await setupStudio();
    await connect(f);
    const all = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED", "CHANGES_REQUESTED", "APPROVED"], confirmPrivate: false });
    const releases = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: RELEASES, events: ["COMPLETED", "PUBLISHED"], confirmPrivate: false });
    const second = await board.createBoard(f.manager.actor, { projectId: f.projectId, name: "Second" });
    const otherBoard = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: second.id, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });

    const { card, deliverableId } = await approvedWorkFixture(f, "@everyone Boss **arena** [click](http://evil)");
    await reviews.submitForReview(f.member.actor, { deliverableId, note: "secret note text" });
    expect((await discord.discordDeliveriesFor(all.id)).map((d) => d.status)).toEqual(["QUEUED"]);
    expect(await discord.discordDeliveriesFor(otherBoard.id)).toEqual([]); // another board's feed
    expect(await discord.discordDeliveriesFor(releases.id)).toEqual([]); // not its events

    expect(await discord.processDiscordDeliveries()).toMatchObject({ sent: 1 });
    const [post] = posts();
    expect(post!.path).toBe(`/channels/${REVIEWS}/messages`);
    expect(post!.auth).toBe("Bot test-bot-token");
    const message = post!.body as {
      embeds: Array<{ author: { name: string }; title: string; description: string; url: string; fields: Array<{ name: string; value: string }> }>;
      allowed_mentions: { parse: unknown[] };
      components: unknown[];
    };
    expect(message.allowed_mentions).toEqual({ parse: [] }); // never pings anyone
    expect(message.embeds[0]!.author.name).toBe("📥 Submitted for review");
    expect(message.embeds[0]!.title).toContain("Boss **arena**");
    expect(message.embeds[0]!.description).toMatch(/submitted \*\*V1\*\* for review/);
    const [member] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, f.member.id));
    expect(message.embeds[0]!.fields).toEqual([{ name: "Assigned", value: member!.name, inline: true }]); // who's on it (no deadline set)
    expect(JSON.stringify(message)).not.toContain("secret note text"); // no comment or note text
    expect(message.embeds[0]!.url).toMatch(new RegExp(`/b/1\\?card=[A-Z0-9]+-${(await db.select().from(cards).where(eq(cards.id, card.id)))[0]!.number}$`));
    expect(message.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: "Review in Forge", url: message.embeds[0]!.url }] }]);

    await reviews.approve(f.manager.actor, { deliverableId });
    await production.moveProduction(f.manager.actor, { cardId: card.id, status: "COMPLETED" });
    await discord.processDiscordDeliveries();
    const later = posts().slice(1);
    expect(later.map((p) => p.path)).toEqual([`/channels/${REVIEWS}/messages`, `/channels/${RELEASES}/messages`]);
    expect((later[1]!.body as { embeds: Array<{ description: string }> }).embeds[0]!.description).toContain("**Completed**");
    expect((await db.select().from(discordRoutes).where(eq(discordRoutes.id, all.id)))[0]!.lastSentAt).not.toBeNull();
  });

  it("wait out rate limits, retry outages, and report broken channels on the feed", async () => {
    const f = await setupStudio();
    await connect(f);
    const feed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    const submit = async (title: string) => {
      const { deliverableId } = await approvedWorkFixture(f, title);
      await reviews.submitForReview(f.member.actor, { deliverableId });
    };

    await submit("Rate limited");
    postReplies = [{ status: 429, body: { message: "You are being rate limited.", retry_after: 1.5, global: false } }];
    expect(await discord.processDiscordDeliveries()).toMatchObject({ retried: 1 });
    const [limited] = await discord.discordDeliveriesFor(feed.id);
    expect(limited!.status).toBe("QUEUED");
    expect(limited!.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(1000); // waits as long as asked
    expect(limited!.nextAttemptAt.getTime() - Date.now()).toBeLessThan(5000);

    await db.delete(discordRoutes).where(eq(discordRoutes.id, feed.id));
    const fresh = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    await submit("Server error");
    postReplies = [{ status: 502, body: { message: "Bad gateway" } }];
    expect(await discord.processDiscordDeliveries()).toMatchObject({ retried: 1 });

    await db.delete(discordRoutes).where(eq(discordRoutes.id, fresh.id));
    const broken = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    await submit("No permission");
    postReplies = [{ status: 403, body: { message: "Missing Permissions", code: 50013 } }];
    expect(await discord.processDiscordDeliveries()).toMatchObject({ failed: 1 });
    const [feedAfter] = await discord.listProjectFeeds(f.manager.actor, f.projectId);
    expect(feedAfter!.id).toBe(broken.id);
    expect(feedAfter!.lastError).toMatch(/can't post in #reviews/);

    await submit("Channel deleted");
    postReplies = [{ status: 404, body: { message: "Unknown Channel", code: 10003 } }];
    await discord.processDiscordDeliveries();
    expect((await discord.listProjectFeeds(f.manager.actor, f.projectId))[0]!.lastError).toMatch(/no longer exists/);
  });

  it("re-check the card and the project when sending, and skip what no longer applies", async () => {
    const f = await setupStudio();
    await connect(f);
    const feed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    const { card, deliverableId } = await approvedWorkFixture(f, "Archived before sending");
    await reviews.submitForReview(f.member.actor, { deliverableId });
    await cardService.setCardArchived(f.manager.actor, { cardId: card.id, archived: true });
    expect(await discord.processDiscordDeliveries()).toMatchObject({ skipped: 1, sent: 0 });
    expect((await discord.discordDeliveriesFor(feed.id))[0]!.error).toMatch(/archived/);

    // A project made private later stops posting until someone confirms the channel.
    const { deliverableId: d2 } = await approvedWorkFixture(f, "Now private");
    await reviews.submitForReview(f.member.actor, { deliverableId: d2 });
    await projects.updateProject(f.owner.actor, { projectId: f.projectId, visibility: "PRIVATE" });
    expect(await discord.processDiscordDeliveries()).toMatchObject({ skipped: 1, sent: 0 });
    expect(posts()).toEqual([]);
  });

  it("send one daily deadline summary per feed, and nothing when nothing is due", async () => {
    const f = await setupStudio();
    await connect(f);
    const feed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["DUE_DIGEST"], confirmPrivate: false });
    const morning = new Date();
    morning.setUTCHours(10, 0, 0, 0);
    const early = new Date(morning);
    early.setUTCHours(6);
    expect(await discord.runDiscordDueDigests(early)).toBe(0); // before 09:00 UTC

    expect(await discord.runDiscordDueDigests(morning)).toBe(1);
    expect(await discord.processDiscordDeliveries()).toMatchObject({ skipped: 1 }); // nothing due: no message
    expect(await discord.runDiscordDueDigests(new Date(morning.getTime() + 60 * 60_000))).toBe(0); // once a day

    const next = new Date(morning.getTime() + 24 * 60 * 60_000);
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Late thing", assigneeIds: [f.member.id], dueAt: new Date(next.getTime() - 2 * 24 * 60 * 60_000).toISOString() });
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Tomorrow thing", dueAt: new Date(next.getTime() + 24 * 60 * 60_000).toISOString() });
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Next month", dueAt: new Date(next.getTime() + 30 * 24 * 60 * 60_000).toISOString() });
    expect(await discord.runDiscordDueDigests(next)).toBe(1);
    expect(await discord.processDiscordDeliveries()).toMatchObject({ sent: 1 });
    const embed = (posts()[0]!.body as { embeds: Array<{ author: { name: string }; title: string; description: string }> }).embeds[0]!;
    const [member] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, f.member.id));
    expect(embed.author.name).toBe("📅 Daily deadlines");
    expect(embed.title).toMatch(/1 overdue, 1 due soon/);
    // Overdue first; Discord shows the times in each reader's time zone; who's on each card.
    expect(embed.description.split("\n")[0]).toMatch(new RegExp(`^🚨 \\[.*Late thing\\]\\(.+\\) · was due <t:\\d+:R> · ${member!.name}$`));
    expect(embed.description.split("\n")[1]).toMatch(/^⏰ \[.*Tomorrow thing\]\(.+\) · due <t:\d+:R>$/);
    expect(embed.description).not.toContain("Next month");
    expect(await discord.discordDeliveriesFor(feed.id)).toHaveLength(2);
  });

  it("disconnecting removes the server's feeds; the bot leaves once no studio uses the server", async () => {
    const f = await setupStudio();
    const second = await setupStudio();
    await connect(f);
    await connect(second); // the same Discord server, connected from a second studio
    await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false });
    const leaves = () => calls.filter((c) => c.method === "DELETE" && c.path === `/users/@me/guilds/${guild.id}`).length;
    await expectAppError(discord.disconnectDiscord(f.manager.actor, f.studioId, guild.id), "FORBIDDEN");

    await discord.disconnectDiscord(f.owner.actor, f.studioId, guild.id);
    expect(await db.select().from(discordRoutes).where(eq(discordRoutes.studioId, f.studioId))).toEqual([]);
    expect(await db.select().from(discordConnections).where(eq(discordConnections.studioId, f.studioId))).toEqual([]);
    expect(await serverOf(f.projectId)).toBeNull();
    expect(leaves()).toBe(0); // the other studio still posts there
    expect((await discord.discordStatus(second.member.actor, second.studioId)).servers).toHaveLength(1);
    expect(await serverOf(second.projectId)).toBe(guild.id);

    await discord.disconnectDiscord(second.admin.actor, second.studioId, guild.id);
    expect(leaves()).toBe(1);
    // Disconnecting a server that isn't connected is a no-op.
    await discord.disconnectDiscord(second.admin.actor, second.studioId, guild.id);
    expect(leaves()).toBe(1);
  });
});

describe("several Discord servers in one studio", () => {
  const submitted = async (f: Fixture, projectId: string, columnId: string, title: string) => {
    const card = await cardService.createCard(f.manager.actor, { projectId, columnId, title, assigneeIds: [f.member.id] });
    const version = await media.createVersion(f.member.actor, { cardId: card.id });
    await upload(f.member.actor, card.id, { name: "v1.png", type: "image/png", buffer: await pngBuffer() }, "version", version.id);
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id) });
    return card;
  };
  /** A second project in the fixture's studio, with one column to put cards in. */
  const secondProject = async (f: Fixture, name: string) => {
    const project = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `${name} ${Date.now()}` });
    const view = await board.getBoard(f.owner.actor, project.id);
    return { id: project.id, columnId: view.columns[0]!.id };
  };

  it("connect side by side: the first server becomes every project's server, later ones nobody's until chosen", async () => {
    const f = await setupStudio();
    const before = await secondProject(f, "Before Discord");
    expect(await serverOf(f.projectId)).toBeNull();

    await connect(f, guild);
    expect(await serverOf(f.projectId)).toBe(guild.id);
    expect(await serverOf(before.id)).toBe(guild.id);
    const onlyOne = await secondProject(f, "With one server");
    expect(await serverOf(onlyOne.id)).toBe(guild.id); // exactly one server: new projects use it

    await connect(f, other);
    const status = await discord.discordStatus(f.admin.actor, f.studioId);
    expect(status.servers.map((s) => s.guildName)).toEqual(["Test Guild", "Community"]); // oldest first; nothing replaced
    expect(status.servers[1]!.projects).toEqual([]);
    expect(await serverOf(f.projectId)).toBe(guild.id); // existing projects keep theirs
    const withTwo = await secondProject(f, "With two servers");
    expect(await serverOf(withTwo.id)).toBeNull(); // several: none until an Admin picks

    // Connecting a server again only refreshes it.
    await connect(f, { ...guild, name: "Renamed Guild" });
    const again = await discord.discordStatus(f.admin.actor, f.studioId);
    expect(again.servers.map((s) => s.guildName)).toEqual(["Community", "Renamed Guild"]);
    expect(await serverOf(f.projectId)).toBe(guild.id);
  });

  it("only studio Admins and the Owner choose a project's server, among the studio's reachable ones", async () => {
    const f = await setupStudio();
    const outside = await setupStudio();
    await connect(f, guild);
    await connect(f, other);
    await connect(outside, third); // connected to another studio only

    await expectAppError(discord.setProjectDiscordServer(f.manager.actor, { projectId: f.projectId, guildId: other.id }), "FORBIDDEN");
    await expectAppError(discord.setProjectDiscordServer(f.member.actor, { projectId: f.projectId, guildId: other.id }), "FORBIDDEN");
    await expectAppError(discord.setProjectDiscordServer(f.outsider.actor, { projectId: f.projectId, guildId: other.id }), "NOT_FOUND");
    await expectAppError(discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: third.id }), "VALIDATION");
    await expectAppError(discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: "123456789012345678" }), "VALIDATION");

    const moved = await discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: other.id });
    expect(moved).toMatchObject({ server: { guildId: other.id, guildName: "Community", lost: false }, canChooseServer: true });
    expect((await discord.projectDiscord(f.manager.actor, f.projectId)).canChooseServer).toBe(false);
    await expectAppError(discord.projectDiscord(f.member.actor, f.projectId), "FORBIDDEN");
    expect((await discord.listDiscordChannels(f.manager.actor, f.projectId)).map((c) => c.name)).toEqual(["news", "devlog"]);

    // No server: no channels to pick, no feeds to add.
    expect((await discord.setProjectDiscordServer(f.owner.actor, { projectId: f.projectId, guildId: null })).server).toBeNull();
    await expectAppError(discord.listDiscordChannels(f.manager.actor, f.projectId), "VALIDATION");
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false }), "VALIDATION");

    // A server Forge can't reach can't be chosen.
    await db.update(discordConnections).set({ lostAt: new Date() }).where(eq(discordConnections.guildId, other.id));
    await expectAppError(discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: other.id }), "VALIDATION");

    // Archived projects keep theirs.
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: guild.id });
    await projects.setProjectArchived(f.owner.actor, { projectId: f.projectId, archived: true });
    await expectAppError(discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: null }), "CONFLICT");
  });

  it("feeds post to the project's server; switching pauses them, switching back resumes them, editing one moves it", async () => {
    const f = await setupStudio();
    await connect(f, guild);
    await connect(f, other);
    const studioFeed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED", "DUE_DIGEST"], confirmPrivate: false });
    expect(studioFeed).toMatchObject({ guildId: guild.id, guildName: "Test Guild", paused: false });
    // Channels of another server are refused.
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: COMMUNITY_NEWS, events: ["APPROVED"], confirmPrivate: false }), "VALIDATION");

    await discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: other.id });
    const [paused] = await discord.listProjectFeeds(f.manager.actor, f.projectId);
    expect(paused).toMatchObject({ id: studioFeed.id, paused: true, guildName: "Test Guild" });
    expect(await discord.testDiscordFeed(f.manager.actor, studioFeed.id)).toMatchObject({ ok: false, error: expect.stringMatching(/paused/) });
    await submitted(f, f.projectId, f.columns.vfx, "While paused");
    expect(await discord.discordDeliveriesFor(studioFeed.id)).toEqual([]); // nothing queued for a paused feed
    const morning = new Date();
    morning.setUTCHours(10, 0, 0, 0);
    expect(await discord.runDiscordDueDigests(morning)).toBe(0); // no summary either

    const community = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: COMMUNITY_NEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    expect(community).toMatchObject({ guildId: other.id, paused: false });
    await submitted(f, f.projectId, f.columns.vfx, "Community news");
    expect(await discord.processDiscordDeliveries()).toMatchObject({ sent: 1 });
    expect(posts().map((p) => p.path)).toEqual([`/channels/${COMMUNITY_NEWS}/messages`]);

    // Back to the first server: its feed resumes, the community one pauses.
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: guild.id });
    expect((await discord.listProjectFeeds(f.manager.actor, f.projectId)).map((x) => [x.channelName, x.paused])).toEqual([
      ["reviews", false],
      ["news", true],
    ]);
    await submitted(f, f.projectId, f.columns.vfx, "Back home");
    await discord.processDiscordDeliveries();
    expect(posts().map((p) => p.path).slice(1)).toEqual([`/channels/${REVIEWS}/messages`]);
    expect(await discord.testDiscordFeed(f.manager.actor, studioFeed.id)).toEqual({ ok: true, error: null });

    // Editing a paused feed moves it to the project's server; "last posted" was about the old channel.
    expect((await discord.listProjectFeeds(f.manager.actor, f.projectId)).find((x) => x.id === community.id)!.lastSentAt).not.toBeNull();
    const movedFeed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, feedId: community.id, boardId: null, channelId: RELEASES, events: ["APPROVED"], confirmPrivate: false });
    expect(movedFeed).toMatchObject({ id: community.id, guildId: guild.id, channelName: "releases", paused: false, lastSentAt: null });
    // Changing only what a feed posts keeps its history.
    const kept = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, feedId: studioFeed.id, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false });
    expect(kept.lastSentAt).not.toBeNull();
  });

  it("a private project confirms the channel again when a feed moves to another server", async () => {
    const f = await setupStudio();
    await connect(f, guild);
    await connect(f, other);
    const secret = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Secret ${Date.now()}`, template: "empty", visibility: "PRIVATE" });
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: secret.id, guildId: guild.id });
    const feed = await discord.saveDiscordFeed(f.manager.actor, { projectId: secret.id, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: true });
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: secret.id, guildId: other.id });
    await expectAppError(discord.saveDiscordFeed(f.manager.actor, { projectId: secret.id, feedId: feed.id, boardId: null, channelId: COMMUNITY_NEWS, events: ["APPROVED"], confirmPrivate: false }), "VALIDATION");
    const moved = await discord.saveDiscordFeed(f.manager.actor, { projectId: secret.id, feedId: feed.id, boardId: null, channelId: COMMUNITY_NEWS, events: ["APPROVED"], confirmPrivate: true });
    expect(moved).toMatchObject({ guildId: other.id, channelName: "news", privateConfirmed: true, paused: false });
  });

  it("doesn't post what was queued before the project switched servers", async () => {
    const f = await setupStudio();
    await connect(f, guild);
    await connect(f, other);
    const feed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    await submitted(f, f.projectId, f.columns.vfx, "Queued then switched");
    expect((await discord.discordDeliveriesFor(feed.id)).map((d) => d.status)).toEqual(["QUEUED"]);
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: f.projectId, guildId: other.id });
    expect(await discord.processDiscordDeliveries()).toMatchObject({ skipped: 1, sent: 0 });
    expect((await discord.discordDeliveriesFor(feed.id))[0]!.error).toMatch(/another Discord server/);
    expect(posts()).toEqual([]);
  });

  it("disconnecting one server removes only its feeds; the next first server goes to projects without one", async () => {
    const f = await setupStudio();
    const p2 = await secondProject(f, "Community game");
    await connect(f, guild); // both projects start on it
    await connect(f, other);
    const homeFeed = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false });
    const leftBehind = await discord.saveDiscordFeed(f.manager.actor, { projectId: p2.id, boardId: null, channelId: RELEASES, events: ["APPROVED"], confirmPrivate: false });
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: p2.id, guildId: other.id }); // its first feed is now paused
    const communityFeed = await discord.saveDiscordFeed(f.manager.actor, { projectId: p2.id, boardId: null, channelId: COMMUNITY_DEVLOG, events: ["APPROVED"], confirmPrivate: false });
    const studioFeeds = await discord.listStudioFeeds(f.admin.actor, f.studioId);
    expect(studioFeeds.map((x) => [x.channelName, x.guildName, x.paused]).sort()).toEqual([
      ["devlog", "Community", false],
      ["releases", "Test Guild", true],
      ["reviews", "Test Guild", false],
    ]);
    const leaves = (id: string) => calls.filter((c) => c.method === "DELETE" && c.path === `/users/@me/guilds/${id}`).length;

    await discord.disconnectDiscord(f.admin.actor, f.studioId, guild.id);
    const left = await db.select({ id: discordRoutes.id }).from(discordRoutes).where(eq(discordRoutes.studioId, f.studioId));
    expect(left.map((r) => r.id)).toEqual([communityFeed.id]); // its feeds, paused ones too, are gone
    expect([homeFeed.id, leftBehind.id].some((id) => left.some((r) => r.id === id))).toBe(false);
    expect(await serverOf(f.projectId)).toBeNull();
    expect(await serverOf(p2.id)).toBe(other.id);
    expect(leaves(guild.id)).toBe(1);
    expect(leaves(other.id)).toBe(0);
    expect((await discord.discordStatus(f.admin.actor, f.studioId)).servers.map((s) => s.guildName)).toEqual(["Community"]);

    // Connecting another server while one is left isn't "the first": nothing is assigned.
    await connect(f, third);
    expect(await serverOf(f.projectId)).toBeNull();
    // With none left, the next server connected is the first again and goes to projects without one.
    await discord.disconnectDiscord(f.admin.actor, f.studioId, other.id);
    await discord.disconnectDiscord(f.admin.actor, f.studioId, third.id);
    expect(await serverOf(p2.id)).toBeNull();
    await connect(f, third);
    expect(await serverOf(f.projectId)).toBe(third.id);
    expect(await serverOf(p2.id)).toBe(third.id);
  });

  it("a server Forge loses pauses only its own projects' feeds, until it's reconnected", async () => {
    const f = await setupStudio();
    const p2 = await secondProject(f, "Second game");
    await connect(f, guild);
    await connect(f, other);
    await discord.setProjectDiscordServer(f.admin.actor, { projectId: p2.id, guildId: other.id });
    const home = await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });
    const community = await discord.saveDiscordFeed(f.manager.actor, { projectId: p2.id, boardId: null, channelId: COMMUNITY_NEWS, events: ["REVIEW_SUBMITTED"], confirmPrivate: false });

    gone.add(guild.id);
    await expectAppError(discord.listDiscordChannels(f.manager.actor, f.projectId), "VALIDATION"); // finds out the bot was removed
    const status = await discord.discordStatus(f.admin.actor, f.studioId);
    expect(status.servers.map((s) => [s.guildName, s.lost])).toEqual([
      ["Test Guild", true],
      ["Community", false],
    ]);
    expect((await discord.projectDiscord(f.manager.actor, f.projectId)).server).toMatchObject({ lost: true });
    await submitted(f, f.projectId, f.columns.vfx, "Lost server");
    await submitted(f, p2.id, p2.columnId, "Still reachable");
    expect(await discord.discordDeliveriesFor(home.id)).toEqual([]);
    expect(await discord.discordDeliveriesFor(community.id)).toHaveLength(1);
    expect(await discord.testDiscordFeed(f.manager.actor, home.id)).toMatchObject({ ok: false, error: expect.stringMatching(/can't reach/) });

    gone.delete(guild.id);
    await connect(f, guild); // reconnecting clears it
    expect((await discord.projectDiscord(f.manager.actor, f.projectId)).server).toMatchObject({ guildId: guild.id, lost: false });
    await submitted(f, f.projectId, f.columns.vfx, "Found again");
    expect(await discord.discordDeliveriesFor(home.id)).toHaveLength(1);
  });
});
