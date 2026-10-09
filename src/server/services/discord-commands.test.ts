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
import { cards, checklistItems, checklists, comments, deliverables, discordDmDeliveries, discordDmRecipients, oauthAccounts, projects, reviews as reviewRows } from "@/server/db/schema";
import { pngBuffer, primaryDeliverable, setupStudio, upload, type Fixture } from "@/test/helpers";
import * as cardService from "./cards";
import { DISCORD_COMMANDS, handleInteraction, LAYOUT_LIMITS, layoutSize, parseDueDay, syncDiscordCommands, type Interaction, type InteractionResponse } from "./discord-commands";
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

type Node = { type?: number; content?: string; custom_id?: string; url?: string; components?: Node[]; accessory?: Node };
function walk(response: InteractionResponse, visit: (node: Node) => void) {
  const go = (node: Node) => {
    visit(node);
    for (const child of node.components ?? []) go(child);
    if (node.accessory) go(node.accessory);
  };
  if ("data" in response && "components" in response.data) for (const block of response.data.components as Node[]) go(block);
}
/** Every button: its custom id, or "link:<url>". */
function buttons(response: InteractionResponse): string[] {
  const out: string[] = [];
  walk(response, (n) => n.type === 2 && out.push(n.custom_id ?? `link:${n.url ?? ""}`));
  return out;
}
/** All the text a reply shows (Discord markdown). */
function shownText(response: InteractionResponse): string {
  const out: string[] = [];
  walk(response, (n) => n.type === 10 && n.content && out.push(n.content));
  return out.join("\n");
}
/** Replies must fit Discord's limits and keep custom ids unique, or Discord refuses them. */
function expectValidLayout(response: InteractionResponse) {
  if (!("data" in response) || !("components" in response.data)) return;
  const size = layoutSize(response.data.components);
  expect(size.components).toBeLessThanOrEqual(LAYOUT_LIMITS.components);
  expect(size.text).toBeLessThanOrEqual(LAYOUT_LIMITS.text);
  const ids = buttons(response).filter((b) => !b.startsWith("link:"));
  expect(new Set(ids).size).toBe(ids.length);
}

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
    expect(reply).toMatchObject({ type: 4, data: { flags: 64 | 32768, allowed_mentions: { parse: [] } } });
    expect(text(reply)).toContain("Connect Discord to Forge");
    expect(text(reply)).toContain("/account/security");
  });

  it("/mywork shows only the person's own open work, privately, and never pings", async () => {
    const f = await setupStudio();
    const who = await link(f.member.id);
    const boss = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "@everyone **Boss** arena", assigneeIds: [f.member.id], dueAt: new Date(Date.now() - 86_400_000).toISOString() });
    await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Someone else's sword", assigneeIds: [f.member2.id] });
    await cardService.createCard(f.outsider.actor, { projectId: f.otherProjectId, columnId: f.otherColumnId, title: "Other studio's arena" });

    const reply = await command(who, "mywork");
    expect(reply).toMatchObject({ type: 4, data: { flags: 64 | 32768, allowed_mentions: { parse: [] } } });
    const out = text(reply);
    expect(out).toContain("1 open deliverable");
    expect(out).toContain("1 overdue");
    expect(out).toContain("🚨");
    expect(out).not.toContain("Someone else");
    expect(out).not.toContain("Other studio");
    expect(out).toContain("Overdue");
    // What people typed can't format the message or mention anyone.
    const shown = shownText(reply);
    expect(shown).toContain("@​everyone");
    expect(shown).toContain("\\*\\*Boss\\*\\*");
    expect(shown).not.toMatch(/[^\\]\*\*Boss/);
    // A single-deliverable card's line doesn't repeat its title.
    expect(shown.split("Boss").length - 1).toBe(1);
    expect(buttons(reply)).toContain(`fg:open:${boss.id}`);
    expectValidLayout(reply);
  });

  it("/reviews lists work submitted for the person to decide, not their own", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const member = await link(f.member.id);
    await submittedCard(f, "Shield");

    const managerReplyRaw = await command(manager, "reviews");
    expectValidLayout(managerReplyRaw);
    const managerReply = text(managerReplyRaw);
    expect(managerReply).toContain("Waiting for your review");
    expect(managerReply).toContain("1 submission");
    expect(managerReply).toContain("Shield");
    expect(managerReply).toContain("V1");
    // The member did the work (and can't review): nothing for them.
    expect(text(await command(member, "reviews"))).toContain("Nothing waiting for your review");
  });

  it("/card finds a card by key and offers only what the person may do", async () => {
    const f = await setupStudio();
    const [manager, viewer, outsider] = await Promise.all([link(f.manager.id), link(f.viewer.id), link(f.outsider.id)]);
    const { card, deliverableId } = await submittedCard(f, "Lantern");

    const managerCard = await command(manager, "card", [{ name: "find", type: 3, value: card.key }]);
    expectValidLayout(managerCard);
    expect(buttons(managerCard)).toEqual(expect.arrayContaining([`fg:approve:${deliverableId}`, `fg:changes:${deliverableId}`]));
    expect(text(managerCard)).toContain("Lantern");

    // "card" was the option's first name: replies still work for clients that haven't refreshed.
    const viewerCard = await command(viewer, "card", [{ name: "card", type: 3, value: card.key.toLowerCase() }]);
    expect(text(viewerCard)).toContain("Lantern");
    expect(buttons(viewerCard).filter((b) => b.startsWith("fg:"))).toEqual([]);

    expect(text(await command(outsider, "card", [{ name: "find", type: 3, value: card.key }]))).toContain("No card you can see matches");
    expect(text(await command(outsider, "card", [{ name: "find", type: 3, value: card.id }]))).not.toContain("Lantern");
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

    const memberCard = await command(member, "card", [{ name: "find", type: 3, value: card.key }]);
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

    const reply = await handleInteraction({ ...base(member), type: 4, data: { name: "card", options: [{ name: "find", type: 3, value: word, focused: true }] } });
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

    const asked = text(await command(member, "due", [{ name: "team", type: 5, value: true }]));
    expect(asked).toContain("for Managers and above");
    expect(asked).not.toContain("Theirs due soon");

    const teamReply = await command(manager, "due", [{ name: "team", type: 5, value: true }, { name: "days", type: 4, value: 2 }]);
    expectValidLayout(teamReply);
    const team = text(teamReply);
    expect(team).toContain("Mine due soon");
    expect(team).toContain("Theirs due soon");
    expect(team).toContain("Team deadlines");
  });
});

