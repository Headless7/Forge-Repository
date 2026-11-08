/**
 * Scoped API tokens: a headless client calls the RPC endpoint as a bot member, limited to an
 * allowlist of procedures and a set of projects. Exercised through the real route handler so the
 * bearer path, the untouched cookie path and the refusals are the ones a client would see.
 */
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { API_TOKEN_PROCEDURE_NAMES, type ApiTokenProcedure } from "@/lib/api-tokens";
import { hashToken } from "@/server/auth/crypto";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db";
import { apiTokens, auditLogs, studioMembers } from "@/server/db/schema";
import { appRouter } from "@/server/rpc/router";
import { listItemActivity } from "@/server/services/activity";
import * as tokens from "@/server/services/api-tokens";
import * as forums from "@/server/services/forums";
import * as projects from "@/server/services/projects";
import * as studios from "@/server/services/studios";
import { createUser, expectAppError, setupStudio, type Fixture, type TestUser } from "@/test/helpers";

const ORIGIN = "http://localhost:3000";
const READ: ApiTokenProcedure[] = ["forum.list", "forum.get", "item.get", "item.activity", "project.access"];
const ALL: ApiTokenProcedure[] = [...READ, "item.triage"];

let f: Fixture;
let bot: TestUser;
let bugsForumId: string;
let lobbyTagId: string;
let playTagId: string;
/** A second project in the same studio that the bot can open but no token is scoped to. */
let sideProjectId: string;

interface RpcResult {
  status: number;
  data?: Record<string, unknown> & Record<string, any>;
  error?: { code: string; message: string };
}

