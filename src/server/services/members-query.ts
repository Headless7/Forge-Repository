import { and, asc, eq, inArray } from "drizzle-orm";
import { isRole, type Role } from "@/lib/permissions";
import type { MemberDTO } from "@/lib/types";
import { effectiveProjectRole, type ProjectRow } from "../access";
import { db, type Executor } from "../db";
import { projectMembers, studioMembers, users } from "../db/schema";
import { avatarUrl } from "./users-lookup";

const ONLINE_WINDOW_MS = 3 * 60 * 1000;

export function isOnline(lastSeenAt: Date | null): boolean {
  return Boolean(lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_WINDOW_MS);
}

type MemberRow = {
  userId: string;
  role: string;
  title: string | null;
  username: string;
  displayName: string;
  avatarKey: string | null;
  avatarColor: string;
  lastSeenAt: Date | null;
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
  };
}

async function studioMemberRows(studioId: string, ex: Executor = db): Promise<MemberRow[]> {
  return ex
    .select({
      userId: studioMembers.userId,
      role: studioMembers.role,
      title: studioMembers.title,
      username: users.username,
      displayName: users.displayName,
      avatarKey: users.avatarKey,
      avatarColor: users.avatarColor,
      lastSeenAt: users.lastSeenAt,
    })
    .from(studioMembers)
    .innerJoin(users, eq(users.id, studioMembers.userId))
    .where(eq(studioMembers.studioId, studioId))
    .orderBy(asc(users.displayName));
}

export async function listStudioMembers(studioId: string): Promise<MemberDTO[]> {
  const rows = await studioMemberRows(studioId);
  return Promise.all(rows.map((r) => toMemberDTO(r, isRole(r.role) ? r.role : "VIEWER")));
}

/** People who can open the project, with their effective project role. */
export async function listProjectMembers(project: ProjectRow, ex: Executor = db): Promise<MemberDTO[]> {
  const [rows, overrides] = await Promise.all([
    studioMemberRows(project.studioId, ex),
    ex.select().from(projectMembers).where(eq(projectMembers.projectId, project.id)),
  ]);
  const overrideMap = new Map(overrides.map((o) => [o.userId, o]));
  const visible = rows.filter((r) => {
    if (project.visibility === "STUDIO") return true;
    return overrideMap.has(r.userId) || r.role === "OWNER" || r.role === "ADMIN";
  });
  return Promise.all(
    visible.map((r) => {
      const studioRole: Role = isRole(r.role) ? r.role : "VIEWER";
      return toMemberDTO(r, effectiveProjectRole(studioRole, overrideMap.get(r.userId)?.role ?? null));
    }),
  );
}

/** Returns the subset of `userIds` that can access the project. */
export async function filterProjectMembers(project: ProjectRow, userIds: string[], ex: Executor = db): Promise<string[]> {
  if (userIds.length === 0) return [];
  const members = await ex
    .select({ userId: studioMembers.userId, role: studioMembers.role })
    .from(studioMembers)
    .where(and(eq(studioMembers.studioId, project.studioId), inArray(studioMembers.userId, userIds)));
  if (project.visibility === "STUDIO") return members.map((m) => m.userId);
  const overrides = await ex
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), inArray(projectMembers.userId, userIds)));
  const allowed = new Set(overrides.map((o) => o.userId));
  return members.filter((m) => allowed.has(m.userId) || m.role === "OWNER" || m.role === "ADMIN").map((m) => m.userId);
}