describe("/newcard", () => {
  const opt = (name: string, value: string, focused = false) => ({ name, type: 3, value, ...(focused ? { focused: true } : {}) });
  const suggest = async (who: string, options: ReturnType<typeof opt>[]) => {
    const reply = await handleInteraction({ ...base(who), type: 4, data: { name: "newcard", options } });
    return "data" in reply && "choices" in reply.data ? reply.data.choices : [];
  };

  it("creates a card where the person can, with suggestions for project, column, people and dates", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const projects = await suggest(manager, [opt("title", "Sword VFX"), opt("project", "", true)]);
    expect(projects.map((c) => c.value)).toContain(f.projectId);
    expect(projects.map((c) => c.value)).not.toContain(f.otherProjectId);
    const columns = await suggest(manager, [opt("project", f.projectId), opt("column", "ui", true)]);
    expect(columns).toEqual([expect.objectContaining({ value: f.columns.ui })]);
    const people = await suggest(manager, [opt("project", f.projectId), opt("assign", "member", true)]);
    expect(people.map((c) => c.value)).toEqual(expect.arrayContaining([f.member.id, f.member2.id]));
    expect(people.map((c) => c.value)).not.toContain(f.outsider.id);
    const days = await suggest(manager, [opt("project", f.projectId), opt("due", "", true)]);
    // On a Friday, "Friday" (the next one) and "In 1 week" are the same day and are offered once.
    const labels = days.map((c) => c.name.split(" · ")[0]);
    expect(labels.slice(0, 3)).toEqual(["Today", "Tomorrow", "Friday"]);
    expect(labels).toContain("In 2 weeks");
    expect(new Set(days.map((c) => c.value)).size).toBe(days.length);

    const reply = await command(manager, "newcard", [
      opt("title", "@here Sword **VFX**"),
      opt("project", f.projectId),
      opt("column", f.columns.ui),
      opt("assign", f.member.id),
      opt("due", "2026-12-04"),
      opt("priority", "HIGH"),
      opt("description", "Glow trail on swing"),
    ]);
    expectValidLayout(reply);
    expect(shownText(reply)).toContain("🆕 Created");
    const [card] = await db.select().from(cards).where(and(eq(cards.projectId, f.projectId), eq(cards.title, "@here Sword **VFX**")));
    expect(card).toMatchObject({ columnId: f.columns.ui, priority: "HIGH", description: "Glow trail on swing", createdById: f.manager.id });
    expect(card!.dueAt?.toISOString()).toBe("2026-12-04T18:00:00.000Z");
    expect(shownText(reply)).toContain("@​here");
    expect(buttons(reply).some((b) => b.startsWith("link:") && b.includes(`?card=`))).toBe(true);
  });

  it("uses the first column by default, understands typed names, and refuses what the app would", async () => {
    const f = await setupStudio();
    const [member, viewer, outsider] = await Promise.all([link(f.member.id), link(f.viewer.id), link(f.outsider.id)]);
    const [{ name: projectName }] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, f.projectId));

    // Typed (not picked) project name, "me", a weekday; no column given → the first one.
    const reply = await command(member, "newcard", [opt("title", "Shield model"), opt("project", projectName.toLowerCase()), opt("assign", "me"), opt("due", "friday")]);
    expect(shownText(reply)).toContain("🆕 Created");
    const [card] = await db.select().from(cards).where(and(eq(cards.projectId, f.projectId), eq(cards.title, "Shield model")));
    expect(card!.columnId).toBe(f.columns.vfx);
    expect(new Date(card!.dueAt!).getUTCDay()).toBe(5);

    // Contributors can only assign themselves (as in the app).
    expect(shownText(await command(member, "newcard", [opt("title", "x"), opt("project", f.projectId), opt("assign", f.member2.id)]))).toContain("only to yourself");
    expect(await suggest(member, [opt("project", f.projectId), opt("assign", "", true)])).toEqual([{ name: "Me", value: "me" }]);
    // Viewers can't create cards; people outside the studio don't see its projects.
    expect(shownText(await command(viewer, "newcard", [opt("title", "x"), opt("project", f.projectId)]))).toContain("can't create cards");
    expect(shownText(await command(outsider, "newcard", [opt("title", "x"), opt("project", f.projectId)]))).toContain("Choose a project");
    expect(shownText(await command(member, "newcard", [opt("title", "x"), opt("project", f.projectId), opt("due", "someday")]))).toContain("didn't understand that deadline");
    expect(await db.select().from(cards).where(and(eq(cards.projectId, f.projectId), eq(cards.title, "x")))).toEqual([]);
  });

  it("reads deadlines the way people type them", () => {
    const wednesday = new Date("2026-10-07T15:00:00Z");
    expect(parseDueDay("today", wednesday)).toBe("2026-10-07");
    expect(parseDueDay("Tomorrow", wednesday)).toBe("2026-10-08");
    expect(parseDueDay("friday", wednesday)).toBe("2026-10-09");
    expect(parseDueDay("fri", wednesday)).toBe("2026-10-09");
    expect(parseDueDay("wednesday", wednesday)).toBe("2026-10-14"); // the next one, not today
    expect(parseDueDay("in 3 days", wednesday)).toBe("2026-10-10");
    expect(parseDueDay("2w", wednesday)).toBe("2026-10-21");
    expect(parseDueDay("2026-12-04", wednesday)).toBe("2026-12-04");
    for (const bad of ["2026-02-30", "someday", "", "in 9999 days"]) expect(parseDueDay(bad, wednesday)).toBeNull();
  });
});