/** Calls the RPC route the way a client would. */
async function call(name: string, body: unknown, auth: { bearer?: string; cookie?: string; origin?: string | null } = {}): Promise<RpcResult> {
  const { POST } = await import("@/app/api/rpc/[procedure]/route");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.origin !== null) headers.origin = auth.origin ?? ORIGIN;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.cookie) headers.cookie = `forge_session=${auth.cookie}`;
  const res = await POST(new Request(`${ORIGIN}/api/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ procedure: name }),
  });
  const json = (await res.json()) as { data?: RpcResult["data"]; error?: RpcResult["error"] };
  return { status: res.status, ...json };
}

const issue = (who: TestUser, overrides: Partial<tokens.CreateApiTokenInput> = {}) =>
  tokens.createApiToken(who.actor, { studioId: f.studioId, userId: bot.id, name: "UTD bug triage", procedures: ALL, projectIds: [f.projectId], expiresInDays: 90, ...overrides });

const tokenRow = (id: string) => db.select().from(apiTokens).where(eq(apiTokens.id, id)).then((r) => r[0]!);
const lastAudit = (action: string) => db.select().from(auditLogs).where(and(eq(auditLogs.studioId, f.studioId), eq(auditLogs.action, action))).orderBy(desc(auditLogs.createdAt)).limit(1).then((r) => r[0]);

beforeAll(async () => {
  f = await setupStudio();
  // The bot: a project-only Contributor, promoted to Manager inside the project so it may assign and tag.
  bot = await createUser("Triage Bot");
  await db.insert(studioMembers).values({ studioId: f.studioId, userId: bot.id, role: "CONTRIBUTOR", access: "PROJECTS" });
  await projects.setProjectMember(f.owner.actor, { projectId: f.projectId, userId: bot.id, member: true, role: "MANAGER" });
  const side = await projects.createProject(f.owner.actor, { studioId: f.studioId, name: "Side project", template: "empty" });
  sideProjectId = side.id;
  await projects.setProjectMember(f.owner.actor, { projectId: sideProjectId, userId: bot.id, member: true, role: "MANAGER" });

  const list = await forums.listForumsFor(f.owner.actor, f.projectId);
  bugsForumId = list.find((x) => x.kind === "BUGS")!.id;
  lobbyTagId = (await forums.createTag(f.manager.actor, { forumId: bugsForumId, name: "Lobby", color: "#f97316" })).id;
  playTagId = (await forums.createTag(f.manager.actor, { forumId: bugsForumId, name: "Play Area", color: "#22c55e" })).id;
});

describe("API tokens", () => {
  it("only procedures with a scope resolver are eligible; token management never is", () => {
    for (const name of API_TOKEN_PROCEDURE_NAMES) expect(appRouter[name].scope, name).toBeTypeOf("function");
    for (const name of ["apiToken.list", "apiToken.create", "apiToken.rotate", "apiToken.revoke", "item.update", "item.setStatus", "item.delete", "member.list"] as const) {
      expect((appRouter[name] as { scope?: unknown }).scope, name).toBeUndefined();
    }
  });

  it("admins create tokens; the raw token is returned once and only its hash is stored", async () => {
    const issued = await issue(f.admin);
    expect(issued.token.startsWith("forge_")).toBe(true);
    const row = await tokenRow(issued.id);
    expect(row.tokenHash).toBe(hashToken(issued.token));
    expect(row.hint).toBe(issued.token.slice(-4));
    expect(row.procedures).toEqual(ALL);
    expect(JSON.stringify(row)).not.toContain(issued.token);

    const listed = await tokens.listApiTokens(f.admin.actor, f.studioId);
    const mine = listed.find((t) => t.id === issued.id)!;
    expect(mine).toMatchObject({ name: "UTD bug triage", hint: row.hint, status: "active", user: { id: bot.id }, createdBy: { id: f.admin.id } });
    expect(mine.projects.map((p) => p.id)).toEqual([f.projectId]);
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(await lastAudit("api_token.created")).toMatchObject({ actorId: f.admin.id, targetId: issued.id, data: { name: "UTD bug triage", userId: bot.id } });
  });

  it("a token can't widen the member's access", async () => {
    // A project the bot can't open; a non-member as the bot; no procedures; no projects.
    await expectAppError(issue(f.admin, { projectIds: [f.otherProjectId] }), "VALIDATION");
    await expectAppError(issue(f.admin, { userId: f.outsider.id }), "VALIDATION");
    await expectAppError(issue(f.admin, { procedures: [] }), "VALIDATION");
    await expectAppError(issue(f.admin, { projectIds: [] }), "VALIDATION");
  });

  it("bearer happy path: reads the forum, finds ids, sets assignee and tags as the bot", async () => {
    const { token } = await issue(f.admin);
    const item = await forums.createItem(f.member.actor, { forumId: bugsForumId, title: "Elevator doors clip through the lobby wall" });

    const forumList = await call("forum.list", { projectId: f.projectId }, { bearer: token, origin: null });
    expect(forumList.status).toBe(200);
    expect((forumList.data as unknown as Array<{ id: string }>).map((x) => x.id)).toContain(bugsForumId);

    const view = await call("forum.get", { projectId: f.projectId, slug: "bugs" }, { bearer: token, origin: null });
    expect(view.status).toBe(200);
    expect(view.data!.tags.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([lobbyTagId, playTagId]));
    expect(view.data!.items.map((i: { id: string }) => i.id)).toContain(item.id);

    const people = await call("project.access", { projectId: f.projectId }, { bearer: token, origin: null });
    expect(people.status).toBe(200);
    const roster = people.data as unknown as Array<Record<string, unknown>>;
    expect(roster.map((p) => p.userId)).toEqual(expect.arrayContaining([bot.id, f.manager.id]));
    for (const p of roster) expect(p).not.toHaveProperty("email");

    const triage = await call("item.triage", { itemId: item.id, assigneeId: f.manager.id, tagIds: [lobbyTagId] }, { bearer: token, origin: null });
    expect(triage.status).toBe(200);
    expect(triage.data).toMatchObject({ assigneeId: f.manager.id, tagIds: [lobbyTagId] });

    const detail = await call("item.get", { itemId: item.id }, { bearer: token, origin: null });
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({ assigneeId: f.manager.id });
    expect((await call("item.activity", { itemId: item.id }, { bearer: token, origin: null })).status).toBe(200);

    // History names the bot, not the admin who made the token.
    const activity = await listItemActivity(item.id);
    expect(activity.find((a) => a.type === "item.assignee_changed")?.actorId).toBe(bot.id);
    expect(activity.find((a) => a.type === "item.tags_changed")?.actorId).toBe(bot.id);

    const used = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token)));
    expect(used[0]!.lastUsedAt).not.toBeNull();
  });

  it("item.triage refuses every other field instead of ignoring it", async () => {
    const { token } = await issue(f.admin);
    const item = await forums.createItem(f.member.actor, { forumId: bugsForumId, title: "Spawn pad flickers" });
    for (const extra of [{ title: "Renamed by a bot" }, { status: "RESOLVED" }, { priority: "HIGH" }, { description: "x" }, { reviewerId: f.manager.id }]) {
      const res = await call("item.triage", { itemId: item.id, tagIds: [playTagId], ...extra }, { bearer: token, origin: null });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.error?.code).toBe("VALIDATION");
    }
    const after = await forums.getItem(f.owner.actor, item.id);
    expect(after).toMatchObject({ title: "Spawn pad flickers", tagIds: [] });
  });

  it("procedures outside the allowlist fail with FORBIDDEN, ineligible ones too", async () => {
    const { token } = await issue(f.admin);
    const item = await forums.createItem(f.member.actor, { forumId: bugsForumId, title: "Door sound plays twice" });
    for (const [name, body] of [
      ["item.setStatus", { itemId: item.id, status: "RESOLVED" }],
      ["item.delete", { itemId: item.id }],
      ["item.update", { itemId: item.id, title: "x" }],
      ["forumTag.create", { forumId: bugsForumId, name: "Nope", color: "#000000" }],
      ["apiToken.create", { studioId: f.studioId, userId: bot.id, name: "Escalation", procedures: ALL, projectIds: [f.projectId], expiresInDays: 30 }],
      ["apiToken.list", { studioId: f.studioId }],
      ["member.list", { studioId: f.studioId }],
    ] as const) {
      const res = await call(name, body, { bearer: token, origin: null });
      expect(res.status, name).toBe(403);
      expect(res.error?.code, name).toBe("FORBIDDEN");
    }
    // Eligible, but not on this token.
    const readOnly = await issue(f.admin, { procedures: ["forum.get"] });
    const refused = await call("item.triage", { itemId: item.id, tagIds: [lobbyTagId] }, { bearer: readOnly.token, origin: null });
    expect(refused.status).toBe(403);
    expect((await call("forum.list", { projectId: f.projectId }, { bearer: readOnly.token, origin: null })).status).toBe(403);
    expect((await forums.getItem(f.owner.actor, item.id)).status).toBe("OPEN");
  });

  it("projects outside the scope fail with FORBIDDEN; other studios stay invisible", async () => {
    const { token } = await issue(f.admin);
    const sideForums = await forums.listForumsFor(f.owner.actor, sideProjectId);
    const sideItem = await forums.createItem(f.owner.actor, { forumId: sideForums[0]!.id, title: "Side bug" });

    expect((await call("forum.list", { projectId: sideProjectId }, { bearer: token, origin: null })).error?.code).toBe("FORBIDDEN");
    expect((await call("forum.get", { forumId: sideForums[0]!.id }, { bearer: token, origin: null })).error?.code).toBe("FORBIDDEN");
    expect((await call("item.get", { itemId: sideItem.id }, { bearer: token, origin: null })).error?.code).toBe("FORBIDDEN");
    expect((await call("item.triage", { itemId: sideItem.id, tagIds: [] }, { bearer: token, origin: null })).error?.code).toBe("FORBIDDEN");
    expect((await call("project.access", { projectId: sideProjectId }, { bearer: token, origin: null })).error?.code).toBe("FORBIDDEN");

    // A project in another studio: NOT_FOUND, as for any member, so ids can't be probed.
    const otherForums = await forums.listForumsFor(f.outsider.actor, f.otherProjectId);
    expect((await call("forum.list", { projectId: f.otherProjectId }, { bearer: token, origin: null })).status).toBe(404);
    expect((await call("forum.get", { forumId: otherForums[0]!.id }, { bearer: token, origin: null })).status).toBe(404);
    expect((await call("item.get", { itemId: "00000000-0000-0000-0000-000000000000" }, { bearer: token, origin: null })).status).toBe(404);
  });

  it("revoked and expired tokens are refused and leave an audit entry", async () => {
    const revoked = await issue(f.owner);
    await tokens.revokeApiToken(f.owner.actor, { tokenId: revoked.id });
    expect(await lastAudit("api_token.revoked")).toMatchObject({ actorId: f.owner.id, targetId: revoked.id });
    const res = await call("forum.list", { projectId: f.projectId }, { bearer: revoked.token, origin: null });
    expect(res.status).toBe(401);
    expect(res.error?.message).toMatch(/revoked/);
    expect(await lastAudit("api_token.rejected")).toMatchObject({ actorId: bot.id, targetId: revoked.id, data: { reason: "revoked" } });
    await expectAppError(tokens.revokeApiToken(f.owner.actor, { tokenId: revoked.id }), "CONFLICT");
    await expectAppError(tokens.rotateApiToken(f.owner.actor, { tokenId: revoked.id }), "CONFLICT");

    const expired = await issue(f.owner);
    await db.update(apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiTokens.id, expired.id));
    const late = await call("forum.list", { projectId: f.projectId }, { bearer: expired.token, origin: null });
    expect(late.status).toBe(401);
    expect(late.error?.message).toMatch(/expired/);
    expect(await lastAudit("api_token.rejected")).toMatchObject({ targetId: expired.id, data: { reason: "expired" } });
    expect((await tokens.listApiTokens(f.owner.actor, f.studioId)).find((t) => t.id === expired.id)?.status).toBe("expired");

    for (const junk of ["forge_" + "a".repeat(43), "nonsense", "forge_short"]) {
      const bad = await call("forum.list", { projectId: f.projectId }, { bearer: junk, origin: null });
      expect(bad.status, junk).toBe(401);
      expect(bad.error?.code, junk).toBe("UNAUTHORIZED");
    }
  });

  it("rotating replaces the secret: the old token stops, the new one keeps the settings", async () => {
    const first = await issue(f.admin);
    const second = await tokens.rotateApiToken(f.admin.actor, { tokenId: first.id });
    expect(second.token).not.toBe(first.token);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect((await call("forum.list", { projectId: f.projectId }, { bearer: first.token, origin: null })).status).toBe(401);
    expect((await call("forum.list", { projectId: f.projectId }, { bearer: second.token, origin: null })).status).toBe(200);
    expect(await tokenRow(second.id)).toMatchObject({ name: "UTD bug triage", procedures: ALL, projectIds: [f.projectId], userId: bot.id });
    expect(await lastAudit("api_token.rotated")).toMatchObject({ actorId: f.admin.id, targetId: second.id, data: { previousTokenId: first.id } });
  });

  it("the cookie path is unchanged, and a bad bearer never falls back to the cookie", async () => {
    const { token: cookie } = await createSession(f.owner.id);
    expect((await call("forum.list", { projectId: f.projectId }, { cookie })).status).toBe(200);
    // Cross-site: a cookie without a trusted Origin is still blocked.
    expect((await call("forum.list", { projectId: f.projectId }, { cookie, origin: null })).status).toBe(403);
    expect((await call("forum.list", { projectId: f.projectId }, { cookie, origin: "https://evil.example" })).status).toBe(403);
    // Signed out: 401 as before.
    expect((await call("forum.list", { projectId: f.projectId }, {})).status).toBe(401);
    // A bearer request needs no Origin; an invalid bearer is refused even beside a valid cookie.
    const { token } = await issue(f.admin);
    expect((await call("forum.list", { projectId: f.projectId }, { bearer: token, origin: null })).status).toBe(200);
    const mixed = await call("forum.list", { projectId: f.projectId }, { bearer: "forge_" + "b".repeat(43), cookie });
    expect(mixed.status).toBe(401);
    // Token management itself works over the cookie for an admin (the UI's path).
    const listed = await call("apiToken.list", { studioId: f.studioId }, { cookie });
    expect(listed.status).toBe(200);
  });

  it("every management procedure refuses non-admins server-side", async () => {
    const { id } = await issue(f.owner);
    for (const who of [f.manager, f.member, f.developer, f.viewer]) {
      await expectAppError(tokens.listApiTokens(who.actor, f.studioId), "FORBIDDEN");
      await expectAppError(issue(who), "FORBIDDEN");
      await expectAppError(tokens.rotateApiToken(who.actor, { tokenId: id }), "FORBIDDEN");
      await expectAppError(tokens.revokeApiToken(who.actor, { tokenId: id }), "FORBIDDEN");
      const { token: cookie } = await createSession(who.id);
      expect((await call("apiToken.list", { studioId: f.studioId }, { cookie })).status).toBe(403);
      expect((await call("apiToken.create", { studioId: f.studioId, userId: bot.id, name: "x", procedures: READ, projectIds: [f.projectId], expiresInDays: 30 }, { cookie })).status).toBe(403);
    }
    // Someone from another studio can't even see that the token exists.
    await expectAppError(tokens.listApiTokens(f.outsider.actor, f.studioId), "NOT_FOUND");
    await expectAppError(tokens.rotateApiToken(f.outsider.actor, { tokenId: id }), "NOT_FOUND");
    await expectAppError(tokens.revokeApiToken(f.outsider.actor, { tokenId: id }), "NOT_FOUND");
    expect((await tokenRow(id)).revokedAt).toBeNull();
  });

  it("removing the bot from the studio revokes its tokens", async () => {
    const helper = await createUser("Second Bot");
    await db.insert(studioMembers).values({ studioId: f.studioId, userId: helper.id, role: "MANAGER" });
    const { id, token } = await issue(f.admin, { userId: helper.id, name: "Temporary" });
    expect((await call("forum.list", { projectId: f.projectId }, { bearer: token, origin: null })).status).toBe(200);
    await studios.removeMember(f.owner.actor, { studioId: f.studioId, userId: helper.id });
    expect((await tokenRow(id)).revokedAt).not.toBeNull();
    expect((await call("forum.list", { projectId: f.projectId }, { bearer: token, origin: null })).status).toBe(401);
  });
});
