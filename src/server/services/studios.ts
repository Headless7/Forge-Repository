import { and, asc, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { canGrantRole, canManageMember, isRole, isStudioWideRole, type MemberAccess, type Role } from "@/lib/permissions";
import { RESERVED_STUDIO_SLUGS, slugify } from "@/lib/slugs";
import type { StudioSummaryDTO } from "@/lib/types";
import { requireProject, requireStudio } from "../access";
import { generateToken, hashToken } from "../auth/crypto";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { invitations, projectMembers, projects, studioMembers, studios, users } from "../db/schema";
import { appOrigin } from "../env";
import { AppError, conflict, forbidden, invalid, notFound } from "../errors";
import { enforceSharedRateLimit } from "../rate-limit";
import { announceAccessChange } from "../realtime/bus";
import { audit } from "./activity";
import type { Actor } from "./context";
import { sendEmail } from "./email";
import { listMembersFor } from "./members-query";
import { findUsableKey, isPlatformAdmin, loadPlatformUser, pendingKeyFor, redeemKey } from "./platform";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function listStudiosForUser(userId: string): Promise<StudioSummaryDTO[]> {
  const rows = await db
    .select({ studio: studios, role: studioMembers.role })
    .from(studioMembers)
    .innerJoin(studios, eq(studios.id, studioMembers.studioId))
    .where(eq(studioMembers.userId, userId))
    .orderBy(asc(studios.name));
  return rows.map((r) => ({
    id: r.studio.id,
    name: r.studio.name,
    slug: r.studio.slug,
    iconEmoji: r.studio.iconEmoji,
    accentColor: r.studio.accentColor,
    role: isRole(r.role) ? r.role : "VIEWER",
  }));
}

async function uniqueStudioSlug(ex: Executor, base: string, excludeId?: string) {
  let root = slugify(base) || "studio";
  if (RESERVED_STUDIO_SLUGS.has(root)) root = `${root}-studio`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const rows = await ex.select({ id: studios.id }).from(studios).where(eq(studios.slug, candidate));
    if (!rows[0] || rows[0].id === excludeId) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

async function insertStudio(tx: Executor, actor: Actor, input: { name: string; iconEmoji?: string }) {
  const slug = await uniqueStudioSlug(tx, input.name);
  const [row] = await tx
    .insert(studios)
    .values({ name: input.name.trim(), slug, iconEmoji: input.iconEmoji ?? null, createdById: actor.userId })
    .returning();
  await tx.insert(studioMembers).values({ studioId: row!.id, userId: actor.userId, role: "OWNER" });
  await tx.update(users).set({ lastStudioId: row!.id }).where(eq(users.id, actor.userId));
  await audit(tx, actor, { studioId: row!.id, action: "studio.created", targetType: "studio", targetId: row!.id });
  return row!;
}

function studioSummary(studio: typeof studios.$inferSelect): StudioSummaryDTO {
  return { id: studio.id, name: studio.name, slug: studio.slug, iconEmoji: studio.iconEmoji, accentColor: studio.accentColor, role: "OWNER" };
}

/** Creates a studio owned by `actor` with no access checks — only for seeds and tests. */
export async function provisionStudio(actor: Actor, input: { name: string; iconEmoji?: string }): Promise<StudioSummaryDTO> {
  return studioSummary(await db.transaction((tx) => insertStudio(tx, actor, input)));
}

/**
 * Site operators create studios freely. Anyone else needs an activation key: one typed in now,
 * or the one they registered with. Each key creates exactly one studio.
 */
export async function createStudio(actor: Actor, input: { name: string; iconEmoji?: string; activationKey?: string }): Promise<StudioSummaryDTO> {
  await enforceSharedRateLimit(`studio-create:${actor.userId}`, 10, 60 * 60 * 1000);
  const user = await loadPlatformUser(actor.userId);
  if (isPlatformAdmin(user)) return provisionStudio(actor, input);
  if (!user.emailVerifiedAt) {
    throw new AppError("FORBIDDEN", "Confirm your email address before creating a studio.", { code: "EMAIL_NOT_VERIFIED" });
  }
  const key = input.activationKey ? await findUsableKey(db, input.activationKey, user.email, user.id) : await pendingKeyFor(user.id);
  if (!key) throw forbidden("Creating a studio needs an activation key from the site operator.");
  const studio = await db.transaction(async (tx) => {
    const row = await insertStudio(tx, actor, input);
    await redeemKey(tx, key, user, row.id);
    return row;
  });
  return studioSummary(studio);
}

export async function updateStudio(
  actor: Actor,
  input: { studioId: string; name?: string; slug?: string; iconEmoji?: string | null },
): Promise<StudioSummaryDTO> {
  const access = await requireStudio(actor.userId, input.studioId, "studio.update");
  const updated = await db.transaction(async (tx) => {
    const patch: Partial<typeof studios.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.iconEmoji !== undefined) patch.iconEmoji = input.iconEmoji;
    if (input.slug !== undefined && input.slug !== access.studioSlug) {
      const slug = slugify(input.slug);
      if (!slug || RESERVED_STUDIO_SLUGS.has(slug)) throw invalid("That URL name isn't available.");
      patch.slug = await uniqueStudioSlug(tx, slug, access.studioId);
    }
    const [row] = await tx.update(studios).set(patch).where(eq(studios.id, access.studioId)).returning();
    await audit(tx, actor, { studioId: access.studioId, action: "studio.updated", targetType: "studio", targetId: access.studioId, data: { fields: Object.keys(patch) } });
    return row!;
  });
  return { id: updated.id, name: updated.name, slug: updated.slug, iconEmoji: updated.iconEmoji, accentColor: updated.accentColor, role: access.role };
}

export async function rememberStudio(userId: string, studioId: string) {
  await db.update(users).set({ lastStudioId: studioId }).where(eq(users.id, userId));
}

// ── Members ─────────────────────────────────────────────────────────────────

export async function listMembers(actor: Actor, studioId: string) {
  return listMembersFor(await requireStudio(actor.userId, studioId, "members.view"));
}

async function ownerCount(ex: Executor, studioId: string) {
  const [row] = await ex
    .select({ value: count() })
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, studioId), eq(studioMembers.role, "OWNER")));
  return row?.value ?? 0;
}

