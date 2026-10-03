import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { canGrantRole, hasAutomaticProjectAccess, isStudioWideRole, memberCanOpenProject, normalizeRole, type Role } from "@/lib/permissions";
import { POSITION_GAP } from "@/lib/positions";
import { projectKeyFrom, RESERVED_PROJECT_SLUGS, slugify } from "@/lib/slugs";
import type { CardDisplayMode, ProjectDTO, ProjectListItemDTO, ProjectSettings, ProjectVisibility } from "@/lib/types";
import { asRole, assertStudioOwner, getProjectAccess, requireProject, requireStudio } from "../access";
import { db, type Executor } from "../db";
import { attachments, boardColumns, boards, cards, projectMembers, projects, studioMembers, users } from "../db/schema";
import { forbidden, invalid, notFound } from "../errors";
import { now } from "../clock";
import { storage } from "../storage";
import { audit, logActivity } from "./activity";
import { insertBoard, projectToDTO } from "./board";
import { copyProjectTemplate } from "./project-templates";
import type { Actor } from "./context";
import { announceAccessChange } from "../realtime/bus";
import { Effects } from "./effects";
import { inboxAudience } from "./notifications";
import { purgeOne } from "./purge";
import { avatarUrl } from "./users-lookup";

async function uniqueProjectSlug(ex: Executor, studioId: string, base: string, excludeId?: string) {
  let root = slugify(base) || "project";
  if (RESERVED_PROJECT_SLUGS.has(root)) root = `${root}-project`;
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const rows = await ex
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.studioId, studioId), eq(projects.slug, candidate)));
    if (!rows[0] || rows[0].id === excludeId) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

