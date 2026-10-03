/**
 * Role-based permissions shared by the server (enforcement) and the client (UI affordances).
 * Roles are plain strings in the database so custom roles can later be resolved from a table;
 * everything goes through `roleHas`, which is the single seam to extend.
 */
export const ROLES = ["OWNER", "ADMIN", "MANAGER", "DEVELOPER", "CONTRIBUTOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  DEVELOPER: "Developer",
  CONTRIBUTOR: "Contributor",
  VIEWER: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: "Full control of the studio, including archiving or deleting projects, and ownership.",
  ADMIN: "Create and manage projects (except archiving or deleting them), team members, boards, cards and settings. Sees every project.",
  MANAGER: "Create and edit cards, assign people, organise boards and columns, and review work. Sees private projects.",
  DEVELOPER: "Create cards, work on assigned tasks, upload files, comment and submit work. Sees private projects.",
  CONTRIBUTOR: "Create cards, work on assigned tasks, upload files, comment and submit work. Private projects only when added to them.",
  VIEWER: "View project content and comments without making changes. Private projects only when added to them.",
};

export const ROLE_RANK: Record<Role, number> = { OWNER: 50, ADMIN: 40, MANAGER: 30, DEVELOPER: 25, CONTRIBUTOR: 20, VIEWER: 10 };

/** Roles stored before Member was split into Developer and Contributor read as Contributor. */
export function normalizeRole(value: unknown): Role | null {
  if (value === "MEMBER") return "CONTRIBUTOR";
  return isRole(value) ? value : null;
}

/** Display name for any stored role, including ones recorded before a rename (e.g. in the audit log). */
export function roleLabel(value: unknown): string {
  if (value === "MEMBER") return "Member";
  const role = normalizeRole(value);
  return role ? ROLE_LABELS[role] : typeof value === "string" ? value : "";
}

/** Membership scope: STUDIO = every project the role allows; PROJECTS = only projects the person was added to. */
export const MEMBER_ACCESS = ["STUDIO", "PROJECTS"] as const;
export type MemberAccess = (typeof MEMBER_ACCESS)[number];

/** Owners and admins run the whole studio, so they are never limited to projects. */
export function isStudioWideRole(role: string): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/** Studio roles that open private projects without being added to them (studio-wide members only). */
export const PRIVATE_ACCESS_ROLES: readonly Role[] = ["OWNER", "ADMIN", "MANAGER", "DEVELOPER"];

export function opensPrivateProjects(role: string): boolean {
  return (PRIVATE_ACCESS_ROLES as readonly string[]).includes(role);
}

/**
 * Whether a studio member can open a project — the one rule behind every project access check
 * (mirrored in SQL by `accessibleProjectIds`):
 *  - Owners and admins: every project.
 *  - Project-only collaborators (any role): only the projects they were added to.
 *  - Studio-wide members: every studio project; private ones too for Managers and Developers,
 *    while Contributors and Viewers need to be added to them.
 * `member.role` is the studio role — a project-level role never widens access.
 */
export function memberCanOpenProject(member: { role: string; access: string }, project: { visibility: string }, isProjectMember: boolean): boolean {
  if (isStudioWideRole(member.role)) return true;
  if (member.access === "PROJECTS") return isProjectMember;
  return project.visibility === "STUDIO" || isProjectMember || opensPrivateProjects(member.role);
}

/** Whether the member has the project through their studio role, whatever their explicit membership. */
export function hasAutomaticProjectAccess(member: { role: string; access: string }, project: { visibility: string }): boolean {
  return memberCanOpenProject(member, project, false);
}

