import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { isRole, isStudioWideRole, memberCanOpenProject, roleHas, type Role } from "@/lib/permissions";
import { POSITION_GAP } from "@/lib/positions";
import { projectKeyFrom, RESERVED_PROJECT_SLUGS, slugify } from "@/lib/slugs";
import type { CardDisplayMode, ProjectDTO, ProjectListItemDTO, ProjectSettings, ProjectVisibility } from "@/lib/types";
import { getProjectAccess, requireProject, requireStudio } from "../access";
import { db, type Executor } from "../db";
import { attachments, boardColumns, boards, cards, projectMembers, projects, studioMembers, users } from "../db/schema";
import { forbidden, invalid, notFound } from "../errors";
import { now } from "../clock";
import { storage } from "../storage";
import { audit, logActivity } from "./activity";
import { projectToDTO } from "./board";
import type { Actor } from "./context";
import { announceAccessChange } from "../realtime/bus";
import { Effects } from "./effects";
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
    .where(and(inArray(cards.projectId, accessible.map((p) => p.id)), isNull(cards.archivedAt), isNull(boardColumns.archivedAt)))
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
  template?: "roblox" | "empty";
  visibility?: ProjectVisibility;
}

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
    const [board] = await tx.insert(boards).values({ projectId: row!.id, name: "Board" }).returning();
    if ((input.template ?? "roblox") === "roblox") {
      await tx.insert(boardColumns).values(
        ROBLOX_TEMPLATE.map((c, i) => ({
          boardId: board!.id,
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
    await tx.insert(projectMembers).values({ projectId: row!.id, userId: actor.userId }).onConflictDoNothing();
    await logActivity(tx, { studioId: access.studioId, projectId: row!.id, actorId: actor.userId, type: "project.created", data: { name: row!.name } });
    await audit(tx, actor, { studioId: access.studioId, action: "project.created", targetType: "project", targetId: row!.id, data: { name: row!.name } });
    return row!;
  });
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

export async function setProjectArchived(actor: Actor, input: { projectId: string; archived: boolean }) {
  const access = await requireProject(actor.userId, input.projectId, "project.delete");
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ archivedAt: input.archived ? now() : null }).where(eq(projects.id, access.project.id));
    await audit(tx, actor, {
      studioId: access.studioId,
      action: input.archived ? "project.archived" : "project.restored",
      targetType: "project",
      targetId: access.project.id,
    });
  });
  new Effects().project(access.project.id).flush(actor.clientId);
  return { ok: true };
}

/** Irreversible: removes the project, its board, cards, history and media. Requires typing the project name. */
export async function deleteProject(actor: Actor, input: { projectId: string; confirm: string }) {
  const access = await requireProject(actor.userId, input.projectId, "project.delete");
  if (input.confirm.trim() !== access.project.name) throw invalid(`Type "${access.project.name}" to confirm.`);
  const files = await db.select().from(attachments).where(eq(attachments.projectId, access.project.id));
  await db.transaction(async (tx) => {
    await audit(tx, actor, {
      studioId: access.studioId,
      action: "project.deleted",
      targetType: "project",
      targetId: access.project.id,
      data: { name: access.project.name, cards: access.project.cardCounter },
    });
    await tx.delete(cards).where(eq(cards.projectId, access.project.id));
    await tx.delete(projects).where(eq(projects.id, access.project.id));
  });
  const store = storage();
  for (const f of files) {
    for (const key of [f.storageKey, f.thumbnailKey, f.previewKey, f.playbackKey]) {
      if (key) await store.delete(key).catch(() => {});
    }
  }
  return { ok: true };
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
      const studioRole: Role = isRole(m.role) ? m.role : "VIEWER";
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
        projectRole: (override?.role && isRole(override.role) ? override.role : null) as Role | null,
        isProjectMember: Boolean(override) || isStudioWideRole(studioRole),
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
  if (input.role && !roleHas(access.role, "members.manage") && input.role !== "VIEWER" && input.role !== "MEMBER") {
    throw forbidden();
  }
  if (input.role === "OWNER") throw invalid("Owner is a studio-wide role.");
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