async function uniqueProjectKey(ex: Executor, studioId: string, base: string, excludeId?: string) {
  const root = base.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5) || "PRJ";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root.slice(0, 4)}${i + 1}`;
    const rows = await ex
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.studioId, studioId), eq(projects.key, candidate)));
    if (!rows[0] || rows[0].id === excludeId) return candidate;
  }
  throw invalid("Couldn't find a free project key. Please choose one.");
}

export async function listProjects(actor: Actor, studioId: string, includeArchived = false): Promise<ProjectListItemDTO[]> {
  await requireStudio(actor.userId, studioId);
  const rows = await db
    .select()
    .from(projects)
    .where(includeArchived ? eq(projects.studioId, studioId) : and(eq(projects.studioId, studioId), isNull(projects.archivedAt)))
    .orderBy(asc(projects.name));
  const accessible: typeof rows = [];
  for (const p of rows) if (await getProjectAccess(actor.userId, p.id)) accessible.push(p);
  if (accessible.length === 0) return [];

  const counts = await db
    .select({
      projectId: cards.projectId,
      total: sql<number>`count(*)`.mapWith(Number),
      needsReview: sql<number>`count(*) filter (where ${cards.state} = 'NEEDS_REVIEW')`.mapWith(Number),
      changes: sql<number>`count(*) filter (where ${cards.state} = 'CHANGES_REQUESTED')`.mapWith(Number),
      approved: sql<number>`count(*) filter (where ${cards.state} = 'APPROVED')`.mapWith(Number),
      inProgress: sql<number>`count(*) filter (where ${cards.state} = 'IN_PROGRESS')`.mapWith(Number),
    })
    .from(cards)
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(and(inArray(cards.projectId, accessible.map((p) => p.id)), isNull(cards.archivedAt), isNull(boardColumns.archivedAt), isNull(boards.archivedAt)))
    .groupBy(cards.projectId);
  const countMap = new Map(counts.map((c) => [c.projectId, c]));
  return accessible.map((p) => {
    const c = countMap.get(p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      key: p.key,
      icon: p.icon,
      color: p.color,
      description: p.description,
      archived: Boolean(p.archivedAt),
      counts: {
        cards: c?.total ?? 0,
        needsReview: c?.needsReview ?? 0,
        changesRequested: c?.changes ?? 0,
        approved: c?.approved ?? 0,
        inProgress: c?.inProgress ?? 0,
      },
    };
  });
}

export interface CreateProjectInput {
  studioId: string;
  name: string;
  key?: string;
  icon?: string;
  color?: string;
  description?: string;
  /** Starter columns for a blank project. Ignored when copying another project. */
  template?: "roblox" | "empty";
  /** Copy this project's boards, columns, labels, settings and access (never its work). */
  templateProjectId?: string | null;
  /** With a template: which of its members to bring (default: everyone it can bring). */
  templateMemberIds?: string[] | null;
  visibility?: ProjectVisibility;
}

/** Creates a project — blank, or set up like another one — in a single transaction. */
export async function createProject(actor: Actor, input: CreateProjectInput): Promise<ProjectDTO> {
  const access = await requireStudio(actor.userId, input.studioId, "project.create");
  const fx = new Effects();
  const project = await db.transaction(async (tx) => {
    const slug = await uniqueProjectSlug(tx, input.studioId, input.name);
    const key = await uniqueProjectKey(tx, input.studioId, input.key || projectKeyFrom(input.name));
    const [row] = await tx
      .insert(projects)
      .values({
        studioId: input.studioId,
        name: input.name.trim(),
        slug,
        key,
        icon: input.icon ?? "🎮",
        color: input.color ?? "#a78bfa",
        description: input.description?.trim() ?? "",
        visibility: input.visibility ?? "STUDIO",
        createdById: actor.userId,
      })
      .returning();
    let template: { name: string; members: number } | null = null;
    if (input.templateProjectId) {
      await copyProjectTemplate(tx, actor, access, input.templateProjectId, row!, input.templateMemberIds);
      const [source] = await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, input.templateProjectId));
      const members = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, row!.id));
      template = { name: source?.name ?? "", members: members.length };
    } else {
      const board = await insertBoard(tx, { projectId: row!.id, name: "Board", createdById: actor.userId, position: POSITION_GAP });
      if ((input.template ?? "roblox") === "roblox") {
        await tx.insert(boardColumns).values(
          ROBLOX_TEMPLATE.map((c, i) => ({
            boardId: board.id,
            projectId: row!.id,
            name: c.name,
            icon: c.icon,
            color: c.color,
            defaultCardMode: c.mode,
            position: (i + 1) * POSITION_GAP,
            createdById: actor.userId,
          })),
        );
      }
    }
    await tx.insert(projectMembers).values({ projectId: row!.id, userId: actor.userId }).onConflictDoNothing();
    await logActivity(tx, { studioId: access.studioId, projectId: row!.id, actorId: actor.userId, type: "project.created", data: { name: row!.name, ...(template ? { template: template.name } : {}) } });
    await audit(tx, actor, {
      studioId: access.studioId,
      action: "project.created",
      targetType: "project",
      targetId: row!.id,
      data: { name: row!.name, ...(template ? { template: template.name, templateProjectId: input.templateProjectId, members: template.members } : {}) },
    });
    const [final] = await tx.select().from(projects).where(eq(projects.id, row!.id));
    return final!;
  });
  if (input.templateProjectId) {
    // People the template brought along can now open the project.
    const members = await db.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, project.id));
    for (const m of members) if (m.userId !== actor.userId) announceAccessChange(m.userId);
  }
  fx.project(project.id).flush(actor.clientId);
  return projectToDTO(project);
}

export interface UpdateProjectInput {
  projectId: string;
  name?: string;
  slug?: string;
  key?: string;
  description?: string;
  icon?: string;
  color?: string;
  background?: string;
  defaultCardMode?: CardDisplayMode;
  visibility?: ProjectVisibility;
  settings?: Partial<ProjectSettings>;
}

export async function updateProject(actor: Actor, input: UpdateProjectInput): Promise<ProjectDTO> {
  const access = await requireProject(actor.userId, input.projectId, "project.update");
  const project = access.project;
  const updated = await db.transaction(async (tx) => {
    const patch: Partial<typeof projects.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.slug !== undefined && input.slug !== project.slug) {
      const slug = slugify(input.slug);
      if (!slug) throw invalid("The URL name can't be empty.");
      if (RESERVED_PROJECT_SLUGS.has(slug)) throw invalid(`"${slug}" is reserved. Choose another URL name.`);
      patch.slug = await uniqueProjectSlug(tx, project.studioId, slug, project.id);
    }
    if (input.key !== undefined && input.key.toUpperCase() !== project.key) {
      patch.key = await uniqueProjectKey(tx, project.studioId, input.key, project.id);
    }
    if (input.description !== undefined) patch.description = input.description.trim();
    if (input.icon !== undefined) patch.icon = input.icon;
    if (input.color !== undefined) patch.color = input.color;
    if (input.background !== undefined) patch.background = input.background;
    if (input.defaultCardMode !== undefined) patch.defaultCardMode = input.defaultCardMode;
    if (input.visibility !== undefined) patch.visibility = input.visibility;
    if (input.settings) {
      const settings = { ...project.settings, ...input.settings };
      if (input.settings.defaultReviewerIds) {
        const valid = await tx
          .select({ userId: studioMembers.userId })
          .from(studioMembers)
          .where(and(eq(studioMembers.studioId, project.studioId), inArray(studioMembers.userId, input.settings.defaultReviewerIds.length ? input.settings.defaultReviewerIds : ["00000000-0000-0000-0000-000000000000"])));
        settings.defaultReviewerIds = valid.map((v) => v.userId);
      }
      patch.settings = settings;
    }
    const [row] = await tx.update(projects).set(patch).where(eq(projects.id, project.id)).returning();
    await audit(tx, actor, {
      studioId: project.studioId,
      action: "project.updated",
      targetType: "project",
      targetId: project.id,
      data: { fields: Object.keys(patch) },
    });
    return row!;
  });
  new Effects().project(project.id).flush(actor.clientId);
  return projectToDTO(updated);
}

/** Archive and restore are the owner's (the studio role itself — no project role grants it). */
export async function setProjectArchived(actor: Actor, input: { projectId: string; archived: boolean }) {
  const access = await requireProject(actor.userId, input.projectId, "project.archive");
  assertStudioOwner(access);
  const fx = new Effects();
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ archivedAt: input.archived ? now() : null }).where(eq(projects.id, access.project.id));
    // Notifications from an archived project are hidden (and come back on restore).
    fx.notify(await inboxAudience(tx, { projectId: access.project.id }));
    await audit(tx, actor, {
      studioId: access.studioId,
      action: input.archived ? "project.archived" : "project.restored",
      targetType: "project",
      targetId: access.project.id,
      data: { name: access.project.name },
    });
  });
  fx.project(access.project.id).flush(actor.clientId);
  return { ok: true };
}

/**
 * Irreversible: removes an archived project with its board, cards, history and media (files
 * still used elsewhere are kept). Owner only; requires typing the project name.
 */
export async function deleteProject(actor: Actor, input: { projectId: string; confirm: string }) {
  const access = await requireProject(actor.userId, input.projectId, "project.delete");
  assertStudioOwner(access);
  if (!access.project.archivedAt) throw invalid("Archive the project before deleting it.");
  if (input.confirm.trim() !== access.project.name) throw invalid(`Type "${access.project.name}" to confirm.`);
  return purgeOne(actor, { type: "project", id: access.project.id });
}

export async function listProjectAccess(actor: Actor, projectId: string) {
  const access = await requireProject(actor.userId, projectId, "project.view");
  const [members, overrides] = await Promise.all([
    db
      .select({
        userId: studioMembers.userId,
        role: studioMembers.role,
        access: studioMembers.access,
        title: studioMembers.title,
        displayName: users.displayName,
        username: users.username,
        avatarKey: users.avatarKey,
        avatarColor: users.avatarColor,
      })
      .from(studioMembers)
      .innerJoin(users, eq(users.id, studioMembers.userId))
      .where(eq(studioMembers.studioId, access.studioId))
      .orderBy(asc(users.displayName)),
    db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId)),
  ]);
  const overrideMap = new Map(overrides.map((o) => [o.userId, o]));
  const rows = members.map((m) => ({ m, hasAccess: memberCanOpenProject(m, access.project, overrideMap.has(m.userId)) }));
  // Project-only collaborators see the people on this project, not the whole studio roster.
  const visible = access.scope === "PROJECTS" ? rows.filter((r) => r.hasAccess) : rows;
  return Promise.all(
    visible.map(async ({ m, hasAccess }) => {
      const override = overrideMap.get(m.userId);
      const studioRole: Role = asRole(m.role);
      return {
        userId: m.userId,
        displayName: m.displayName,
        username: m.username,
        avatarUrl: await avatarUrl(m.avatarKey),
        avatarColor: m.avatarColor,
        title: m.title,
        studioRole,
        /** Project-only collaborator: sees only the projects they're on. */
        projectsOnly: m.access === "PROJECTS" && !isStudioWideRole(studioRole),
        projectRole: normalizeRole(override?.role ?? null),
        isProjectMember: Boolean(override) || isStudioWideRole(studioRole),
        /** Has the project through their studio role, so removing them from it changes nothing. */
        automaticAccess: hasAutomaticProjectAccess({ role: studioRole, access: m.access }, access.project),
        hasAccess,
      };
    }),
  );
}

export async function setProjectMember(
  actor: Actor,
  input: { projectId: string; userId: string; member: boolean; role?: Role | null },
) {
  const access = await requireProject(actor.userId, input.projectId, "project.update");
  const [target] = await db
    .select()
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, access.studioId), eq(studioMembers.userId, input.userId)));
  if (!target) throw notFound("Member");
  if (input.role === "OWNER") throw invalid("Owner is a studio-wide role.");
  // A project role is granted like a studio role: never above what the person changing it could grant.
  if (input.role && !canGrantRole(access.studioRole, input.role)) throw forbidden("You can't give that role on this project.");
  await db.transaction(async (tx) => {
    if (input.member) {
      await tx
        .insert(projectMembers)
        .values({ projectId: access.project.id, userId: input.userId, role: input.role ?? null })
        .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: input.role ?? null } });
    } else {
      await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, access.project.id), eq(projectMembers.userId, input.userId)));
    }
    await audit(tx, actor, {
      studioId: access.studioId,
      action: input.member ? "project.member_set" : "project.member_removed",
      targetType: "project",
      targetId: access.project.id,
      data: { userId: input.userId, role: input.role ?? null },
    });
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  announceAccessChange(input.userId);
  return listProjectAccess(actor, input.projectId);
}