export const PERMISSIONS = [
  "studio.update",
  "studio.delete",
  "members.view",
  "members.invite",
  "members.manage",
  "audit.view",
  "project.create",
  "project.view",
  "project.update",
  /** Archive and restore a project (owner only). */
  "project.archive",
  /** Permanently delete a project (owner only). */
  "project.delete",
  /** Create, rename, describe, reorder, archive and restore boards. */
  "board.manage",
  "column.manage",
  "label.manage",
  "milestone.manage",
  "card.create",
  "card.edit",
  "card.editOwn",
  "card.move",
  "card.moveOwn",
  "card.assign",
  "card.archive",
  "card.delete",
  "card.review",
  "card.submit",
  "card.publish",
  "attachment.upload",
  "comment.create",
  "comment.moderate",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ["members.view", "project.view"];

/** Contributors and Developers work on the same things; only their private-project access differs. */
const WORKER: Permission[] = [
  ...VIEWER,
  "card.create",
  "card.editOwn",
  "card.moveOwn",
  "card.submit",
  "attachment.upload",
  "comment.create",
];

const MANAGER: Permission[] = [
  ...WORKER,
  "card.edit",
  "card.move",
  "card.assign",
  "card.archive",
  "card.review",
  "card.publish",
  "board.manage",
  "column.manage",
  "label.manage",
  "milestone.manage",
  "comment.moderate",
];

const ADMIN: Permission[] = [
  ...MANAGER,
  "studio.update",
  "members.invite",
  "members.manage",
  "audit.view",
  "project.create",
  "project.update",
  "card.delete",
];

/** Only the owner archives, restores or deletes projects (and the studio). */
const OWNER: Permission[] = [...ADMIN, "project.archive", "project.delete", "studio.delete"];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(OWNER),
  ADMIN: new Set(ADMIN),
  MANAGER: new Set(MANAGER),
  DEVELOPER: new Set(WORKER),
  CONTRIBUTOR: new Set(WORKER),
  VIEWER: new Set(VIEWER),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleHas(role: string, permission: Permission): boolean {
  const r = normalizeRole(role);
  return r ? ROLE_PERMISSIONS[r].has(permission) : false;
}

export function permissionsFor(role: string): Permission[] {
  const r = normalizeRole(role);
  return r ? [...ROLE_PERMISSIONS[r]] : [];
}

/** Members can only grant roles at or below their own rank; only owners create owners. */
export function canGrantRole(actorRole: string, targetRole: Role): boolean {
  if (!isRole(actorRole)) return false;
  if (targetRole === "OWNER") return actorRole === "OWNER";
  return ROLE_RANK[actorRole] >= ROLE_RANK[targetRole] && roleHas(actorRole, "members.manage");
}

/** Whether `actorRole` may change or remove a member whose current role is `targetRole`. */
export function canManageMember(actorRole: string, targetRole: string): boolean {
  if (!isRole(actorRole) || !roleHas(actorRole, "members.manage")) return false;
  const target = normalizeRole(targetRole);
  if (!target) return actorRole === "OWNER";
  if (target === "OWNER") return actorRole === "OWNER";
  return ROLE_RANK[actorRole] >= ROLE_RANK[target];
}

export interface CardPermissionInput {
  role: string;
  userId: string;
  card: { createdById: string | null; assigneeIds: readonly string[]; archived?: boolean };
  allowSelfApproval: boolean;
}

export interface CardPermissions {
  canView: boolean;
  canEdit: boolean;
  canMove: boolean;
  canAssign: boolean;
  canSelfAssign: boolean;
  canReview: boolean;
  canSubmit: boolean;
  canUpload: boolean;
  canComment: boolean;
  canResolveFeedback: boolean;
  canArchive: boolean;
  canDelete: boolean;
  canModerate: boolean;
  /** Mark work Published (and take it back). Completing only needs canEdit plus approvals. */
  canPublish: boolean;
}

/** Card-level rules. Used verbatim by server-side enforcement and by the UI. */
export function cardPermissions({ role, userId, card, allowSelfApproval }: CardPermissionInput): CardPermissions {
  const has = (p: Permission) => roleHas(role, p);
  const isAssignee = card.assigneeIds.includes(userId);
  const isOwn = isAssignee || card.createdById === userId;
  const canEdit = has("card.edit") || (has("card.editOwn") && isOwn);
  return {
    canView: has("project.view"),
    canEdit,
    canMove: has("card.move") || (has("card.moveOwn") && isOwn),
    canAssign: has("card.assign"),
    canSelfAssign: has("card.create"),
    canReview: has("card.review") && (allowSelfApproval || !isAssignee),
    canSubmit: has("card.submit") && (isOwn || has("card.edit")),
    canUpload: has("attachment.upload") && canEdit,
    canComment: has("comment.create"),
    canResolveFeedback: canEdit || has("card.review"),
    canArchive: has("card.archive") || (has("card.editOwn") && card.createdById === userId),
    canDelete: has("card.delete"),
    canModerate: has("comment.moderate"),
    canPublish: has("card.publish"),
  };
}