export async function updateMember(
  actor: Actor,
  input: { studioId: string; userId: string; role?: Role; access?: MemberAccess; title?: string | null },
) {
  const access = await requireStudio(actor.userId, input.studioId);
  const [target] = await db
    .select()
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, input.studioId), eq(studioMembers.userId, input.userId)));
  if (!target) throw notFound("Member");
  const self = input.userId === actor.userId;
  const roleChanged = input.role !== undefined && input.role !== target.role;

  if (roleChanged) {
    if (!canManageMember(access.role, target.role) || !canGrantRole(access.role, input.role!)) {
      throw forbidden("You can't change this member's role.");
    }
    if (target.role === "OWNER" && (await ownerCount(db, input.studioId)) <= 1) {
      throw conflict("A studio needs at least one owner. Promote someone else first.");
    }
  }
  // Owners and admins are studio-wide; promoting a project-only collaborator widens their access.
  const nextRole = input.role ?? target.role;
  if (input.access === "PROJECTS" && isStudioWideRole(nextRole)) {
    throw invalid("Owners and admins always have access to the whole studio.");
  }
  const nextAccess: MemberAccess = isStudioWideRole(nextRole) ? "STUDIO" : (input.access ?? (target.access as MemberAccess));
  const accessChanged = nextAccess !== target.access;
  if (accessChanged && !roleChanged && (self || !canManageMember(access.role, target.role))) {
    throw forbidden("You can't change this member's access.");
  }
  if (input.title !== undefined && !self && !canManageMember(access.role, target.role)) {
    throw forbidden("You can't edit this member.");
  }

  await db.transaction(async (tx) => {
    const patch: Partial<typeof studioMembers.$inferInsert> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (accessChanged) patch.access = nextAccess;
    if (input.title !== undefined) patch.title = input.title?.trim() || null;
    await tx.update(studioMembers).set(patch).where(eq(studioMembers.id, target.id));
    if (roleChanged) {
      await audit(tx, actor, {
        studioId: input.studioId,
        action: "member.role_changed",
        targetType: "user",
        targetId: input.userId,
        data: { from: target.role, to: input.role },
      });
    }
    if (accessChanged) {
      await audit(tx, actor, {
        studioId: input.studioId,
        action: "member.access_changed",
        targetType: "user",
        targetId: input.userId,
        data: { from: target.access, to: nextAccess },
      });
    }
  });
  if (roleChanged || accessChanged) announceAccessChange(input.userId);
  return listMembersFor(access);
}