describe("checklists in Discord", () => {
  const opt = (name: string, value: string, focused = false) => ({ name, type: 3, value, ...(focused ? { focused: true } : {}) });
  const itemsOf = async (cardId: string) => db.select().from(checklistItems).where(eq(checklistItems.cardId, cardId)).orderBy(checklistItems.position);

  it("/additem adds an item with who does it and when it's due, under the app's rules", async () => {
    const f = await setupStudio();
    const [manager, viewer] = await Promise.all([link(f.manager.id), link(f.viewer.id)]);
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Lantern" });

    const people = await handleInteraction({ ...base(manager), type: 4, data: { name: "additem", options: [opt("card", card.key), opt("assign", "", true)] } });
    const choices = "data" in people && "choices" in people.data ? people.data.choices.map((c) => c.value) : [];
    expect(choices).toEqual(expect.arrayContaining(["me", f.member.id, f.developer.id]));
    expect(choices).not.toContain(f.viewer.id); // Viewers don't take on work
    expect(choices).not.toContain(f.outsider.id);

    const reply = await command(manager, "additem", [opt("card", card.key), opt("item", "Export the @everyone FBX"), opt("assign", f.member.id), opt("due", "2026-12-04")]);
    expectValidLayout(reply);
    expect(shownText(reply)).toContain("✅ Added");
    expect(shownText(reply)).toContain("Fri 4 Dec");
    expect(shownText(reply)).toContain("@​everyone");
    const [item] = await itemsOf(card.id);
    expect(item).toMatchObject({ text: "Export the @everyone FBX", assigneeId: f.member.id, dueOn: "2026-12-04", isDone: false });
    const [list] = await db.select().from(checklists).where(eq(checklists.cardId, card.id));
    expect(list!.title).toBe("Checklist");

    // A named checklist, picked by title.
    await db.insert(checklists).values({ cardId: card.id, title: "Polish", position: 4096 });
    const lists = await handleInteraction({ ...base(manager), type: 4, data: { name: "additem", options: [opt("card", card.key), opt("list", "pol", true)] } });
    expect("data" in lists && "choices" in lists.data ? lists.data.choices.map((c) => c.name) : []).toEqual(["Polish"]);
    await command(manager, "additem", [opt("card", card.key), opt("item", "Add glow"), opt("list", "polish"), opt("assign", "me")]);
    const glow = (await itemsOf(card.id)).find((i) => i.text === "Add glow")!;
    expect(glow.assigneeId).toBe(f.manager.id);

    // What the app refuses, Discord refuses too.
    expect(shownText(await command(viewer, "additem", [opt("card", card.key), opt("item", "Sneaky")]))).toContain("only to cards you can edit");
    expect(shownText(await command(manager, "additem", [opt("card", card.key), opt("item", "For a viewer"), opt("assign", f.viewer.id)]))).toContain("Choose who does it");
    expect(shownText(await command(manager, "additem", [opt("card", card.key), opt("item", "When?"), opt("due", "someday")]))).toContain("didn't understand that due date");
    expect((await itemsOf(card.id)).map((i) => i.text).sort()).toEqual(["Add glow", "Export the @everyone FBX"]);
  });

  it("the checklist view lets people tick off their own items, and editors any item", async () => {
    const f = await setupStudio();
    const [member2, manager] = await Promise.all([link(f.member2.id), link(f.manager.id)]);
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Shield" });
    await command(manager, "additem", [opt("card", card.key), opt("item", "Bevel the rim"), opt("assign", f.member2.id)]);
    await command(manager, "additem", [opt("card", card.key), opt("item", "Paint the crest"), opt("assign", f.member.id)]);
    const [mine, theirs] = await itemsOf(card.id);

    // Member Two can't edit the card, but can tick their own item.
    const cardView = await command(member2, "card", [opt("find", card.key)]);
    expect(buttons(cardView)).toContain(`fg:list:${card.id}`);
    expect(shownText(cardView)).not.toContain("Add checklist items");
    const view = await click(member2, `fg:list:${card.id}`);
    expectValidLayout(view);
    expect(buttons(view)).toContain(`fg:tick:${mine!.id}`);
    expect(buttons(view)).not.toContain(`fg:tick:${theirs!.id}`);
    expect(buttons(view).some((b) => b.startsWith("fg:additems:"))).toBe(false);
    expect(shownText(await click(member2, `fg:tick:${mine!.id}`))).toContain("✅ Ticked off");
    expect(shownText(await click(member2, `fg:tick:${theirs!.id}`))).toContain("⚠️");
    const after = await itemsOf(card.id);
    expect(after.find((i) => i.id === mine!.id)!.isDone).toBe(true);
    expect(after.find((i) => i.id === theirs!.id)!.isDone).toBe(false);

    // Editors can tick (and untick) anything.
    const managerView = await click(manager, `fg:list:${card.id}`);
    expect(buttons(managerView)).toEqual(expect.arrayContaining([`fg:untick:${mine!.id}`, `fg:tick:${theirs!.id}`]));
    await click(manager, `fg:untick:${mine!.id}`);
    expect((await itemsOf(card.id)).find((i) => i.id === mine!.id)!.isDone).toBe(false);
  });

  it("Add items opens a form: each line becomes an item, with an optional person and due date", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Banner" });

    // No checklist yet: the form makes one.
    const empty = await click(manager, `fg:list:${card.id}`);
    expect(buttons(empty)).toContain(`fg:newlist:${card.id}`);
    const form = await click(manager, `fg:newlist:${card.id}`);
    expect(form).toMatchObject({ type: 9, data: { custom_id: `fg:newlist!:${card.id}` } });
    const submit = (customId: string, items: string, assign = "", due = "") =>
      handleInteraction({
        ...base(manager),
        type: 5,
        data: { custom_id: customId, components: [{ components: [{ custom_id: "items", value: items }] }, { components: [{ custom_id: "assign", value: assign }] }, { components: [{ custom_id: "due", value: due }] }] },
      });
    const added = await submit(`fg:newlist!:${card.id}`, "Sketch the logo\n- Pick the colours\n\n[ ] Print a proof", "member", "tomorrow");
    expect(shownText(added)).toContain("✅ Added 3 items");
    const items = await itemsOf(card.id);
    expect(items.map((i) => i.text)).toEqual(["Sketch the logo", "Pick the colours", "Print a proof"]);
    expect(new Set(items.map((i) => i.assigneeId))).toEqual(new Set([f.member.id]));
    expect(items.every((i) => i.dueOn === new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))).toBe(true);

    // Into an existing checklist; an unknown person adds nothing.
    const [list] = await db.select().from(checklists).where(eq(checklists.cardId, card.id));
    expect(await click(manager, `fg:additems:${list!.id}`)).toMatchObject({ type: 9, data: { custom_id: `fg:additems!:${list!.id}` } });
    expect(shownText(await submit(`fg:additems!:${list!.id}`, "Mystery", "Nobody Called This"))).toContain("Nothing was added");
    expect(await itemsOf(card.id)).toHaveLength(3);
    expect(shownText(await submit(`fg:additems!:${list!.id}`, "Hang it up"))).toContain("✅ Added 1 item");
    expect(await itemsOf(card.id)).toHaveLength(4);
  });

  it("/mywork and /due include the person's checklist items", async () => {
    const f = await setupStudio();
    const [member, manager] = await Promise.all([link(f.member.id), link(f.manager.id)]);
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Helmet" });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await command(manager, "additem", [opt("card", card.key), opt("item", "Model the visor"), opt("assign", f.member.id), opt("due", tomorrow)]);
    await command(manager, "additem", [opt("card", card.key), opt("item", "Someone else's task"), opt("assign", f.member2.id), opt("due", tomorrow)]);

    const work = await command(member, "mywork");
    expectValidLayout(work);
    expect(shownText(work)).toContain("Your checklist items");
    expect(shownText(work)).toContain("Model the visor");
    expect(shownText(work)).not.toContain("Someone else's task");

    const due = await command(member, "due");
    expectValidLayout(due);
    expect(shownText(due)).toContain("Model the visor");
    expect(buttons(due)).toContain(`fg:list:${card.id}`);
    expect(shownText(due)).not.toContain("Someone else's task");
  });

  it("long checklists stay inside Discord's limits", async () => {
    const f = await setupStudio();
    const manager = await link(f.manager.id);
    const card = await cardService.createCard(f.manager.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Everything" });
    for (const title of ["One", "Two", "Three", "Four", "Five"]) {
      const [list] = await db.insert(checklists).values({ cardId: card.id, title: `${title} ${"long title ".repeat(10)}`, position: 1024 }).returning();
      await db.insert(checklistItems).values(Array.from({ length: 12 }, (_, i) => ({ checklistId: list!.id, cardId: card.id, text: `${"A very long checklist item ".repeat(20)}${i}`, position: (i + 1) * 1024, assigneeId: f.manager.id, dueOn: "2026-12-04" })));
    }
    const view = await click(manager, `fg:list:${card.id}`);
    expectValidLayout(view);
    expect(shownText(view)).toContain("more items in Forge");
    expectValidLayout(await command(manager, "mywork"));
    expectValidLayout(await command(manager, "card", [opt("find", card.key)]));
  });
});

