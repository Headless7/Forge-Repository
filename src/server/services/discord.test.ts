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
import { cards, discordConnections, discordRoutes, users } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as board from "./board";
import * as cardService from "./cards";
import * as discord from "./discord";
import * as media from "./media";
import * as production from "./production";
import * as projects from "./projects";
import * as reviews from "./reviews";

/** Each test gets its own server, so studios from other tests never share it. */
let guild = { id: "", name: "Test Guild", icon: null as string | null };
let guildSeq = 0;
const REVIEWS = "800000000000000001";
const RELEASES = "800000000000000002";

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
  guild = { id: `9${String(Date.now()).slice(-9)}${String(++guildSeq).padStart(8, "0")}`, name: "Test Guild", icon: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/api/v10", "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (init.headers as Record<string, string>)["Content-Type"]?.includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body)) : null;
      calls.push({ method, path, body, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
      const json = (status: number, payload: unknown) => new Response(payload === null ? null : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (method === "POST" && path === "/oauth2/token") return json(200, { access_token: "x", token_type: "Bearer", guild });
      if (method === "GET" && path === `/guilds/${guild.id}/channels`) {
        return json(200, [
          { id: "700000000000000001", name: "Text", type: 4, position: 0, parent_id: null },
          { id: REVIEWS, name: "reviews", type: 0, position: 0, parent_id: "700000000000000001" },
          { id: RELEASES, name: "releases", type: 5, position: 1, parent_id: "700000000000000001" },
          { id: "800000000000000009", name: "Voice", type: 2, position: 2, parent_id: null },
        ]);
      }
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

async function connect(f: Fixture) {
  const start = await discord.beginDiscordConnect(f.admin.id, f.studioId);
  const state = new URL(start.url).searchParams.get("state");
  return discord.completeDiscordConnect({ userId: f.admin.id, cookie: start.cookie, state, code: "code" });
}

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
    expect(status).toMatchObject({ configured: true, canConnect: false, connection: { guildName: "Test Guild", lost: false } });
    expect((await discord.discordStatus(f.admin.actor, f.studioId)).canConnect).toBe(true);
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

  it("disconnecting removes every feed; the bot leaves once no studio uses the server", async () => {
    const f = await setupStudio();
    const other = await setupStudio();
    await connect(f);
    await connect(other); // the same Discord server, connected from a second studio
    await discord.saveDiscordFeed(f.manager.actor, { projectId: f.projectId, boardId: null, channelId: REVIEWS, events: ["APPROVED"], confirmPrivate: false });
    const leaves = () => calls.filter((c) => c.method === "DELETE" && c.path === `/users/@me/guilds/${guild.id}`).length;
    await expectAppError(discord.disconnectDiscord(f.manager.actor, f.studioId), "FORBIDDEN");

    await discord.disconnectDiscord(f.owner.actor, f.studioId);
    expect(await db.select().from(discordRoutes).where(eq(discordRoutes.studioId, f.studioId))).toEqual([]);
    expect(await db.select().from(discordConnections).where(eq(discordConnections.studioId, f.studioId))).toEqual([]);
    expect(leaves()).toBe(0); // the other studio still posts there
    expect((await discord.discordStatus(other.member.actor, other.studioId)).connection).not.toBeNull();

    await discord.disconnectDiscord(other.admin.actor, other.studioId);
    expect(leaves()).toBe(1);
  });
});
