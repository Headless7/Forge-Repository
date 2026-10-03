/**
 * Creating a project from another project: its reusable setup and access, never its production
 * content. Copied: active boards (names, descriptions, order) with their active columns, labels,
 * visibility, the card layout and review workflow, and explicit project memberships. Not copied:
 * cards, deliverables, files, comments, reviews, activity, deadlines, milestones, invitations or
 * anything archived. The new project gets fresh identifiers throughout and shares nothing with
 * its source afterwards.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { canGrantRole, isStudioWideRole, memberCanOpenProject, normalizeRole, ROLE_LABELS, type Role } from "@/lib/permissions";
import type { ProjectSettings, ProjectTemplatePreviewDTO } from "@/lib/types";
import { asRole, requireProject, requireStudio, type StudioAccess } from "../access";
import { db, type Executor } from "../db";
import { boardColumns, boards, labels, projectMembers, projects, studioMembers, users } from "../db/schema";
import { invalid, notFound } from "../errors";
import { insertBoard } from "./board";
import type { Actor } from "./context";
import { avatarUrl } from "./users-lookup";

type ProjectRow = typeof projects.$inferSelect;

interface TemplatePerson {
  userId: string;
  displayName: string;
  username: string;
  avatarKey: string | null;
  avatarColor: string;
  studioRole: Role;
  projectsOnly: boolean;
  /** The project role to copy (null = their studio role). */
  role: Role | null;
  /** Why they can't be copied (null = they will be). */
  excluded: string | null;
  /** A project role they had that won't be copied (they join with their studio role). */
  roleDropped: string | null;
}

/** The source project, checked: same studio, open to the creator, not archived. */
async function loadSource(actor: Actor, creator: StudioAccess, sourceProjectId: string): Promise<ProjectRow> {
  const access = await requireProject(actor.userId, sourceProjectId, "project.view").catch(() => {
    throw notFound("Template project");
  });
  if (access.studioId !== creator.studioId) throw notFound("Template project");
  if (access.project.archivedAt) throw invalid("Archived projects can't be used as templates. Restore it first, or choose another project.");
  return access.project;
}

/**
 * Who the template's explicit memberships would bring along, and who can't come: people who left
 * the studio, and project roles the creator isn't allowed to hand out.
 */
async function templatePeople(ex: Executor, creator: StudioAccess, source: ProjectRow): Promise<TemplatePerson[]> {
  const rows = await ex
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      studioRole: studioMembers.role,
      studioAccess: studioMembers.access,
      displayName: users.displayName,
      username: users.username,
      avatarKey: users.avatarKey,
      avatarColor: users.avatarColor,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .leftJoin(studioMembers, and(eq(studioMembers.userId, projectMembers.userId), eq(studioMembers.studioId, source.studioId)))
    .where(eq(projectMembers.projectId, source.id))
    .orderBy(asc(users.displayName));
  return rows.map((r) => {
    const studioRole = r.studioRole ? asRole(r.studioRole) : null;
    const override = normalizeRole(r.role);
    const base = {
      userId: r.userId,
      displayName: r.displayName,
      username: r.username,
      avatarKey: r.avatarKey,
      avatarColor: r.avatarColor,
      studioRole: studioRole ?? "VIEWER",
      projectsOnly: r.studioAccess === "PROJECTS" && !isStudioWideRole(studioRole ?? "VIEWER"),
    };
    if (!studioRole) return { ...base, role: null, excluded: "No longer a member of the studio", roleDropped: null };
    // Project roles only ever narrow or widen work permissions; the creator must be able to grant them.
    if (override && (override === "OWNER" || !canGrantRole(creator.role, override))) {
      return { ...base, role: null, excluded: null, roleDropped: `${ROLE_LABELS[override]} on the template — you can't give that role, so they'd join with their studio role` };
    }
    return { ...base, role: override, excluded: null, roleDropped: null };
  });
}

