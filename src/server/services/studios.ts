import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm";
import { canGrantRole, canManageMember, isRole, type Role } from "@/lib/permissions";
import { RESERVED_STUDIO_SLUGS, slugify } from "@/lib/slugs";
import type { StudioSummaryDTO } from "@/lib/types";
import { requireStudio } from "../access";
import { generateToken, hashToken } from "../auth/crypto";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { invitations, projectMembers, projects, studioMembers, studios, users } from "../db/schema";
import { appOrigin } from "../env";
import { conflict, forbidden, invalid, notFound } from "../errors";
import { enforceRateLimit, enforceSharedRateLimit } from "../rate-limit";
import { audit } from "./activity";
import type { Actor } from "./context";
import { sendEmail } from "./email";
import { listStudioMembers } from "./members-query";

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

export async function createStudio(actor: Actor, input: { name: string; iconEmoji?: string }): Promise<StudioSummaryDTO> {
  enforceRateLimit(`studio-create:${actor.userId}`, 10, 60 * 60 * 1000);
  const studio = await db.transaction(async (tx) => {
    const slug = await uniqueStudioSlug(tx, input.name);
    const [row] = await tx
      .insert(studios)
      .values({ name: input.name.trim(), slug, iconEmoji: input.iconEmoji ?? null, createdById: actor.userId })
      .returning();
    await tx.insert(studioMembers).values({ studioId: row!.id, userId: actor.userId, role: "OWNER" });
    await tx.update(users).set({ lastStudioId: row!.id }).where(eq(users.id, actor.userId));
    await audit(tx, actor, { studioId: row!.id, action: "studio.created", targetType: "studio", targetId: row!.id });
    return row!;
  });
  return { id: studio.id, name: studio.name, slug: studio.slug, iconEmoji: studio.iconEmoji, accentColor: studio.accentColor, role: "OWNER" };
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
  await requireStudio(actor.userId, studioId, "members.view");
  return listStudioMembers(studioId);
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
  input: { studioId: string; userId: string; role?: Role; title?: string | null },
) {
  const access = await requireStudio(actor.userId, input.studioId);
  const [target] = await db
    .select()
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, input.studioId), eq(studioMembers.userId, input.userId)));
  if (!target) throw notFound("Member");
  const self = input.userId === actor.userId;

  if (input.role !== undefined && input.role !== target.role) {
    if (!canManageMember(access.role, target.role) || !canGrantRole(access.role, input.role)) {
      throw forbidden("You can't change this member's role.");
    }
    if (target.role === "OWNER" && (await ownerCount(db, input.studioId)) <= 1) {
      throw conflict("A studio needs at least one owner. Promote someone else first.");
    }
  }
  if (input.title !== undefined && !self && !canManageMember(access.role, target.role)) {
    throw forbidden("You can't edit this member.");
  }

  await db.transaction(async (tx) => {
    const patch: Partial<typeof studioMembers.$inferInsert> = {};
    if (input.role !== undefined) patch.role = input.role;
    if (input.title !== undefined) patch.title = input.title?.trim() || null;
    await tx.update(studioMembers).set(patch).where(eq(studioMembers.id, target.id));
    if (input.role !== undefined && input.role !== target.role) {
      await audit(tx, actor, {
        studioId: input.studioId,
        action: "member.role_changed",
        targetType: "user",
        targetId: input.userId,
        data: { from: target.role, to: input.role },
      });
    }
  });
  return listStudioMembers(input.studioId);
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
  await db.transaction(async (tx) => {
    await tx.delete(studioMembers).where(eq(studioMembers.id, target.id));
    const projectIds = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.studioId, input.studioId))).map((p) => p.id);
    for (const projectId of projectIds) {
      await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, input.userId)));
    }
    await audit(tx, actor, {
      studioId: input.studioId,
      action: self ? "member.left" : "member.removed",
      targetType: "user",
      targetId: input.userId,
      data: { role: target.role },
    });
  });
  return { ok: true };
}

// ── Invitations ─────────────────────────────────────────────────────────────

function inviteUrl(token: string) {
  return `${appOrigin()}/invite/${token}`;
}

