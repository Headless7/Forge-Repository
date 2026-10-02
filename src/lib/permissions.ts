/**
 * Role-based permissions shared by the server (enforcement) and the client (UI affordances).
 * Roles are plain strings in the database so custom roles can later be resolved from a table;
 * everything goes through `roleHas`, which is the single seam to extend.
 */
export const ROLES = ["OWNER", "ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: "Full control of the studio, including deletion and ownership.",
  ADMIN: "Manage projects, team members, boards, cards and settings.",
  MANAGER: "Create and edit cards, assign people, organise columns and review work.",
  MEMBER: "Create cards, work on assigned tasks, upload files, comment and submit work.",
  VIEWER: "View project content and comments without making changes.",
};

export const ROLE_RANK: Record<Role, number> = { OWNER: 50, ADMIN: 40, MANAGER: 30, MEMBER: 20, VIEWER: 10 };

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
  "project.delete",
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

const MEMBER: Permission[] = [
  ...VIEWER,
  "card.create",
  "card.editOwn",
  "card.moveOwn",
  "card.submit",
  "attachment.upload",
  "comment.create",
];

const MANAGER: Permission[] = [
  ...MEMBER,
  "card.edit",
  "card.move",
  "card.assign",
  "card.archive",
  "card.review",
  "card.publish",
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
  "project.delete",
  "card.delete",
];

const OWNER: Permission[] = [...ADMIN, "studio.delete"];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(OWNER),
  ADMIN: new Set(ADMIN),
  MANAGER: new Set(MANAGER),
  MEMBER: new Set(MEMBER),
  VIEWER: new Set(VIEWER),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleHas(role: string, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: string): Permission[] {
  if (!isRole(role)) return [];
  return [...ROLE_PERMISSIONS[role]];
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
  if (!isRole(targetRole)) return actorRole === "OWNER";
  if (targetRole === "OWNER") return actorRole === "OWNER";
  return ROLE_RANK[actorRole] >= ROLE_RANK[targetRole];
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