export async function removeMember(actor: Actor, input: { studioId: string; userId: string }) {
  const access = await requireStudio(actor.userId, input.studioId);
  const [target] = await db
    .select()
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, input.studioId), eq(studioMembers.userId, input.userId)));
  if (!target) throw notFound("Member");
  const self = input.userId === actor.userId;
  if (!self && !canManageMember(access.role, target.role)) throw forbidden("You can't remove this member.");
  if (target.role === "OWNER" && (await ownerCount(db, input.studioId)) <= 1) {
    throw conflict("The last owner can't leave or be removed. Transfer ownership first.");
  }
  const [person] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId));
  await db.transaction(async (tx) => {
    await tx.delete(studioMembers).where(eq(studioMembers.id, target.id));
    const projectIds = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.studioId, input.studioId))).map((p) => p.id);
    for (const projectId of projectIds) {
      await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, input.userId)));
    }
    // An invitation still waiting in their inbox must not bring them back.
    if (person) {
      await tx
        .update(invitations)
        .set({ revokedAt: now() })
        .where(and(eq(invitations.studioId, input.studioId), eq(invitations.email, person.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    }
    await audit(tx, actor, {
      studioId: input.studioId,
      action: self ? "member.left" : "member.removed",
      targetType: "user",
      targetId: input.userId,
      data: { role: target.role },
    });
  });
  announceAccessChange(input.userId);
  return { ok: true };
}

/// ── Invitations ─────────────────────────────────────────────────────────────

function inviteUrl(token: string) {
  return `${appOrigin()}/invite/${token}`;
}

async function projectNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function listInvitations(actor: Actor, studioId: string) {
  await requireStudio(actor.userId, studioId, "members.invite");
  const rows = await db
    .select({ invitation: invitations, inviterName: users.displayName })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedById))
    .where(and(eq(invitations.studioId, studioId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .orderBy(desc(invitations.createdAt));
  const names = await projectNames([...new Set(rows.flatMap((r) => r.invitation.projectIds))]);
  return rows.map((r) => ({
    id: r.invitation.id,
    email: r.invitation.email,
    role: r.invitation.role,
    access: r.invitation.access as MemberAccess,
    projects: r.invitation.projectIds.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)! }] : [])),
    invitedBy: r.inviterName,
    createdAt: r.invitation.createdAt.toISOString(),
    expiresAt: r.invitation.expiresAt.toISOString(),
    expired: r.invitation.expiresAt.getTime() < Date.now(),
  }));
}

