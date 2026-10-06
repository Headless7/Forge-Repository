/**
 * Discord slash commands against signed fake requests (no network). Fixtures are created here, in
 * the test database only. The key pair below exists only for these tests.
 */
vi.hoisted(() => {
  process.env.DISCORD_APPLICATION_ID = "100000000000000001";
  process.env.DISCORD_CLIENT_ID = "100000000000000001";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_BOT_TOKEN = "test-bot-token";
  process.env.DISCORD_API_BASE = "http://discord.test/api/v10";
  process.env.DISCORD_PUBLIC_KEY = "9eb640bf360c2570308f3612ecaf62398e8075e9f50ddf48dd3e7a4c7a4fc844";
});

import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/discord/interactions/route";
import { db } from "@/server/db";
import { cards, comments, deliverables, discordDmDeliveries, discordDmRecipients, oauthAccounts, reviews as reviewRows } from "@/server/db/schema";
import { pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import { DISCORD_COMMANDS, handleInteraction, syncDiscordCommands, type Interaction, type InteractionResponse } from "./discord-commands";
import { verifyDiscordSignature } from "./discord-interactions";
import * as media from "./media";
import * as reviews from "./reviews";

const APP = "100000000000000001";
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY!;
const PRIVATE_KEY = crypto.createPrivateKey({
  key: { kty: "OKP", crv: "Ed25519", d: "p2bTLQOR-GMLNKRW3pcVxsCKpEeEUb9sXtbBHOikp1w", x: Buffer.from(PUBLIC_KEY, "hex").toString("base64url") },
  format: "jwk",
});

let seq = 0;
const nextId = () => `${Date.now()}${String(++seq).padStart(4, "0")}`;

function signedRequest(body: unknown, options: { at?: number; tamper?: boolean; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(options.at ?? Math.floor(Date.now() / 1000));
  const signature = options.signature ?? crypto.sign(null, Buffer.from(timestamp + raw), PRIVATE_KEY).toString("hex");
  return new Request("http://localhost/api/discord/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body: options.tamper ? raw.replace("mywork", "reviews") : raw,
  });
}

/**
 * Connects Discord for a fixture user. Their direct messages start paused: these tests don't send
 * any, and queued ones would be picked up by the direct-message tests running alongside.
 */
async function link(userId: string) {
  const discordId = `${7_000_000_000_000_000n + BigInt(++seq) * 1000n + BigInt(Date.now() % 1000)}`;
  await db.insert(oauthAccounts).values({ userId, provider: "discord", providerAccountId: discordId, providerUsername: "tester" });
  await db.insert(discordDmRecipients).values({ userId, discordUserId: discordId, pausedAt: new Date(), pausedReason: "Paused for the slash-command tests." });
  return discordId;
}

const base = (who: string): Pick<Interaction, "id" | "application_id" | "member"> => ({ id: nextId(), application_id: APP, member: { user: { id: who } } });
const command = (who: string, name: string, options: Array<{ name: string; type: number; value: string | number | boolean; focused?: boolean }> = []) =>
  handleInteraction({ ...base(who), type: 2, data: { name, options } });
const click = (who: string, customId: string, values?: string[]) => handleInteraction({ ...base(who), type: 3, data: { custom_id: customId, values } });
const text = (response: InteractionResponse) => JSON.stringify(response);
function buttons(response: InteractionResponse): string[] {
  if (!("data" in response) || !("components" in response.data)) return [];
  const rows = response.data.components as Array<{ components: Array<{ custom_id?: string; url?: string }> }>;
  return rows.flatMap((row) => row.components.map((c) => c.custom_id ?? `link:${c.url ?? ""}`));
}
const description = (response: InteractionResponse) => ("data" in response && "embeds" in response.data ? (response.data.embeds[0]?.description ?? "") : "");

async function stateOf(deliverableId: string) {
  return (await db.select({ state: deliverables.state }).from(deliverables).where(eq(deliverables.id, deliverableId)))[0]!.state;
}

/** A card the manager assigns to the member, with a submitted first revision. */
async function submittedCard(f: Fixture, title: string, extra: { dueAt?: string } = {}) {
  const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title, assigneeIds: [f.member.id], ...extra });
  const version = await media.createVersion(f.member.actor, { cardId: card.id });
  await upload(f.member.actor, card.id, { name: "v1.png", type: "image/png", buffer: await pngBuffer() }, "version", version.id);
  const deliverableId = await primaryDeliverable(card.id);
  await reviews.submitForReview(f.member.actor, { deliverableId });
  return { card, deliverableId };
}

