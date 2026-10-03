/**
 * Forge is private: signing up grants nothing, studios come only from the site operator or an
 * activation key, people join through Owner/Admin invitations tied to their confirmed email, and
 * project-only collaborators see just their projects. Every check here goes through the same
 * services (and router handlers) the browser reaches.
 */
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

const OPERATOR = vi.hoisted(() => {
  const email = `operator_${Date.now().toString(36)}@forge.test`;
  process.env.PLATFORM_ADMIN_EMAILS = `someone-else@forge.test, ${email.toUpperCase()}`;
  return email;
});

import { accessibleProjectIds, getProjectAccess } from "@/server/access";
import { db } from "@/server/db";
import { activationKeys, emailOutbox, invitations, notifications, projects as projectsTable, studioMembers, users } from "@/server/db/schema";
import { realtime, type RealtimeEvent } from "@/server/realtime/bus";
import { appRouter } from "@/server/rpc/router";
import * as accounts from "@/server/services/accounts";
import * as board from "@/server/services/board";
import * as cards from "@/server/services/cards";
import type { Actor } from "@/server/services/context";
import { getStudioHome } from "@/server/services/home";
import * as media from "@/server/services/media";
import { listProjectMembers } from "@/server/services/members-query";
import * as notificationService from "@/server/services/notifications";
import * as platform from "@/server/services/platform";
import * as projects from "@/server/services/projects";
import { searchCards } from "@/server/services/search";
import * as studios from "@/server/services/studios";
import { createUser, expectAppError, setupStudio, type Fixture, type TestUser } from "@/test/helpers";