describe("reply layout", () => {
  it("stays inside Discord's limits with a long list, and every button id is unique", async () => {
    const f = await setupStudio();
    const member = await link(f.member.id);
    const long = "Very long card title ".repeat(10);
    for (let i = 0; i < 14; i++) {
      await cardService.createCard(f.manager.actor, {
        projectId: f.projectId,
        columnId: f.columns.vfx,
        title: `${long}${i}`,
        assigneeIds: [f.member.id],
        dueAt: new Date(Date.now() + (i - 4) * 86_400_000).toISOString(),
      });
    }
    for (const reply of [await command(member, "mywork"), await command(member, "due", [{ name: "days", type: 4, value: 30 }])]) {
      expectValidLayout(reply);
      expect(shownText(reply)).toContain("more. Open Forge to see everything.");
    }
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

  it("keep to Discord's rules for commands (or registering them fails)", () => {
    expect(new Set(DISCORD_COMMANDS.map((c) => c.name)).size).toBe(DISCORD_COMMANDS.length);
    for (const c of DISCORD_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
      const options = (("options" in c ? c.options : []) ?? []) as Array<Record<string, unknown>>;
      expect(options.length).toBeLessThanOrEqual(25);
      // Required options come before optional ones.
      const firstOptional = options.findIndex((o) => !o.required);
      if (firstOptional >= 0) expect(options.slice(firstOptional).every((o) => !o.required)).toBe(true);
      for (const o of options) {
        expect(String(o.name)).toMatch(/^[a-z][a-z_-]{0,31}$/);
        expect(String(o.description).length).toBeLessThanOrEqual(100);
        // An option has suggestions or fixed choices, never both.
        expect(Boolean(o.autocomplete && o.choices)).toBe(false);
        for (const choice of (o.choices as Array<{ name: string; value: string }> | undefined) ?? []) {
          expect(choice.name.length).toBeLessThanOrEqual(100);
          expect(String(choice.value).length).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});