export async function listInvitations(actor: Actor, studioId: string) {
  await requireStudio(actor.userId, studioId, "members.invite");
  const rows = await db
    .select({ invitation: invitations, inviterName: users.displayName })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedById))
    .where(and(eq(invitations.studioId, studioId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .orderBy(desc(invitations.createdAt));
  return rows.map((r) => ({
    id: r.invitation.id,
    email: r.invitation.email,
    role: r.invitation.role,
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
  email: string,
  role: Role,
  inviterName: string,
) {
  const token = generateToken();
  const [row] = await ex
    .insert(invitations)
    .values({
      studioId: studio.id,
      email,
      role,
      tokenHash: hashToken(token),
      invitedById: actor.userId,
      expiresAt: new Date(now().getTime() + INVITE_TTL_MS),
    })
    .returning();
  const url = inviteUrl(token);
  await sendEmail(ex, {
    to: email,
    template: "invitation",
    subject: `${inviterName} invited you to ${studio.name} on Forge`,
    lines: [
      `${inviterName} invited you to join ${studio.name} as ${role.toLowerCase()}.`,
      "Sign in or create an account with this email address to accept. The link expires in 7 days.",
    ],
    action: { label: `Join ${studio.name}`, url },
  });
  return { invitation: row!, url };
}

export async function createInvitation(actor: Actor, input: { studioId: string; email: string; role: Role }) {
  enforceRateLimit(`invite:${actor.userId}`, 50, 60 * 60 * 1000);
  const access = await requireStudio(actor.userId, input.studioId, "members.invite");
  if (!canGrantRole(access.role, input.role)) throw forbidden("You can't invite people with that role.");
  const email = input.email.trim().toLowerCase();

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
    const issued = await issueInvitation(tx, actor, { id: access.studioId, name: access.studioName }, email, input.role, inviter?.displayName ?? "A teammate");
    await audit(tx, actor, {
      studioId: access.studioId,
      action: "invitation.created",
      targetType: "invitation",
      targetId: issued.invitation.id,
      data: { email, role: input.role },
    });
    return issued;
  });
  return { id: result.invitation.id, email, role: input.role, url: result.url, expiresAt: result.invitation.expiresAt.toISOString() };
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
  return {
    status: status as "pending" | "revoked" | "accepted" | "expired",
    email: inv.email,
    role: inv.role,
    studioName: row.studioName,
    studioSlug: row.studioSlug,
    inviterName: row.inviterName,
    expiresAt: inv.expiresAt.toISOString(),
  };
}

export async function acceptInvitation(actor: Actor, input: { token: string }) {
  await enforceSharedRateLimit(`invite-accept:${actor.userId}`, 20, 10 * 60 * 1000);
  const [invitation] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, hashToken(input.token)), isNull(invitations.revokedAt)));
  if (!invitation) throw notFound("Invitation");
  if (invitation.acceptedAt) throw conflict("This invitation has already been used.");
  if (invitation.expiresAt.getTime() < now().getTime()) throw invalid("This invitation has expired. Ask for a new one.");

  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");
  if (user.email !== invitation.email) {
    throw forbidden(`This invitation was sent to ${invitation.email}. Sign in with that email address to accept it.`);
  }

  const [studio] = await db.select().from(studios).where(eq(studios.id, invitation.studioId));
  await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(invitations)
      .set({ acceptedAt: now(), acceptedById: actor.userId })
      .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt), gt(invitations.expiresAt, now())))
      .returning();
    if (!claimed) throw conflict("This invitation has already been used.");
    await tx
      .insert(studioMembers)
      .values({ studioId: invitation.studioId, userId: actor.userId, role: isRole(invitation.role) ? invitation.role : "MEMBER" })
      .onConflictDoNothing();
    // Opening the invite link proves control of the email address.
    if (!user.emailVerifiedAt) await tx.update(users).set({ emailVerifiedAt: now() }).where(eq(users.id, user.id));
    await tx.update(users).set({ lastStudioId: invitation.studioId }).where(eq(users.id, user.id));
    await audit(tx, actor, { studioId: invitation.studioId, action: "invitation.accepted", targetType: "invitation", targetId: invitation.id, data: { role: invitation.role } });
  });
  return { studioSlug: studio!.slug };
}