const meta = () => ({ ip: `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, userAgent: "vitest" });
const stamp = () => Math.random().toString(36).slice(2, 8);

/** Calls a procedure the way /api/rpc does (after the session check). */
async function call<N extends keyof typeof appRouter>(name: N, actor: Actor, input: unknown) {
  const procedure = appRouter[name];
  const handler = procedure.handler as (ctx: unknown, input: unknown) => Promise<unknown>;
  return handler({ actor, user: { id: actor.userId } }, procedure.input.parse(input));
}

async function confirmEmail(userId: string) {
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

/** An invitation as the invitee receives it (token from the returned link). */
async function invite(by: TestUser, studioId: string, email: string, extra: Partial<Parameters<typeof studios.createInvitation>[1]> = {}) {
  const created = await studios.createInvitation(by.actor, { studioId, email, role: "CONTRIBUTOR", ...extra });
  return { ...created, token: created.url.split("/invite/")[1]! };
}

describe("sign-up is invitation-only", () => {
  it("refuses an account without an invitation, a key or the operator's email", async () => {
    await expect(accounts.signUp({ email: `stranger_${stamp()}@test.dev`, password: "long password", displayName: "Stranger" }, meta())).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { code: "INVITE_REQUIRED" },
    });
  });

  it("only lets an invitation create the account it was sent to", async () => {
    const f = await setupStudio();
    const inv = await invite(f.admin, f.studioId, `invitee_${stamp()}@test.dev`);
    await expectAppError(accounts.signUp({ email: `forwarded_${stamp()}@test.dev`, password: "long password", displayName: "Forwarded", inviteToken: inv.token }, meta()), "FORBIDDEN");
    await studios.revokeInvitation(f.admin.actor, { invitationId: inv.id });
    await expectAppError(accounts.signUp({ email: inv.email, password: "long password", displayName: "Late", inviteToken: inv.token }, meta()), "VALIDATION");
  });

  it("never makes the first registrant an owner: even the operator starts with nothing until confirmed", async () => {
    const { user } = await accounts.signUp({ email: OPERATOR, password: "operator password", displayName: "Operator" }, meta());
    expect(await studios.listStudiosForUser(user.id)).toEqual([]);
    const actor = { userId: user.id };
    await expect(studios.createStudio(actor, { name: "Too early" })).rejects.toMatchObject({ code: "FORBIDDEN", details: { code: "EMAIL_NOT_VERIFIED" } });
    await expectAppError(platform.issueActivationKey(actor, { label: "nope" }), "FORBIDDEN");
    await confirmEmail(user.id);
    const studio = await studios.createStudio(actor, { name: `Operator ${stamp()}` });
    expect(studio.role).toBe("OWNER");
  });
});

describe("accounts without membership", () => {
  let f: Fixture;
  let stranger: TestUser;
  let cardId: string;
  beforeAll(async () => {
    f = await setupStudio();
    stranger = await createUser("Stranger");
    cardId = (await cards.createCard(f.owner.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Secret" })).id;
  });

  it("can't create a studio or reach any studio content", async () => {
    await expectAppError(studios.createStudio(stranger.actor, { name: "Mine" }), "FORBIDDEN");
    await expectAppError(call("project.list", stranger.actor, { studioId: f.studioId }), "NOT_FOUND");
    await expectAppError(call("studio.home", stranger.actor, { studioId: f.studioId }), "NOT_FOUND");
    await expectAppError(call("studio.activity", stranger.actor, { studioId: f.studioId }), "NOT_FOUND");
    await expectAppError(call("member.list", stranger.actor, { studioId: f.studioId }), "NOT_FOUND");
    await expectAppError(call("search.cards", stranger.actor, { studioId: f.studioId, q: "Secret" }), "NOT_FOUND");
    await expectAppError(board.getBoard(stranger.actor, f.projectId), "NOT_FOUND");
    await expectAppError(cards.getCardDetail(stranger.actor, cardId), "NOT_FOUND");
    await expectAppError(call("project.access", stranger.actor, { projectId: f.projectId }), "NOT_FOUND");
    await expectAppError(call("studio.storage", stranger.actor, { studioId: f.studioId }), "NOT_FOUND");
  });

  it("can't upload files", async () => {
    await expectAppError(
      media.createUpload(stranger.actor, { cardId, filename: "x.png", size: 10, contentType: "image/png", purpose: "attachment" }),
      "NOT_FOUND",
    );
  });

  it("are refused by the RPC endpoint when signed out", async () => {
    const { POST } = await import("@/app/api/rpc/[procedure]/route");
    const res = await POST(
      new Request("http://localhost:3000/api/rpc/project.list", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ studioId: f.studioId }),
      }),
      { params: Promise.resolve({ procedure: "project.list" }) },
    );
    expect(res.status).toBe(401);
  });
});

describe("activation keys", () => {
  let operator: Actor;
  beforeAll(async () => {
    const [row] = await db.select().from(users).where(eq(users.email, OPERATOR));
    operator = { userId: row!.id };
  });

  it("are issued only by the operator, shown once and stored hashed", async () => {
    const someone = await createUser("Someone");
    await expectAppError(platform.issueActivationKey(someone.actor, { label: "x" }), "FORBIDDEN");
    await expectAppError(platform.listActivationKeys(someone.actor), "FORBIDDEN");
    const issued = await platform.issueActivationKey(operator, { label: "For Sam" });
    expect(issued.key).toMatch(/^FORGE-[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    const [row] = await db.select().from(activationKeys).where(eq(activationKeys.id, issued.id));
    expect(JSON.stringify(row)).not.toContain(platform.normalizeKey(issued.key));
  });

  it("let one person register, confirm their email and create exactly one studio", async () => {
    const { key } = await platform.issueActivationKey(operator, { label: "For Sam" });
    const email = `sam_${stamp()}@test.dev`;
    const { user } = await accounts.signUp({ email, password: "sam password", displayName: "Sam", activationKey: key.toLowerCase().replace(/-/g, " ") }, meta());
    // The key is now Sam's: nobody else can register with it.
    await expectAppError(accounts.signUp({ email: `other_${stamp()}@test.dev`, password: "other password", displayName: "Other", activationKey: key }, meta()), "VALIDATION");
    const sam = { userId: user.id };
    await expect(studios.createStudio(sam, { name: "Sam's" })).rejects.toMatchObject({ details: { code: "EMAIL_NOT_VERIFIED" } });
    await confirmEmail(user.id);
    expect(await platform.accessStatus(user.id)).toMatchObject({ canCreateStudio: true, platformAdmin: false });
    const studio = await studios.createStudio(sam, { name: `Sam ${stamp()}` });
    expect(studio.role).toBe("OWNER");
    await expectAppError(studios.createStudio(sam, { name: "A second one" }), "FORBIDDEN");
    await expectAppError(studios.createStudio(sam, { name: "Again", activationKey: key }), "VALIDATION");
  });

  it("refuse revoked, expired, wrong-email and reused keys", async () => {
    const someone = await createUser("Key Holder");
    const revoked = await platform.issueActivationKey(operator, { label: "revoked" });
    await platform.revokeActivationKey(operator, { keyId: revoked.id });
    await expectAppError(studios.createStudio(someone.actor, { name: "x", activationKey: revoked.key }), "VALIDATION");

    const expired = await platform.issueActivationKey(operator, { label: "expired", expiresInDays: 1 });
    await db.update(activationKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(activationKeys.id, expired.id));
    await expectAppError(studios.createStudio(someone.actor, { name: "x", activationKey: expired.key }), "VALIDATION");

    const locked = await platform.issueActivationKey(operator, { label: "locked", email: "only-this@test.dev" });
    await expectAppError(studios.createStudio(someone.actor, { name: "x", activationKey: locked.key }), "VALIDATION");
    await expectAppError(accounts.signUp({ email: `else_${stamp()}@test.dev`, password: "long password", displayName: "Else", activationKey: locked.key }, meta()), "VALIDATION");

    await expectAppError(studios.createStudio(someone.actor, { name: "x", activationKey: "FORGE-AAAAA-BBBBB-CCCCC-DDDDD" }), "VALIDATION");
  });

  it("create one studio even when two people redeem the same key at once", async () => {
    const { key } = await platform.issueActivationKey(operator, { label: "race" });
    const [a, b] = await Promise.all([createUser("Racer A"), createUser("Racer B")]);
    const results = await Promise.allSettled([
      studios.createStudio(a.actor, { name: `Race A ${stamp()}`, activationKey: key }),
      studios.createStudio(b.actor, { name: `Race B ${stamp()}`, activationKey: key }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ownerships = await db.select().from(studioMembers).where(and(eq(studioMembers.role, "OWNER")));
    const raced = ownerships.filter((m) => m.userId === a.id || m.userId === b.id);
    expect(raced).toHaveLength(1);
  });
});

describe("studio invitations", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setupStudio();
  });

  it("are sent by owners and admins only, never above their own role", async () => {
    await expect(invite(f.owner, f.studioId, `a_${stamp()}@test.dev`, { role: "ADMIN" })).resolves.toBeTruthy();
    await expect(invite(f.admin, f.studioId, `b_${stamp()}@test.dev`, { role: "MANAGER" })).resolves.toBeTruthy();
    await expectAppError(invite(f.admin, f.studioId, `c_${stamp()}@test.dev`, { role: "OWNER" }), "FORBIDDEN");
    for (const who of [f.manager, f.member, f.viewer]) {
      await expectAppError(invite(who, f.studioId, `d_${stamp()}@test.dev`, { role: "VIEWER" }), "FORBIDDEN");
    }
    await expectAppError(invite(f.outsider, f.studioId, `e_${stamp()}@test.dev`), "NOT_FOUND");
  });

  it("need the invited, confirmed account and grant only what was stored", async () => {
    const email = `joiner_${stamp()}@test.dev`;
    const inv = await invite(f.admin, f.studioId, email, { role: "VIEWER" });
    const wrong = await createUser("Wrong Account");
    await expectAppError(studios.acceptInvitation(wrong.actor, { token: inv.token }), "FORBIDDEN");

    const { user } = await accounts.signUp({ email, password: "joiner password", displayName: "Joiner", inviteToken: inv.token }, meta());
    expect(user.emailVerifiedAt).toBeNull(); // the link alone doesn't prove the mailbox
    const joiner = { userId: user.id };
    await expect(studios.acceptInvitation(joiner, { token: inv.token })).rejects.toMatchObject({ code: "FORBIDDEN", details: { code: "EMAIL_NOT_VERIFIED" } });
    await confirmEmail(user.id);
    await studios.acceptInvitation(joiner, { token: inv.token });
    const [membership] = await db.select().from(studioMembers).where(and(eq(studioMembers.studioId, f.studioId), eq(studioMembers.userId, user.id)));
    expect(membership).toMatchObject({ role: "VIEWER", access: "STUDIO" });
    await expectAppError(studios.acceptInvitation(joiner, { token: inv.token }), "CONFLICT");
  });

  it("can't be used twice even by simultaneous requests", async () => {
    const person = await createUser("Double Clicker");
    const inv = await invite(f.admin, f.studioId, person.email);
    const results = await Promise.allSettled([
      studios.acceptInvitation(person.actor, { token: inv.token }),
      studios.acceptInvitation(person.actor, { token: inv.token }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("explain expired, revoked and replaced invitations", async () => {
    const person = await createUser("Late Comer");
    const first = await invite(f.admin, f.studioId, person.email);
    const second = await invite(f.admin, f.studioId, person.email); // replaces the first
    await expectAppError(studios.acceptInvitation(person.actor, { token: first.token }), "VALIDATION");
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, second.id));
    await expectAppError(studios.acceptInvitation(person.actor, { token: second.token }), "VALIDATION");
    expect((await studios.previewInvitation(second.token))?.status).toBe("expired");
    expect((await studios.previewInvitation(first.token))?.status).toBe("revoked");
  });
});

describe("project-only collaborators", () => {
  let f: Fixture;
  let collab: TestUser;
  let otherCollab: TestUser;
  let projectB: string;
  let cardA: string;
  let cardB: string;
  beforeAll(async () => {
    f = await setupStudio();
    projectB = (await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Second ${stamp()}`, template: "empty" })).id;
    const columnB = await board.createColumn(f.owner.actor, { projectId: projectB, name: "Backlog" });
    cardA = (await cards.createCard(f.owner.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "Shared sword" })).id;
    cardB = (await cards.createCard(f.owner.actor, { projectId: projectB, columnId: columnB.id, title: "Unannounced sword" })).id;

    collab = await createUser("Freelancer");
    const inv = await invite(f.admin, f.studioId, collab.email, { role: "CONTRIBUTOR", access: "PROJECTS", projectIds: [f.projectId] });
    await studios.acceptInvitation(collab.actor, { token: inv.token });
    otherCollab = await createUser("Other Freelancer");
    const inv2 = await invite(f.admin, f.studioId, otherCollab.email, { role: "CONTRIBUTOR", access: "PROJECTS", projectIds: [projectB] });
    await studios.acceptInvitation(otherCollab.actor, { token: inv2.token });
  });

  it("are invited with a non-admin role to projects in the same studio", async () => {
    await expectAppError(invite(f.admin, f.studioId, `x_${stamp()}@test.dev`, { role: "ADMIN", access: "PROJECTS", projectIds: [f.projectId] }), "VALIDATION");
    await expectAppError(invite(f.admin, f.studioId, `y_${stamp()}@test.dev`, { access: "PROJECTS", projectIds: [] }), "VALIDATION");
    await expectAppError(invite(f.admin, f.studioId, `z_${stamp()}@test.dev`, { access: "PROJECTS", projectIds: [f.otherProjectId] }), "NOT_FOUND");
  });

  it("open their project and nothing else in the studio", async () => {
    expect(await getProjectAccess(collab.id, f.projectId)).not.toBeNull();
    expect(await getProjectAccess(collab.id, projectB)).toBeNull();
    await expect(board.getBoard(collab.actor, f.projectId)).resolves.toBeTruthy();
    await expectAppError(board.getBoard(collab.actor, projectB), "NOT_FOUND");
    await expectAppError(cards.getCardDetail(collab.actor, cardB), "NOT_FOUND");
    await expectAppError(media.createUpload(collab.actor, { cardId: cardB, filename: "x.png", size: 10, contentType: "image/png", purpose: "attachment" }), "NOT_FOUND");
    await expectAppError(call("project.activity", collab.actor, { projectId: projectB }), "NOT_FOUND");
  });

  it("see only their project in lists, search, the dashboard and activity", async () => {
    const list = (await call("project.list", collab.actor, { studioId: f.studioId })) as Array<{ id: string }>;
    expect(list.map((p) => p.id)).toEqual([f.projectId]);
    const found = (await searchCards(collab.actor, { studioId: f.studioId, q: "sword" })).map((r) => r.card.id);
    expect(found).toContain(cardA);
    expect(found).not.toContain(cardB);
    const home = await getStudioHome(collab.actor, f.studioId);
    expect(home.projects.map((p) => p.id)).toEqual([f.projectId]);
    const activity = (await call("studio.activity", collab.actor, { studioId: f.studioId })) as Array<{ projectId?: string | null }>;
    expect(activity.every((a) => !a.projectId || a.projectId === f.projectId)).toBe(true);
    expect([...(await accessibleProjectIds(collab.id, f.studioId))]).toEqual([f.projectId]);
  });

  it("see the people on their projects, not the whole roster", async () => {
    const members = (await call("member.list", collab.actor, { studioId: f.studioId })) as Array<{ id: string; access: string }>;
    const ids = members.map((m) => m.id);
    expect(ids).toContain(collab.id);
    expect(ids).toContain(f.member.id);
    expect(ids).not.toContain(otherCollab.id);
    expect(members.find((m) => m.id === collab.id)?.access).toBe("PROJECTS");
    const projectAccess = (await call("project.access", collab.actor, { projectId: f.projectId })) as Array<{ userId: string }>;
    expect(projectAccess.map((m) => m.userId)).not.toContain(otherCollab.id);
    const afterOwnEdit = await studios.updateMember(collab.actor, { studioId: f.studioId, userId: collab.id, title: "Freelance VFX" });
    expect(afterOwnEdit.map((m) => m.id)).not.toContain(otherCollab.id);
    // …while a studio-wide member sees everyone.
    const full = (await call("member.list", f.member.actor, { studioId: f.studioId })) as Array<{ id: string }>;
    expect(full.map((m) => m.id)).toContain(otherCollab.id);
  });

  it("can't be assigned or mentioned on other projects", async () => {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectB));
    const team = (await listProjectMembers(project!)).map((m) => m.id);
    expect(team).not.toContain(collab.id);
    expect(team).toContain(otherCollab.id);
  });

  it("match the single SQL access rule for every member and project", async () => {
    for (const user of [f.owner, f.admin, f.manager, f.member, f.viewer, collab, otherCollab, f.outsider]) {
      const ids = await accessibleProjectIds(user.id);
      for (const projectId of [f.projectId, projectB, f.otherProjectId]) {
        expect(ids.has(projectId), `${user.username} / ${projectId}`).toBe(Boolean(await getProjectAccess(user.id, projectId)));
      }
    }
  });

  it("lose a project — and its notifications — when removed from it", async () => {
    const extra = (await projects.createProject(f.owner.actor, { studioId: f.studioId, name: `Third ${stamp()}`, template: "empty" })).id;
    await projects.setProjectMember(f.admin.actor, { projectId: extra, userId: collab.id, member: true });
    expect(await getProjectAccess(collab.id, extra)).not.toBeNull();
    await db.insert(notifications).values({ userId: collab.id, studioId: f.studioId, projectId: extra, type: "ASSIGNED", data: {} });
    const before = await notificationService.unreadCount(collab.id);
    await projects.setProjectMember(f.admin.actor, { projectId: extra, userId: collab.id, member: false });
    expect(await getProjectAccess(collab.id, extra)).toBeNull();
    expect(await notificationService.unreadCount(collab.id)).toBe(before - 1);
  });

  it("become studio-wide when promoted to admin, and can be limited again by an admin", async () => {
    const person = await createUser("Promotable");
    const inv = await invite(f.owner, f.studioId, person.email, { role: "VIEWER", access: "PROJECTS", projectIds: [f.projectId] });
    await studios.acceptInvitation(person.actor, { token: inv.token });
    expect(await getProjectAccess(person.id, projectB)).toBeNull();
    await studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: person.id, access: "STUDIO" });
    expect(await getProjectAccess(person.id, projectB)).not.toBeNull();
    await studios.updateMember(f.admin.actor, { studioId: f.studioId, userId: person.id, access: "PROJECTS" });
    expect(await getProjectAccess(person.id, projectB)).toBeNull();
    await expectAppError(studios.updateMember(f.member.actor, { studioId: f.studioId, userId: person.id, access: "STUDIO" }), "FORBIDDEN");
    await expectAppError(studios.updateMember(person.actor, { studioId: f.studioId, userId: person.id, access: "STUDIO" }), "FORBIDDEN");
    await studios.updateMember(f.owner.actor, { studioId: f.studioId, userId: person.id, role: "ADMIN" });
    const [row] = await db.select().from(studioMembers).where(and(eq(studioMembers.studioId, f.studioId), eq(studioMembers.userId, person.id)));
    expect(row).toMatchObject({ role: "ADMIN", access: "STUDIO" });
  });
});