async function issueInvitation(
  ex: Executor,
  actor: Actor,
  studio: { id: string; name: string },
  grant: { email: string; role: Role; access: MemberAccess; projects: Array<{ id: string; name: string }> },
  inviterName: string,
) {
  const token = generateToken();
  const [row] = await ex
    .insert(invitations)
    .values({
      studioId: studio.id,
      email: grant.email,
      role: grant.role,
      access: grant.access,
      projectIds: grant.projects.map((p) => p.id),
      tokenHash: hashToken(token),
      invitedById: actor.userId,
      expiresAt: new Date(now().getTime() + INVITE_TTL_MS),
    })
    .returning();
  const url = inviteUrl(token);
  const scope = grant.access === "PROJECTS" ? ` on ${grant.projects.map((p) => p.name).join(", ")}` : "";
  await sendEmail(ex, {
    to: grant.email,
    template: "invitation",
    subject: `${inviterName} invited you to ${studio.name} on Forge`,
    lines: [
      `${inviterName} invited you to join ${studio.name}${scope} as ${grant.role.toLowerCase()}.`,
      "Sign in or create an account with this email address to accept. The link expires in 7 days.",
    ],
    action: { label: `Join ${studio.name}`, url },
  });
  return { invitation: row!, url };
}

/**
 * Owners and admins invite people by email. A project-only invitation (external collaborators)
 * names the projects; the inviter must be allowed to add people to each of them.
 */
