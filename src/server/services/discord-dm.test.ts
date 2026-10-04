/**
 * Discord direct messages against a fake Discord API (no network). Fixtures are created here, in the
 * test database only.
 */
vi.hoisted(() => {
  process.env.DISCORD_APPLICATION_ID = "100000000000000001";
  process.env.DISCORD_CLIENT_ID = "100000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_API_BASE = "http://discord.test/api/v10";
});

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeOAuth } from "@/server/auth/oauth";
import { db } from "@/server/db";
import { discordDmDeliveries, notifications, oauthAccounts, users } from "@/server/db/schema";
import { expectAppError, pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as accounts from "./accounts";
import * as cardService from "./cards";
import * as dm from "./discord-dm";
import { runDueDateReminders } from "./due-dates";
import * as media from "./media";
import { notify, setNotificationPreference } from "./notifications";
import * as reviews from "./reviews";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
/** Replies for message posts, in order; once used up every post succeeds. */
let postReplies: Array<{ status: number; body: unknown }> = [];
let seq = 0;

beforeEach(async () => {
  calls = [];
  postReplies = [];
  // Each test sends only its own messages: anything an earlier test left queued is dropped.
  await db.update(discordDmDeliveries).set({ status: "SKIPPED" }).where(eq(discordDmDeliveries.status, "QUEUED"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/api/v10", "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ method, path, body });
      const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (method === "POST" && path === "/users/@me/channels") return json(200, { id: `dm${String(body?.recipient_id)}`, type: 1 });
      if (method === "POST" && /^\/channels\/[^/]+\/messages$/.test(path)) {
        const reply = postReplies.shift() ?? { status: 200, body: { id: `m${calls.length}` } };
        return json(reply.status, reply.body);
      }
      return json(404, { message: "Unknown", code: 0 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => calls.filter((c) => c.method === "POST" && c.path.startsWith("/channels/"));
const postsTo = (discordId: string) => posts().filter((c) => c.path === `/channels/dm${discordId}/messages`);
const opens = () => calls.filter((c) => c.path === "/users/@me/channels");

/** Connects a Discord account directly (the OAuth flow itself is tested below). */
async function link(userId: string) {
  const discordId = `3${String(Date.now()).slice(-9)}${String(++seq).padStart(8, "0")}`;
  await db.insert(oauthAccounts).values({ userId, provider: "discord", providerAccountId: discordId, providerUsername: `user${seq}` });
  return discordId;
}

const dmsFor = (userId: string) => db.select().from(discordDmDeliveries).where(eq(discordDmDeliveries.userId, userId)).orderBy(discordDmDeliveries.createdAt);

async function cardFor(f: Fixture, title: string, extra: { assigneeIds?: string[]; dueAt?: string } = {}) {
  return cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, ...extra });
}

async function mention(f: Fixture, userId: string, card: { id: string; key: string; title: string }, type: "MENTIONED" | "COMMENT" = "MENTIONED") {
  return db.transaction((tx) =>
    notify(tx, { recipientIds: [userId], actorId: f.owner.id, type, studioId: f.studioId, projectId: f.projectId, cardId: card.id, data: { cardKey: card.key, cardTitle: card.title } }),
  );
}

describe("Discord direct messages", () => {
  it("go to people who connected Discord, for the fixed list of notifications, with who and what only", async () => {
    const f = await setupStudio();
    const reviewerDiscord = await link(f.manager.id);
    const card = await cardFor(f, "@everyone Boss **arena**", { assigneeIds: [f.member.id] });
    const version = await media.createVersion(f.member.actor, { cardId: card.id });
    await upload(f.member.actor, card.id, { name: "v1.png", type: "image/png", buffer: await pngBuffer() }, "version", version.id);
    await reviews.submitForReview(f.member.actor, { deliverableId: await primaryDeliverable(card.id), note: "secret note text" });

    expect((await dmsFor(f.manager.id)).map((d) => d.status)).toEqual(["QUEUED"]); // the review request
    expect(await dmsFor(f.member.id)).toEqual([]); // not connected (and the actor)
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ sent: 1 });
    expect(opens()[0]!.body).toEqual({ recipient_id: reviewerDiscord });
    const [post] = posts();
    expect(post!.path).toBe(`/channels/dm${reviewerDiscord}/messages`);
    const message = post!.body as {
      embeds: Array<{ author: { name: string }; title: string; description: string; url: string; fields: Array<{ name: string; value: string }>; footer: { text: string } }>;
      allowed_mentions: unknown;
      components: Array<{ components: Array<{ url: string; label: string }> }>;
    };
    const embed = message.embeds[0]!;
    expect(message.allowed_mentions).toEqual({ parse: [] }); // the card title can't ping anyone
    expect(embed.author.name).toBe("\ud83d\udce5 Review requested");
    expect(embed.title).toBe(`${card.key} @everyone Boss **arena**`);
    expect(embed.description).toMatch(/^\*\*.+\*\* submitted \*\*V1\*\* for your review\.$/); // without repeating the card
    expect(embed.fields.map((field) => field.name)).toEqual(["Project"]); // no deadline on this card
    expect(embed.url).toContain(`card=${card.key}`);
    expect(message.components[0]!.components[0]).toMatchObject({ label: "Review in Forge", url: embed.url });
    expect(JSON.stringify(message)).not.toContain("secret note text");

    // Other types aren't sent as DMs; the DM channel is reused.
    await mention(f, f.manager.id, card, "COMMENT");
    expect((await dmsFor(f.manager.id)).length).toBe(1);
    await mention(f, f.manager.id, card);
    await dm.processDiscordDmDeliveries();
    expect(opens().length).toBe(1);
    expect(posts().length).toBe(2);
  });

  it("go out even when every other channel is off for that type", async () => {
    const f = await setupStudio();
    await link(f.member.id);
    await setNotificationPreference(f.member.actor, { type: "MENTIONED", inApp: false, push: false, email: false });
    const card = await cardFor(f, "Quiet card");
    await mention(f, f.member.id, card);
    const [row] = await dmsFor(f.member.id);
    expect(row?.status).toBe("QUEUED");
    const [n] = await db.select().from(notifications).where(eq(notifications.id, row!.notificationId!));
    expect(n!.inbox).toBe(false); // still not in their inbox
  });

  it("bundle deadline reminders that are due together into one message", async () => {
    const f = await setupStudio();
    const discordId = await link(f.member.id);
    const soon = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    const late = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const a = await cardFor(f, "Sword model", { assigneeIds: [f.member.id], dueAt: soon });
    const b = await cardFor(f, "Shield model", { assigneeIds: [f.member.id], dueAt: late });
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ sent: 2 }); // "assigned to you", one each
    const before = postsTo(discordId).length;

    await runDueDateReminders();
    const queued = (await dmsFor(f.member.id)).filter((d) => d.status === "QUEUED");
    expect(queued.length).toBe(2);
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ sent: 2 });
    const bundle = postsTo(discordId).slice(before);
    expect(bundle.length).toBe(1);
    const embed = (bundle[0]!.body as { embeds: Array<{ title: string; description: string; url: string }> }).embeds[0]!;
    expect(embed.title).toBe("1 overdue, 1 due within 24 hours");
    expect(embed.description.indexOf(b.title)).toBeLessThan(embed.description.indexOf(a.title)); // most urgent first
    expect(embed.description).toMatch(/was due <t:\d+:R>/);
    expect(embed.description).toMatch(/⏰ \[.+\]\(.+\) · due <t:\d+:R>/);
    expect(embed.description).toMatch(/^🚨 /); // overdue first
    expect(embed.url).toMatch(/\/calendar$/);
    const sent = (await dmsFor(f.member.id)).filter((d) => queued.some((q) => q.id === d.id));
    expect(new Set(sent.map((r) => r.messageId)).size).toBe(1);
  });

  it("pause when Discord refuses, say why, and resume when Try again works", async () => {
    const f = await setupStudio();
    await link(f.member.id);
    const card = await cardFor(f, "Unreachable");
    await mention(f, f.member.id, card);
    postReplies = [{ status: 403, body: { message: "Cannot send messages to this user", code: 50007 } }];
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ failed: 1 });
    const status = await dm.discordDmStatus(f.member.id);
    expect(status).toMatchObject({ available: true, active: false, paused: true, reason: dm.DM_UNREACHABLE });

    await mention(f, f.member.id, card);
    expect((await dmsFor(f.member.id)).length).toBe(1); // nothing new queued while paused

    postReplies = [{ status: 403, body: { message: "Cannot send messages to this user", code: 50007 } }];
    await expectAppError(dm.retryDiscordDms(f.member.actor), "VALIDATION");
    expect((await dm.discordDmStatus(f.member.id)).paused).toBe(true);
    expect(await dm.retryDiscordDms(f.member.actor)).toMatchObject({ active: true, paused: false });
    await mention(f, f.member.id, card);
    expect((await dmsFor(f.member.id)).length).toBe(2);
  });

  it("wait out rate limits and retry outages", async () => {
    const f = await setupStudio();
    await link(f.member.id);
    await mention(f, f.member.id, await cardFor(f, "Busy"));
    postReplies = [{ status: 429, body: { message: "You are being rate limited.", retry_after: 1.5 } }];
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ retried: 1 });
    const [row] = await dmsFor(f.member.id);
    expect(row!.status).toBe("QUEUED");
    expect(row!.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(1000);
    expect(row!.nextAttemptAt.getTime() - Date.now()).toBeLessThan(5000);
    expect((await dm.discordDmStatus(f.member.id)).paused).toBe(false);
  });

  it("re-check the work when sending", async () => {
    const f = await setupStudio();
    await link(f.member.id);
    const card = await cardFor(f, "Archived before sending");
    await mention(f, f.member.id, card);
    await cardService.setCardArchived(f.manager.actor, { cardId: card.id, archived: true });
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ skipped: 1, sent: 0 });
    expect(posts()).toEqual([]);
  });

  it("start with a welcome when someone connects Discord, and stop when they disconnect", async () => {
    const f = await setupStudio();
    const [person] = await db.select().from(users).where(eq(users.id, f.member2.id));
    await completeOAuth("discord", { id: "399999999999999991", email: person!.email, emailVerified: true, username: "member2", displayName: "Member Two" }, f.member2.id, { ip: null, userAgent: null });
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ sent: 1 });
    expect((posts()[0]!.body as { embeds: Array<{ title: string }> }).embeds[0]!.title).toBe("Forge is connected");
    expect(opens()[0]!.body).toEqual({ recipient_id: "399999999999999991" });

    await mention(f, f.member2.id, await cardFor(f, "Before disconnecting"));
    await db.update(users).set({ passwordHash: "test-only" }).where(eq(users.id, f.member2.id)); // another way to sign in
    const profile = await accounts.disconnectOAuth(f.member2.actor, { provider: "discord" });
    expect(profile.oauth).toEqual([]);
    expect(profile.discordDms.active).toBe(false);
    expect((await dmsFor(f.member2.id)).filter((d) => d.status === "QUEUED")).toEqual([]); // queued ones are dropped
    await mention(f, f.member2.id, await cardFor(f, "After disconnecting"));
    expect((await dmsFor(f.member2.id)).filter((d) => d.status === "QUEUED")).toEqual([]);
    expect(await dm.processDiscordDmDeliveries()).toMatchObject({ sent: 0 });
  });

  it("never lets someone disconnect their only way to sign in", async () => {
    const f = await setupStudio();
    await link(f.member.id);
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, f.member.id));
    await expectAppError(accounts.disconnectOAuth(f.member.actor, { provider: "discord" }), "VALIDATION");
    const [still] = await db.select().from(oauthAccounts).where(and(eq(oauthAccounts.userId, f.member.id), eq(oauthAccounts.provider, "discord")));
    expect(still).toBeDefined();
  });
});