beforeEach(() => {
  // Nothing in these tests may reach Discord.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "offline" }), { status: 503 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("the interactions endpoint", () => {
  it("answers only requests Discord signed, recently, once, for this application", async () => {
    const ping = await POST(signedRequest({ id: nextId(), application_id: APP, type: 1 }));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ type: 1 });

    const body = { id: nextId(), application_id: APP, type: 2, member: { user: { id: "7000000000000000001" } }, data: { name: "mywork" } };
    expect((await POST(signedRequest(body, { tamper: true }))).status).toBe(401);
    expect((await POST(signedRequest(body, { signature: "ab".repeat(64) }))).status).toBe(401);
    expect((await POST(signedRequest(body, { at: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    const unsigned = new Request("http://localhost/api/discord/interactions", { method: "POST", body: JSON.stringify(body) });
    expect((await POST(unsigned)).status).toBe(401);
    expect((await POST(signedRequest({ ...body, id: nextId(), application_id: "999999999999999999" }))).status).toBe(401);

    const first = await POST(signedRequest(body));
    expect(first.status).toBe(200);
    // The very same signed request again (a replay) is refused.
    expect((await POST(signedRequest(body))).status).toBe(401);
  });

  it("checks Ed25519 signatures over the timestamp and body", () => {
    const at = Math.floor(Date.now() / 1000);
    const body = Buffer.from('{"type":1}');
    const signature = crypto.sign(null, Buffer.concat([Buffer.from(String(at)), body]), PRIVATE_KEY).toString("hex");
    expect(verifyDiscordSignature(PUBLIC_KEY, signature, String(at), body)).toBe(true);
    expect(verifyDiscordSignature(PUBLIC_KEY, signature, String(at + 1), body)).toBe(false);
    expect(verifyDiscordSignature(PUBLIC_KEY, signature, String(at), Buffer.from('{"type":2}'))).toBe(false);
    expect(verifyDiscordSignature("00".repeat(32), signature, String(at), body)).toBe(false);
    expect(verifyDiscordSignature(PUBLIC_KEY, "zz", String(at), body)).toBe(false);
  });
});

describe("Discord slash commands", () => {
  it("ask people who haven't connected Discord to do that first", async () => {
    const reply = await command("7999999999999999999", "mywork");
    expect(reply).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    expect(text(reply)).toContain("Connect Discord to Forge");
    expect(text(reply)).toContain("/account/security");
  });

  it("/mywork shows only the person's own open work, privately, and never pings", async () => {
    const f = await setupStudio();
    const who = await link(f.member.id);
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "@everyone **Boss** arena", assigneeIds: [f.member.id], dueAt: new Date(Date.now() - 86_400_000).toISOString() });
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Someone else's sword", assigneeIds: [f.member2.id] });
    await cardService.createCard(f.outsider.actor, { projectId: f.otherProjectId, columnId: f.otherColumnId, title: "Other studio's arena" });

    const reply = await command(who, "mywork");
    expect(reply).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    const out = text(reply);
    expect(out).toContain("1 open deliverable");
    expect(out).toContain("1 overdue");
    expect(out).toContain("🚨");
    expect(out).not.toContain("Someone else");
    expect(out).not.toContain("Other studio");
    // What people typed can't format the message or mention anyone (menu labels are plain text anyway).
    const shown = description(reply);
    expect(shown).toContain("@​everyone");
    expect(shown).toContain("\\*\\*Boss\\*\\*");
    expect(shown).not.toMatch(/[^\\]\*\*Boss/);
    // A single-deliverable card's line doesn't repeat its title.
    expect(shown.split("Boss").length - 1).toBe(1);
    expect(buttons(reply)).toContain("fg:pick");
  });

  it("/reviews lists work submitted for the person to decide, not their own", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const member = await link(f.member.id);
    await submittedCard(f, "Shield");

    const managerReply = text(await command(manager, "reviews"));
    expect(managerReply).toContain("1 waiting for your review");
    expect(managerReply).toContain("Shield");
    expect(managerReply).toContain("V1");
    // The member did the work (and can't review): nothing for them.
    expect(text(await command(member, "reviews"))).toContain("Nothing waiting for your review");
  });

  it("/card finds a card by key and offers only what the person may do", async () => {
    const f = await setupStudio();
    const [manager, viewer, outsider] = await Promise.all([link(f.manager.id), link(f.viewer.id), link(f.outsider.id)]);
    const { card, deliverableId } = await submittedCard(f, "Lantern");

    const managerCard = await command(manager, "card", [{ name: "card", type: 3, value: card.key }]);
    expect(buttons(managerCard)).toEqual(expect.arrayContaining([`fg:approve:${deliverableId}`, `fg:changes:${deliverableId}`]));
    expect(text(managerCard)).toContain("Lantern");

    const viewerCard = await command(viewer, "card", [{ name: "card", type: 3, value: card.key.toLowerCase() }]);
    expect(text(viewerCard)).toContain("Lantern");
    expect(buttons(viewerCard).filter((b) => b.startsWith("fg:"))).toEqual([]);

    expect(text(await command(outsider, "card", [{ name: "card", type: 3, value: card.key }]))).toContain("No card you can see matches");
    expect(text(await command(outsider, "card", [{ name: "card", type: 3, value: card.id }]))).not.toContain("Lantern");
  });

  it("approve asks first, then approves as the person", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const { deliverableId } = await submittedCard(f, "Crown");

    const confirm = await click(manager, `fg:approve:${deliverableId}`);
    expect(confirm.type).toBe(7);
    expect(text(confirm)).toContain("Approve **V1** of");
    expect(buttons(confirm)).toContain(`fg:approve!:${deliverableId}`);
    expect(await stateOf(deliverableId)).toBe("NEEDS_REVIEW");

    const done = await click(manager, `fg:approve!:${deliverableId}`);
    expect(text(done)).toContain("✅ You approved");
    expect(await stateOf(deliverableId)).toBe("APPROVED");
    const [decision] = await db.select().from(reviewRows).where(and(eq(reviewRows.deliverableId, deliverableId), eq(reviewRows.action, "APPROVED")));
    expect(decision?.actorId).toBe(f.manager.id);
  });

  it("refuse actions the person isn't allowed, even from a crafted button", async () => {
    const f = await setupStudio();
    const [viewer, member, outsider] = await Promise.all([link(f.viewer.id), link(f.member.id), link(f.outsider.id)]);
    const { card, deliverableId } = await submittedCard(f, "Totem");

    expect(text(await click(viewer, `fg:approve!:${deliverableId}`))).toContain("⚠️");
    // The member did the work, and the project doesn't allow approving your own.
    expect(text(await click(member, `fg:approve!:${deliverableId}`))).toContain("⚠️");
    const outsiderTry = text(await click(outsider, `fg:approve!:${deliverableId}`));
    expect(outsiderTry).toContain("⚠️");
    expect(outsiderTry).not.toContain("Totem");
    expect(text(await click(outsider, `fg:complete!:${card.id}`))).not.toContain("Totem");
    expect(text(await click(viewer, `fg:changes:${deliverableId}`))).toContain("isn't waiting for your review");
    expect(text(await click(viewer, "fg:approve!:not-a-real-id"))).toContain("no longer works");
    expect(await stateOf(deliverableId)).toBe("NEEDS_REVIEW");
  });

  it("request changes opens a form, and each line becomes a feedback item", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const { deliverableId } = await submittedCard(f, "Banner");

    const form = await click(manager, `fg:changes:${deliverableId}`);
    expect(form).toMatchObject({ type: 9, data: { custom_id: `fg:changes!:${deliverableId}` } });

    const done = await handleInteraction({
      ...base(manager),
      type: 5,
      data: { custom_id: `fg:changes!:${deliverableId}`, components: [{ components: [{ custom_id: "items", value: "Fix the hilt\n- Brighter glow\n\n" }] }] },
    });
    expect(text(done)).toContain("🔁 You requested changes");
    expect(text(done)).toContain("2 feedback items");
    expect(await stateOf(deliverableId)).toBe("CHANGES_REQUESTED");
    const feedback = await db.select({ body: comments.body }).from(comments).where(and(eq(comments.deliverableId, deliverableId), eq(comments.kind, "FEEDBACK")));
    expect(feedback.map((c) => c.body).sort()).toEqual(["Brighter glow", "Fix the hilt"]);
  });

  it("submit for review and mark completed go through the same rules", async () => {
    const f = await setupStudio();
    const [member, manager] = await Promise.all([link(f.member.id), link(f.manager.id)]);
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Helmet", assigneeIds: [f.member.id] });
    const version = await media.createVersion(f.member.actor, { cardId: card.id });
    await upload(f.member.actor, card.id, { name: "v1.png", type: "image/png", buffer: await pngBuffer() }, "version", version.id);
    const deliverableId = await primaryDeliverable(card.id);

    const memberCard = await command(member, "card", [{ name: "card", type: 3, value: card.key }]);
    expect(buttons(memberCard)).toContain(`fg:submit:${deliverableId}`);
    expect(buttons(memberCard)).not.toContain(`fg:complete:${card.id}`);
    expect(text(await click(member, `fg:submit:${deliverableId}`))).toContain("for review?");
    expect(text(await click(member, `fg:submit!:${deliverableId}`))).toContain("📥 You submitted");
    expect(await stateOf(deliverableId)).toBe("NEEDS_REVIEW");

    await click(manager, `fg:approve!:${deliverableId}`);
    const ready = await click(manager, `fg:open:${card.id}`);
    expect(buttons(ready)).toContain(`fg:complete:${card.id}`);
    expect(text(await click(manager, `fg:complete!:${card.id}`))).toContain("Marked **Completed**");
    const [row] = await db.select({ status: cards.productionStatus }).from(cards).where(eq(cards.id, card.id));
    expect(row?.status).toBe("COMPLETED");
    // Their direct messages are paused here, so nothing is queued for the DM tests to pick up.
    expect(await db.select().from(discordDmDeliveries).where(inArray(discordDmDeliveries.userId, [f.member.id, f.manager.id]))).toEqual([]);
  });

  it("autocomplete suggests only cards the person can see", async () => {
    const f = await setupStudio();
    const member = await link(f.member.id);
    const word = `Zephyr${seq}`;
    const mine = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: `${word} cape` });
    const theirs = await cardService.createCard(f.outsider.actor, { projectId: f.otherProjectId, columnId: f.otherColumnId, title: `${word} cloak` });

    const reply = await handleInteraction({ ...base(member), type: 4, data: { name: "card", options: [{ name: "card", type: 3, value: word, focused: true }] } });
    expect(reply.type).toBe(8);
    const values = "data" in reply && "choices" in reply.data ? reply.data.choices.map((c) => c.value) : [];
    expect(values).toContain(mine.id);
    expect(values).not.toContain(theirs.id);
    // Not connected: no suggestions at all.
    expect(await handleInteraction({ ...base("7999999999999999998"), type: 4, data: { name: "card", options: [{ name: "card", type: 3, value: word, focused: true }] } })).toEqual({ type: 8, data: { choices: [] } });
  });

  it("/due shows the person's deadlines; the team's are for Managers and above", async () => {
    const f = await setupStudio();
    const [member, manager] = await Promise.all([link(f.member.id), link(f.manager.id)]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Mine due soon", assigneeIds: [f.member.id], dueAt: tomorrow });
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Theirs due soon", assigneeIds: [f.member2.id], dueAt: tomorrow });

    const own = text(await command(member, "due"));
    expect(own).toContain("Mine due soon");
    expect(own).not.toContain("Theirs due soon");

    const asked = text(await command(member, "due", [{ name: "everyone", type: 5, value: true }]));
    expect(asked).toContain("for Managers and above");
    expect(asked).not.toContain("Theirs due soon");

    const team = text(await command(manager, "due", [{ name: "everyone", type: 5, value: true }, { name: "days", type: 4, value: 2 }]));
    expect(team).toContain("Mine due soon");
    expect(team).toContain("Theirs due soon");
    expect(team).toContain("Team deadlines");
  });
});

describe("command registration", () => {
  it("registers the commands only when they differ from Discord's", async () => {
    let registered: unknown[] = [];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        if (method === "PUT") registered = (JSON.parse(String(init!.body)) as Array<Record<string, unknown>>).map((c, i) => ({ ...c, id: `${i}`, application_id: APP, version: "1", default_member_permissions: null, nsfw: false }));
        return new Response(JSON.stringify(registered), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    expect(await syncDiscordCommands()).toBe("updated");
    expect(await syncDiscordCommands()).toBe("unchanged");
    expect(calls).toEqual(["GET", "PUT", "GET"]);
  });

  it("keep to Discord's limits", () => {
    for (const c of DISCORD_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(100);
      for (const o of ("options" in c ? c.options : []) ?? []) expect(String(o.description).length).toBeLessThanOrEqual(100);
    }
  });
});