export async function createInvitation(
  actor: Actor,
  input: { studioId: string; email: string; role: Role; access?: MemberAccess; projectIds?: string[] },
) {
  await enforceSharedRateLimit(`invite:${actor.userId}`, 50, 60 * 60 * 1000);
  const access = await requireStudio(actor.userId, input.studioId, "members.invite");
  if (!canGrantRole(access.role, input.role)) throw forbidden("You can't invite people with that role.");
  const email = input.email.trim().toLowerCase();
  const scope: MemberAccess = input.access ?? "STUDIO";

  const grantedProjects: Array<{ id: string; name: string }> = [];
  if (scope === "PROJECTS") {
    if (isStudioWideRole(input.role)) {
      throw invalid("Owners and admins always have access to the whole studio. Choose another role for a project-only invitation.");
    }
    const ids = [...new Set(input.projectIds ?? [])];
    if (ids.length === 0) throw invalid("Choose at least one project.");
    for (const id of ids) {
      // The same permission as adding someone to the project directly.
      const project = await requireProject(actor.userId, id, "project.update");
      if (project.studioId !== access.studioId) throw notFound("Project");
      grantedProjects.push({ id: project.project.id, name: project.project.name });
    }
  }

  const existingMember = await db
    .select({ id: studioMembers.id })
    .from(studioMembers)
    .innerJoin(users, eq(users.id, studioMembers.userId))
    .where(and(eq(studioMembers.studioId, input.studioId), eq(users.email, email)));
  if (existingMember[0]) throw conflict(`${email} is already a member of this studio.`);

  const [inviter] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, actor.userId));
  const result = await db.transaction(async (tx) => {
    // Re-inviting replaces any pending invitation for the same email.
    await tx
      .update(invitations)
      .set({ revokedAt: now() })
      .where(and(eq(invitations.studioId, input.studioId), eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const issued = await issueInvitation(
      tx,
      actor,
      { id: access.studioId, name: access.studioName },
      { email, role: input.role, access: scope, projects: grantedProjects },
      inviter?.displayName ?? "A teammate",
    );
    await audit(tx, actor, {
      studioId: access.studioId,
      action: "invitation.created",
      targetType: "invitation",
      targetId: issued.invitation.id,
      data: { email, role: input.role, access: scope, projectIds: grantedProjects.map((p) => p.id) },
    });
    return issued;
  });
  return {
    id: result.invitation.id,
    email,
    role: input.role,
    access: scope,
    projects: grantedProjects,
    url: result.url,
    expiresAt: result.invitation.expiresAt.toISOString(),
  };
}

export async function revokeInvitation(actor: Actor, input: { invitationId: string }) {
  const [invitation] = await db.select().from(invitations).where(eq(invitations.id, input.invitationId));
  if (!invitation) throw notFound("Invitation");
  await requireStudio(actor.userId, invitation.studioId, "members.invite");
  await db.transaction(async (tx) => {
    await tx.update(invitations).set({ revokedAt: now() }).where(eq(invitations.id, invitation.id));
    await audit(tx, actor, { studioId: invitation.studioId, action: "invitation.revoked", targetType: "invitation", targetId: invitation.id, data: { email: invitation.email } });
  });
  return { ok: true };
}

/** Public preview for the /invite/[token] page — reveals nothing without a valid token. */
export async function previewInvitation(token: string) {
  const [row] = await db
    .select({ invitation: invitations, studioName: studios.name, studioSlug: studios.slug, inviterName: users.displayName })
    .from(invitations)
    .innerJoin(studios, eq(studios.id, invitations.studioId))
    .leftJoin(users, eq(users.id, invitations.invitedById))
    .where(eq(invitations.tokenHash, hashToken(token)));
  if (!row) return null;
  const inv = row.invitation;
  const status = inv.revokedAt ? "revoked" : inv.acceptedAt ? "accepted" : inv.expiresAt.getTime() < now().getTime() ? "expired" : "pending";
  const names = status === "pending" ? await projectNames(inv.projectIds) : new Map<string, string>();
  return {
    status: status as "pending" | "revoked" | "accepted" | "expired",
    email: inv.email,
    role: inv.role,
    access: inv.access as MemberAccess,
    projectNames: inv.projectIds.flatMap((id) => (names.has(id) ? [names.get(id)!] : [])),
    studioName: row.studioName,
    studioSlug: row.studioSlug,
    inviterName: row.inviterName,
    expiresAt: inv.expiresAt.toISOString(),
  };
}

/**
 * Accepts with the account whose confirmed email the invitation was sent to. Everything granted
 * (role, scope, projects) comes from the stored invitation, never from the request.
 */
export async function acceptInvitation(actor: Actor, input: { token: string }) {
  await enforceSharedRateLimit(`invite-accept:${actor.userId}`, 20, 10 * 60 * 1000);
  const [invitation] = await db.select().from(invitations).where(eq(invitations.tokenHash, hashToken(input.token)));
  if (!invitation) throw notFound("Invitation");
  if (invitation.revokedAt) throw invalid("This invitation was revoked. Ask a studio admin for a new one.");
  if (invitation.acceptedAt) throw conflict("This invitation has already been used.");
  if (invitation.expiresAt.getTime() < now().getTime()) throw invalid("This invitation has expired. Ask for a new one.");

  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  if (user.email !== invitation.email) {
    throw forbidden(`This invitation was sent to ${invitation.email}. Sign in with that email address to accept it.`);
  }
  // A forwarded link is not enough: the account must have proven it owns the address.
  if (!user.emailVerifiedAt) {
    throw new AppError("FORBIDDEN", `Confirm your email address first — we sent a link to ${user.email}.`, { code: "EMAIL_NOT_VERIFIED" });
  }

  const role: Role = isRole(invitation.role) ? invitation.role : "MEMBER";
  const scope: MemberAccess = invitation.access === "PROJECTS" && !isStudioWideRole(role) ? "PROJECTS" : "STUDIO";
  const [studio] = await db.select().from(studios).where(eq(studios.id, invitation.studioId));
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(invitations)
      .set({ acceptedAt: now(), acceptedById: actor.userId })
      .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now())))
      .returning();
    if (!claimed) throw conflict("This invitation has already been used.");
    await tx.insert(studioMembers).values({ studioId: invitation.studioId, userId: actor.userId, role, access: scope }).onConflictDoNothing();
    if (scope === "PROJECTS" && invitation.projectIds.length) {
      // Only projects that still belong to the studio.
      const stillThere = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.studioId, invitation.studioId), inArray(projects.id, invitation.projectIds)));
      for (const p of stillThere) {
        await tx.insert(projectMembers).values({ projectId: p.id, userId: actor.userId }).onConflictDoNothing();
      }
    }
    await tx.update(users).set({ lastStudioId: invitation.studioId }).where(eq(users.id, user.id));
    await audit(tx, actor, {
      studioId: invitation.studioId,
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: invitation.id,
      data: { role, access: scope },
    });
  });
  return { studioSlug: studio!.slug };
}