export async function previewProjectTemplate(actor: Actor, input: { studioId: string; sourceProjectId: string }): Promise<ProjectTemplatePreviewDTO> {
  const creator = await requireStudio(actor.userId, input.studioId, "project.create");
  const source = await loadSource(actor, creator, input.sourceProjectId);
  const [boardRows, columnRows, labelRows, people] = await Promise.all([
    db.select().from(boards).where(and(eq(boards.projectId, source.id), isNull(boards.archivedAt))).orderBy(asc(boards.position), asc(boards.number)),
    db.select().from(boardColumns).where(and(eq(boardColumns.projectId, source.id), isNull(boardColumns.archivedAt))).orderBy(asc(boardColumns.position)),
    db.select().from(labels).where(eq(labels.projectId, source.id)).orderBy(asc(labels.name)),
    templatePeople(db, creator, source),
  ]);
  const reviewerIds = new Set(source.settings.defaultReviewerIds ?? []);
  return {
    source: { id: source.id, name: source.name, icon: source.icon, color: source.color, key: source.key },
    boards: boardRows.map((b) => ({
      name: b.name,
      description: b.description,
      columns: columnRows.filter((c) => c.boardId === b.id).map((c) => ({ name: c.name, icon: c.icon, color: c.color })),
    })),
    labels: labelRows.map((l) => ({ name: l.name, color: l.color })),
    settings: {
      visibility: source.visibility,
      defaultCardMode: source.defaultCardMode,
      background: source.background,
      allowSelfApproval: source.settings.allowSelfApproval,
      requireFeedbackForChanges: source.settings.requireFeedbackForChanges,
      defaultReviewers: reviewerIds.size,
    },
    people: await Promise.all(
      people.map(async (p) => ({
        userId: p.userId,
        displayName: p.displayName,
        username: p.username,
        avatarUrl: await avatarUrl(p.avatarKey),
        avatarColor: p.avatarColor,
        studioRole: p.studioRole,
        projectRole: p.role,
        projectsOnly: p.projectsOnly,
        excluded: p.excluded,
        note: p.roleDropped,
      })),
    ),
    notCopied: ["Cards, tasks and checklists", "Deliverables, files and revisions", "Comments, feedback, reviews and activity", "Deadlines and milestones", "Pending invitations", "Archived boards and columns"],
  };
}

/**
 * Copies the template's setup into a freshly inserted project, inside the creator's transaction
 * (so a failure leaves no half-copied project). `includeUserIds` narrows who comes along; people
 * the template can't bring (see templatePeople) are always left out.
 */
export async function copyProjectTemplate(
  tx: Executor,
  actor: Actor,
  creator: StudioAccess,
  sourceProjectId: string,
  target: ProjectRow,
  includeUserIds?: string[] | null,
): Promise<{ settings: ProjectSettings; visibility: ProjectRow["visibility"] }> {
  const source = await loadSource(actor, creator, sourceProjectId);
  const [boardRows, columnRows, labelRows, people] = await Promise.all([
    tx.select().from(boards).where(and(eq(boards.projectId, source.id), isNull(boards.archivedAt))).orderBy(asc(boards.position), asc(boards.number)),
    tx.select().from(boardColumns).where(and(eq(boardColumns.projectId, source.id), isNull(boardColumns.archivedAt))).orderBy(asc(boardColumns.position)),
    tx.select().from(labels).where(eq(labels.projectId, source.id)),
    templatePeople(tx, creator, source),
  ]);

  for (const b of boardRows.length ? boardRows : [{ id: null, name: "Board", description: "" }]) {
    const board = await insertBoard(tx, { projectId: target.id, name: b.name, description: b.description, createdById: actor.userId });
    const columns = columnRows.filter((c) => c.boardId === b.id);
    if (columns.length) {
      await tx.insert(boardColumns).values(
        columns.map((c) => ({
          boardId: board.id,
          projectId: target.id,
          name: c.name,
          icon: c.icon,
          color: c.color,
          defaultCardMode: c.defaultCardMode,
          position: c.position,
          createdById: actor.userId,
        })),
      );
    }
  }
  if (labelRows.length) await tx.insert(labels).values(labelRows.map((l) => ({ projectId: target.id, name: l.name, color: l.color })));

  const wanted = includeUserIds ? new Set(includeUserIds) : null;
  const copied = people.filter((p) => !p.excluded && (!wanted || wanted.has(p.userId)) && p.userId !== actor.userId);
  if (copied.length) {
    await tx
      .insert(projectMembers)
      .values(copied.map((p) => ({ projectId: target.id, userId: p.userId, role: p.role })))
      .onConflictDoNothing();
  }

  // Default reviewers come along only if they can open the new project.
  const reviewerIds = source.settings.defaultReviewerIds ?? [];
  const reviewers = reviewerIds.length
    ? await tx
        .select({ userId: studioMembers.userId, role: studioMembers.role, access: studioMembers.access })
        .from(studioMembers)
        .where(and(eq(studioMembers.studioId, source.studioId), inArray(studioMembers.userId, reviewerIds)))
    : [];
  const members = new Set([actor.userId, ...copied.map((p) => p.userId)]);
  const settings: ProjectSettings = {
    ...source.settings,
    defaultReviewerIds: reviewers.filter((r) => memberCanOpenProject(r, { visibility: source.visibility }, members.has(r.userId))).map((r) => r.userId),
  };
  await tx
    .update(projects)
    .set({ settings, visibility: source.visibility, defaultCardMode: source.defaultCardMode, background: source.background })
    .where(eq(projects.id, target.id));
  return { settings, visibility: source.visibility };
}