describe("revoking access", () => {
  it("blocks a removed member's next request although their session is still valid", async () => {
    const f = await setupStudio();
    const card = await cards.createCard(f.owner.actor, { projectId: f.projectId, columnId: f.columns.vfx, title: "After removal" });
    await expect(board.getBoard(f.member.actor, f.projectId)).resolves.toBeTruthy();
    const events: RealtimeEvent[] = [];
    const unsubscribe = realtime().subscribe((e) => events.push(e));
    await studios.removeMember(f.admin.actor, { studioId: f.studioId, userId: f.member.id });
    unsubscribe();
    expect(events).toContainEqual({ type: "access", userId: f.member.id });
    await expectAppError(board.getBoard(f.member.actor, f.projectId), "NOT_FOUND");
    await expectAppError(cards.getCardDetail(f.member.actor, card.id), "NOT_FOUND");
    await expectAppError(call("project.list", f.member.actor, { studioId: f.studioId }), "NOT_FOUND");
    await expectAppError(media.createUpload(f.member.actor, { cardId: card.id, filename: "x.png", size: 10, contentType: "image/png", purpose: "attachment" }), "NOT_FOUND");
    // Their earlier work keeps its attribution.
    const detail = await cards.getCardDetail(f.owner.actor, card.id);
    expect(detail.id).toBe(card.id);
  });

  it("revokes a pending invitation on removal so it can't restore access", async () => {
    const f = await setupStudio();
    const person = await createUser("Returning");
    const inv = await invite(f.admin, f.studioId, person.email);
    await studios.acceptInvitation(person.actor, { token: inv.token });
    // An admin re-sends to the same address while… the member is removed.
    await db.insert(invitations).values({ studioId: f.studioId, email: person.email, role: "CONTRIBUTOR", tokenHash: `stale-${stamp()}`, expiresAt: new Date(Date.now() + 86400000) });
    await studios.removeMember(f.admin.actor, { studioId: f.studioId, userId: person.id });
    const pending = await db.select().from(invitations).where(and(eq(invitations.studioId, f.studioId), eq(invitations.email, person.email)));
    expect(pending.every((i) => i.revokedAt || i.acceptedAt)).toBe(true);
    await expectAppError(studios.acceptInvitation(person.actor, { token: inv.token }), "CONFLICT");
  });

  it("keeps a studio from losing its last owner", async () => {
    const f = await setupStudio();
    await expectAppError(studios.removeMember(f.owner.actor, { studioId: f.studioId, userId: f.owner.id }), "CONFLICT");
  });
});

describe("email confirmation can't be borrowed", () => {
  it("doesn't confirm a changed address with a reset link mailed to the old one", async () => {
    const attacker = await createUser("Attacker");
    await accounts.requestPasswordReset({ email: attacker.email }, meta());
    const target = `target_${stamp()}@test.dev`;
    await db.update(users).set({ email: target, emailVerifiedAt: null }).where(eq(users.id, attacker.id));
    const [mail] = await db.select().from(emailOutbox).where(and(eq(emailOutbox.to, attacker.email), eq(emailOutbox.template, "password-reset"))).orderBy(desc(emailOutbox.createdAt)).limit(1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail!.textBody)![1]!;
    await accounts.resetPassword({ token, password: "attacker new password" }, meta()).catch(() => {});
    const [after] = await db.select().from(users).where(eq(users.id, attacker.id));
    expect(after!.emailVerifiedAt).toBeNull();
  });
});
