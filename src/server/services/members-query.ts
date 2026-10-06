import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { memberCanOpenProject, type MemberAccess, type Role } from "@/lib/permissions";
import type { MemberDTO } from "@/lib/types";
import { accessibleProjectIds, asRole, effectiveProjectRole, type ProjectRow, type StudioAccess } from "../access";
import { db, type Executor } from "../db";
import { oauthAccounts, projectMembers, projects, studioMembers, users } from "../db/schema";
import { avatarUrl } from "./users-lookup";

const ONLINE_WINDOW_MS = 3 * 60 * 1000;

export function isOnline(lastSeenAt: Date | null): boolean {
  return Boolean(lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_WINDOW_MS);
}

type MemberRow = {
  userId: string;
  role: string;
  access: string;
  title: string | null;
  username: string;
  displayName: string;
  avatarKey: string | null;
  avatarColor: string;
  lastSeenAt: Date | null;
  discordUsername: string | null;
  discordDisplayName: string | null;
};

async function toMemberDTO(row: MemberRow, role: Role): Promise<MemberDTO> {
  return {
    id: row.userId,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: await avatarUrl(row.avatarKey),
    avatarColor: row.avatarColor,
    role,
    title: row.title,
    online: isOnline(row.lastSeenAt),
    access: (row.access === "PROJECTS" && role !== "OWNER" && role !== "ADMIN" ? "PROJECTS" : "STUDIO") as MemberAccess,
    discord: row.discordUsername ? { username: row.discordUsername, displayName: row.discordDisplayName } : null,
  };
}

async function studioMemberRows(studioId: string, ex: Executor = db): Promise<MemberRow[]> {
  return ex
    .select({
      userId: studioMembers.userId,
      role: studioMembers.role,
      access: studioMembers.access,
      title: studioMembers.title,
      username: users.username,
      displayName: users.displayName,
      avatarKey: users.avatarKey,
      avatarColor: users.avatarColor,
      lastSeenAt: users.lastSeenAt,
      // The connected Discord account (one per person; the newest if older data has two).
      discordUsername: sql<string | null>`(select o.provider_username from ${oauthAccounts} o where o.user_id = ${users.id} and o.provider = 'discord' order by o.created_at desc limit 1)`,
      discordDisplayName: sql<string | null>`(select o.display_name from ${oauthAccounts} o where o.user_id = ${users.id} and o.provider = 'discord' order by o.created_at desc limit 1)`,
    })
    .from(studioMembers)
    .innerJoin(users, eq(users.id, studioMembers.userId))
    .where(eq(studioMembers.studioId, studioId))
    .orderBy(asc(users.displayName));
}

export async function listStudioMembers(studioId: string): Promise<MemberDTO[]> {
  const rows = await studioMemberRows(studioId);
  return Promise.all(rows.map((r) => toMemberDTO(r, asRole(r.role))));
}

/** The studio's members as `viewer` may see them: project-only collaborators see just the people on their projects. */
export async function listMembersFor(viewer: StudioAccess): Promise<MemberDTO[]> {
  if (viewer.scope === "STUDIO") return listStudioMembers(viewer.studioId);
  const projectIds = [...(await accessibleProjectIds(viewer.userId, viewer.studioId))];
  const [rows, projectRows, onProjects] = await Promise.all([
    studioMemberRows(viewer.studioId),
    projectIds.length ? db.select().from(projects).where(inArray(projects.id, projectIds)) : Promise.resolve([]),
    projectIds.length
      ? db.select({ projectId: projectMembers.projectId, userId: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, projectIds))
      : Promise.resolve([]),
  ]);
  const on = new Set(onProjects.map((o) => `${o.projectId}:${o.userId}`));
  const visible = rows.filter(
    (r) => r.userId === viewer.userId || projectRows.some((p) => memberCanOpenProject(r, p, on.has(`${p.id}:${r.userId}`))),
  );
  return Promise.all(visible.map((r) => toMemberDTO(r, asRole(r.role))));
}

/** People who can open the project, with their effective project role. */
export async function listProjectMembers(project: ProjectRow, ex: Executor = db): Promise<MemberDTO[]> {
  const [rows, overrides] = await Promise.all([
    studioMemberRows(project.studioId, ex),
    ex.select().from(projectMembers).where(eq(projectMembers.projectId, project.id)),
  ]);
  const overrideMap = new Map(overrides.map((o) => [o.userId, o]));
  const visible = rows.filter((r) => memberCanOpenProject(r, project, overrideMap.has(r.userId)));
  return Promise.all(
    visible.map((r) => {
      const studioRole: Role = asRole(r.role);
      return toMemberDTO(r, effectiveProjectRole(studioRole, overrideMap.get(r.userId)?.role ?? null));
    }),
  );
}

/** Returns the subset of `userIds` that can access the project. */
export async function filterProjectMembers(project: ProjectRow, userIds: string[], ex: Executor = db): Promise<string[]> {
  if (userIds.length === 0) return [];
  const members = await ex
    .select({ userId: studioMembers.userId, role: studioMembers.role, access: studioMembers.access })
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, project.studioId), inArray(studioMembers.userId, userIds)));
  const overrides = await ex
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), inArray(projectMembers.userId, userIds)));
  const onProject = new Set(overrides.map((o) => o.userId));
  return members.filter((m) => memberCanOpenProject(m, project, onProject.has(m.userId))).map((m) => m.userId);
}
