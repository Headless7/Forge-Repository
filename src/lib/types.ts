/**
 * Data transfer objects shared by the server (producers) and the client (consumers).
 * Dates are ISO strings so every DTO is JSON-serialisable.
 */
import type { NotificationType } from "./notifications";
import type { CardPermissions, ItemPermissions, MemberAccess, Permission, Role } from "./permissions";

export type CardState = "NOT_SUBMITTED" | "IN_PROGRESS" | "NEEDS_REVIEW" | "CHANGES_REQUESTED" | "APPROVED";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type CardDisplayMode = "VISUAL" | "COMPACT";
export type AttachmentKind = "IMAGE" | "VIDEO" | "AUDIO" | "ROBLOX" | "FILE";
export type AttachmentPurpose = "VERSION" | "CARD" | "COMMENT" | "RESOURCE" | "COVER" | "CHECKLIST" | "ITEM";
export type ForumKind = "BUGS" | "QA" | "CUSTOM";
export type ItemStatus = "OPEN" | "IN_PROGRESS" | "FIXED" | "VERIFIED" | "CLOSED";
export type ItemPriority = "LOW" | "MEDIUM" | "HIGH" | "GAME_BREAKING";
export type ItemResolution = "WONT_FIX" | "CANNOT_REPRODUCE" | "DUPLICATE" | "NOT_A_BUG";
export type ProductionStatus = "TODO" | "COMPLETED" | "PUBLISHED";
export type BoardView = "CATEGORY" | "PRODUCTION" | "TIMELINE" | "CALENDAR";
export type DeliverableLinkType = "DEPENDENCY" | "ASSOCIATION";
export type AttachmentStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";
export type VersionStatus = "DRAFT" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED";
export type ReviewAction = "SUBMITTED" | "APPROVED" | "CHANGES_REQUESTED" | "WITHDRAWN" | "REOPENED";
export type CommentKind = "DISCUSSION" | "FEEDBACK";
export type AnnotationType = "POINT" | "REGION" | "TIMESTAMP";
export type ProjectVisibility = "STUDIO" | "PRIVATE";

export interface ProjectSettings {
  /** When false, people assigned to a card cannot approve it themselves. */
  allowSelfApproval: boolean;
  /** When true, "Request changes" must include at least one feedback item. */
  requireFeedbackForChanges: boolean;
  /** Added as reviewers on every new card. */
  defaultReviewerIds: string[];
}

export interface ForumSettings {
  /** Verifies every new item of the forum unless the reporter picks someone else (the lead scripter, typically). */
  defaultReviewerId: string | null;
}

export interface CardLink {
  id: string;
  label: string;
  url: string;
}

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  avatarColor: string;
}

/** A member's connected Discord account, as last refreshed: shown beside the studio name, never instead of it. */
export interface DiscordIdentityDTO {
  /** Unique username (handle). */
  username: string;
  /** Discord display name, when set. */
  displayName: string | null;
}

export interface MemberDTO extends UserDTO {
  role: Role;
  title: string | null;
  /** Connected Discord account (null when not connected). */
  discord: DiscordIdentityDTO | null;
  online: boolean;
  /** PROJECTS: an external collaborator limited to the projects they were added to. */
  access: MemberAccess;
}

export interface LabelDTO {
  id: string;
  name: string;
  color: string;
}

export interface MilestoneDTO {
  id: string;
  name: string;
  description: string;
  dueAt: string | null;
  releasedAt: string | null;
  archived: boolean;
}

export interface ColumnDTO {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  defaultCardMode: CardDisplayMode | null;
}

export interface MediaRefDTO {
  attachmentId: string;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "ROBLOX";
  status: AttachmentStatus;
  thumbUrl: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface CardCountsDTO {
  comments: number;
  attachments: number;
  unresolvedFeedback: number;
  resolvedFeedback: number;
  checklistDone: number;
  checklistTotal: number;
  /** Unticked checklist items given to the viewer. */
  checklistMine: number;
  /** Earliest due day ("YYYY-MM-DD") of an unticked item, so the board can flag overdue ones. */
  checklistNextDue: string | null;
  versions: number;
}

/** Revision of one deliverable recorded when a card was completed or published. */
export interface ProductionSnapshotEntry {
  deliverableId: string;
  name: string;
  required: boolean;
  versionId: string | null;
  versionNumber: number | null;
}

/** Progress across a card's active deliverables. "Has files", "in review" and "approved" are distinct. */
export interface DeliverableProgressDTO {
  total: number;
  required: number;
  /** Current revision has at least one uploaded file. */
  withFiles: number;
  inReview: number;
  changesRequested: number;
  inProgress: number;
  notStarted: number;
  approved: number;
  approvedRequired: number;
  /** Waiting on an unapproved prerequisite. */
  blocked: number;
}

export interface CardSummaryDTO {
  id: string;
  key: string;
  number: number;
  title: string;
  columnId: string;
  position: number;
  /** Review roll-up across deliverables. */
  state: CardState;
  productionStatus: ProductionStatus;
  productionPosition: number;
  progress: DeliverableProgressDTO;
  /** Completed/published, but a deliverable has changed since (new revision or reopened). */
  pendingChanges: boolean;
  hasAudio: boolean;
  hasRoblox: boolean;
  priority: Priority;
  displayMode: CardDisplayMode | null;
  /** Planned start (optional). */
  startAt: string | null;
  dueAt: string | null;
  milestoneId: string | null;
  assigneeIds: string[];
  /** People responsible for, or contributing to, the card's active deliverables. */
  deliverableAssigneeIds: string[];
  labelIds: string[];
  cover: MediaRefDTO | null;
  /** AUTO: follows the first deliverable's current file. MANUAL: someone chose it. NONE: no cover. */
  coverMode: "AUTO" | "MANUAL" | "NONE";
  counts: CardCountsDTO;
  hasVideo: boolean;
  hasImage: boolean;
  unread: boolean;
  createdById: string | null;
  currentVersionNumber: number | null;
  updatedAt: string;
  lastActivityAt: string;
}

export interface ProjectDTO {
  id: string;
  studioId: string;
  name: string;
  slug: string;
  key: string;
  description: string;
  icon: string;
  color: string;
  background: string;
  visibility: ProjectVisibility;
  defaultCardMode: CardDisplayMode;
  settings: ProjectSettings;
  archived: boolean;
}

export interface ViewerDTO {
  userId: string;
  role: Role;
  permissions: Permission[];
}

/** What creating a project from a template would copy (and leave out). */
export interface ProjectTemplatePreviewDTO {
  source: { id: string; name: string; icon: string; color: string; key: string };
  boards: Array<{ name: string; description: string; icon: string | null; columns: Array<{ name: string; icon: string | null; color: string | null }> }>;
  labels: Array<{ name: string; color: string }>;
  settings: {
    visibility: ProjectVisibility;
    defaultCardMode: CardDisplayMode;
    background: string;
    allowSelfApproval: boolean;
    requireFeedbackForChanges: boolean;
    defaultReviewers: number;
  };
  /** Explicit members of the template: copied unless `excluded` says why not. */
  people: Array<{
    userId: string;
    displayName: string;
    username: string;
    avatarUrl: string | null;
    avatarColor: string;
    studioRole: Role;
    projectRole: Role | null;
    /** Project-only collaborator: copying gives them this new project too. */
    projectsOnly: boolean;
    excluded: string | null;
    note: string | null;
  }>;
  notCopied: string[];
}

/** One deliverable in a dashboard drill-down list. */
export interface DashboardItemDTO {
  deliverableId: string;
  cardId: string;
  cardKey: string;
  cardTitle: string;
  number: number;
  name: string;
  state: CardState;
  required: boolean;
  board: { number: number; name: string };
  dueAt: string | null;
  dueInherited: boolean;
  /** Responsible people and contributors (or the card's assignees when it inherits). */
  people: string[];
  reviewerIds: string[];
  /** Why it's on this list: "waiting on Model", "in review for 3 days", "no activity for 20 days". */
  note: string | null;
}

export type DashboardListKey =
  | `state:${CardState}`
  | "overdue"
  | "dueSoon"
  | "blocked"
  | "unassigned"
  | "stale"
  | "queue"
  | `person:${string}`
  | `milestone:${string}`;

export interface DurationStatDTO {
  /** Hours. */
  median: number | null;
  p75: number | null;
  /** How many samples. */
  n: number;
}

export interface ProjectDashboardDTO {
  project: { id: string; slug: string; name: string; icon: string; key: string };
  boards: Array<{ id: string; number: number; name: string }>;
  milestoneOptions: Array<{ id: string; name: string }>;
  range: { from: string; to: string };
  generatedAt: string;
  /** Earliest entry in the review log the flow metrics can draw on. */
  historySince: string | null;
  status: { byState: Record<CardState, number>; total: number; required: number; requiredApproved: number };
  risk: { overdue: number; dueSoon: number; blocked: number; unassigned: number; stale: number };
  review: {
    queue: number;
    oldestWaitingHours: number | null;
    /** Submission → first decision (approve or request changes). */
    firstReview: DurationStatDTO;
    /** First submission of a round → approval. */
    toApproval: DurationStatDTO;
    decisions: number;
    changesRequested: number;
    approvals: number;
    /** Approvals that needed at least one round of changes first. */
    approvalsAfterChanges: number;
  };
  /** Deliverables approved per week (weeks start on Monday, UTC). */
  throughput: Array<{ weekStart: string; approved: number }>;
  /** Deliverable created → first approved, for those first approved in the range. */
  cycleTime: DurationStatDTO;
  workload: Array<{ userId: string; displayName: string; avatarUrl: string | null; avatarColor: string; responsible: number; contributing: number; overdue: number; dueSoon: number; reviewing: number }>;
  milestones: Array<{
    id: string;
    name: string;
    dueAt: string | null;
    released: boolean;
    required: number;
    approved: number;
    /** Required deliverables approved per day over the last 4 weeks. */
    ratePerDay: number;
    projectedAt: string | null;
    forecast: "done" | "on-track" | "at-risk" | "late" | "no-due-date" | "no-progress";
  }>;
}

export interface StudioDashboardRowDTO {
  project: { id: string; slug: string; name: string; icon: string };
  open: number;
  required: number;
  requiredApproved: number;
  overdue: number;
  blocked: number;
  queue: number;
  approvedThisWeek: number;
}

/** A deliverable on the timeline/calendar: effective dates (own, or inherited from the card). */
export interface ScheduleDeliverableDTO {
  id: string;
  number: number;
  name: string;
  state: CardState;
  required: boolean;
  startAt: string | null;
  dueAt: string | null;
  /** Its own dates (null where the card's apply). */
  ownStartAt: string | null;
  ownDueAt: string | null;
  /** Unapproved prerequisites it waits on. */
  blockedBy: string[];
  /** The viewer is responsible for, contributes to, or reviews it. */
  mine: boolean;
}

export interface ScheduleCardDTO {
  id: string;
  key: string;
  number: number;
  title: string;
  state: CardState;
  project: { id: string; slug: string; name: string; icon: string; key: string; studioSlug: string };
  board: { id: string; number: number; name: string };
  columnId: string;
  startAt: string | null;
  dueAt: string | null;
  assigneeIds: string[];
  /** The viewer may change the card's (and its deliverables') dates. */
  canEdit: boolean;
  /** The viewer is assigned to the card or works on one of its deliverables. */
  mine: boolean;
  deliverables: ScheduleDeliverableDTO[];
  links: Array<{ fromId: string; toId: string; type: DeliverableLinkType }>;
}

/** A checklist item with a due day, for the calendars. */
export interface ScheduleChecklistItemDTO {
  id: string;
  text: string;
  /** "YYYY-MM-DD": due by the end of that day. */
  dueOn: string;
  assigneeId: string | null;
  checklistTitle: string;
  card: { id: string; key: string; title: string; project: ScheduleCardDTO["project"]; board: { id: string; number: number; name: string } };
}

/** Scheduled work overlapping a date range, for the timeline and calendars. */
export interface ScheduleDTO {
  from: string;
  to: string;
  cards: ScheduleCardDTO[];
  milestones: Array<{ id: string; name: string; dueAt: string; released: boolean; project: { id: string; slug: string; name: string; icon: string; studioSlug: string } }>;
  /** Active cards with no dates at all (board and project scopes), to be scheduled. */
  unscheduled: Array<{ id: string; key: string; title: string; state: CardState; boardNumber: number }>;
  unscheduledTotal: number;
  /** More matched than were returned (very busy ranges). */
  truncated: boolean;
  /** Unticked checklist items due in the range (in the "mine" scopes, the viewer's own). */
  checklistItems: ScheduleChecklistItemDTO[];
}

/** A board in the project's switcher — light: no columns or cards. */
export interface BoardSummaryDTO {
  id: string;
  /** Stable address inside the project: /studio/project/b/<number>. */
  number: number;
  name: string;
  description: string;
  /** Lucide name (lib/board-icons); null = the default icon. */
  icon: string | null;
  position: number;
  /** Active cards on the board. */
  cards: number;
}

export interface BoardDTO {
  project: ProjectDTO;
  boardId: string;
  /** The board being shown. */
  board: BoardSummaryDTO;
  /** Every active board of the project, in switcher order (the first is the default). */
  boards: BoardSummaryDTO[];
  columns: ColumnDTO[];
  cards: CardSummaryDTO[];
  members: MemberDTO[];
  labels: LabelDTO[];
  milestones: MilestoneDTO[];
  /** Live forums of the project (Bugs, QA, custom ones), for the header menu. */
  forums: Array<{ id: string; slug: string; name: string; icon: string }>;
  viewer: ViewerDTO;
  prefs: { collapsedColumnIds: string[]; view: BoardView };
  /** This board's own background: a preset (null = the project's), or an uploaded image shown instead. */
  background: { preset: string | null; imageUrl: string | null };
}

/** Demonstration clips are short by design: the cap applies on top of the studio's video limit. */
export const DEMO_CLIP_MAX_BYTES = 20 * 1024 * 1024;

/** Why a chosen demonstration clip can't be used, or null when it can. Checked before the upload starts. */
export function demoClipProblem(file: { size: number }): string | null {
  if (file.size > DEMO_CLIP_MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(file.size >= 100 * 1024 * 1024 ? 0 : 1);
    return `That clip is ${mb} MB, which passes the 20 MB limit for demonstration clips. Trim or compress it and try again.`;
  }
  return null;
}

export interface AttachmentDTO {
  id: string;
  /** Null for files on a forum item. */
  cardId: string | null;
  /** The forum item (bug report, QA check) an ITEM file belongs to. */
  itemId: string | null;
  /** A demonstration clip of this other file in the same revision (shown inside its preview). */
  demoOfId: string | null;
  versionId: string | null;
  deliverableId: string | null;
  commentId: string | null;
  purpose: AttachmentPurpose;
  kind: AttachmentKind;
  status: AttachmentStatus;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  /** Signed URL of the playable/viewable media (transcode when available). */
  url: string | null;
  thumbUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  uploadedById: string | null;
  createdAt: string;
  error: string | null;
  /** AUDIO: codec/sample rate/channels · ROBLOX: file summary (RobloxFileMeta). */
  meta: Record<string, unknown> | null;
  previewConfig: Record<string, unknown> | null;
  /** AUDIO: waveform peaks JSON · ROBLOX: preview manifest JSON (signed). */
  derivedUrl: string | null;
}

export interface VersionDTO {
  id: string;
  deliverableId: string;
  number: number;
  notes: string;
  status: VersionStatus;
  createdById: string | null;
  createdAt: string;
  submittedAt: string | null;
  submittedById: string | null;
  decidedAt: string | null;
  decidedById: string | null;
  attachmentIds: string[];
  feedbackCount: number;
  unresolvedCount: number;
}

export interface AnnotationDTO {
  id: string;
  type: AnnotationType;
  attachmentId: string;
  versionId: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  timestampMs: number | null;
}

export interface ReactionDTO {
  emoji: string;
  userIds: string[];
}

export interface CommentDTO {
  id: string;
  parentId: string | null;
  authorId: string | null;
  kind: CommentKind;
  body: string;
  deliverableId: string | null;
  versionId: string | null;
  attachmentId: string | null;
  reviewId: string | null;
  resolvedAt: string | null;
  resolvedById: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  annotation: AnnotationDTO | null;
  reactions: ReactionDTO[];
  attachments: AttachmentDTO[];
  mentions: string[];
  replies: CommentDTO[];
}

export interface ReviewDTO {
  id: string;
  deliverableId: string | null;
  versionId: string | null;
  actorId: string | null;
  action: ReviewAction;
  note: string;
  createdAt: string;
  feedbackIds: string[];
}

export interface ChecklistItemDTO {
  id: string;
  text: string;
  isDone: boolean;
  position: number;
  doneById: string | null;
  doneAt: string | null;
  /** The one person doing it. */
  assigneeId: string | null;
  /** The day it is due ("YYYY-MM-DD"; due by the end of that day). */
  dueOn: string | null;
  /** Its reference image (an IMAGE attachment on the card), if any. */
  imageId: string | null;
}

export interface ChecklistDTO {
  id: string;
  title: string;
  position: number;
  items: ChecklistItemDTO[];
}

export interface ActivityDTO {
  id: string;
  type: string;
  actorId: string | null;
  actor: UserDTO | null;
  cardId: string | null;
  card: { id: string; key: string; title: string } | null;
  /** The forum item an item.* event is about. */
  item: { id: string; number: number; key: string; title: string; forumSlug: string; forumName: string } | null;
  project: { id: string; name: string; slug: string; icon: string } | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface DeliverablePermissions {
  canEdit: boolean;
  canUpload: boolean;
  canSubmit: boolean;
  canReview: boolean;
  canResolveFeedback: boolean;
}

export interface DeliverableDTO {
  id: string;
  number: number;
  name: string;
  description: string;
  assetType: string;
  required: boolean;
  state: CardState;
  /** Responsible person; with no one set (and no contributors) the card's assignees are. */
  ownerId: string | null;
  /** People working on it alongside the responsible person. */
  contributorIds: string[];
  /** Reviewer; with no one set the card's reviewers review it. */
  reviewerId: string | null;
  /** Own planned start; with none set the card's start applies. */
  startAt: string | null;
  /** Own deadline; with none set the card's deadline applies. */
  dueAt: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  canvasX: number;
  canvasY: number;
  /** Node size on the canvas; null = default (see lib/canvas-points). */
  canvasW: number | null;
  canvasH: number | null;
  position: number;
  createdById: string | null;
  createdAt: string;
  archivedAt: string | null;
  cover: MediaRefDTO | null;
  /** AUTO: follows its current file. MANUAL: someone chose it. NONE: no cover. */
  coverMode: "AUTO" | "MANUAL" | "NONE";
  /** The chosen cover (MANUAL), whether or not it can be shown right now. */
  coverPinnedId: string | null;
  /** Colour of its card (canvas tint and edge, list stripe); null = none. */
  color: string | null;
  versionCount: number;
  /** Current revision has at least one uploaded file. */
  hasFiles: boolean;
  /** Kinds of the files in the current revision. */
  kinds: AttachmentKind[];
  openFeedback: number;
  /** Prerequisites (dependency links) that aren't approved yet. */
  blockedBy: string[];
  permissions: DeliverablePermissions;
}

export interface DeliverableLinkDTO {
  id: string;
  fromId: string;
  toId: string;
  type: DeliverableLinkType;
  /** Connection points ("r-50"); null = the default sides. */
  fromPoint: string | null;
  toPoint: string | null;
  note: string;
  createdById: string | null;
  createdAt: string;
}

export interface ProductionEventDTO {
  id: string;
  actorId: string | null;
  fromStatus: ProductionStatus;
  toStatus: ProductionStatus;
  note: string;
  snapshot: ProductionSnapshotEntry[];
  createdAt: string;
}

export interface ReadinessDTO {
  /** Every required deliverable is approved at its current revision. */
  ready: boolean;
  blockers: Array<{ deliverableId: string; name: string; reason: string }>;
  /** Differences from the last completion/publication record. */
  pendingChanges: Array<{ deliverableId: string; name: string; detail: string }>;
}

export interface CardDetailDTO extends CardSummaryDTO {
  projectId: string;
  boardId: string;
  description: string;
  revision: number;
  estimateHours: number | null;
  links: CardLink[];
  reviewerIds: string[];
  watcherIds: string[];
  createdAt: string;
  archivedAt: string | null;
  deliverables: DeliverableDTO[];
  deliverableLinks: DeliverableLinkDTO[];
  productionEvents: ProductionEventDTO[];
  productionSnapshot: ProductionSnapshotEntry[];
  readiness: ReadinessDTO;
  completedAt: string | null;
  publishedAt: string | null;
  versions: VersionDTO[];
  /** The chosen cover (MANUAL), whether or not it can be shown right now. */
  coverPinnedId: string | null;
  attachments: AttachmentDTO[];
  comments: CommentDTO[];
  reviews: ReviewDTO[];
  checklists: ChecklistDTO[];
  permissions: CardPermissions;
}

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  actor: UserDTO | null;
  studio: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string; icon: string } | null;
  /** The board the card is on. */
  board: { number: number; name: string } | null;
  card: { id: string; key: string; title: string } | null;
  /** The forum item it's about (item notifications). */
  item: { id: string; number: number; key: string; title: string; forumSlug: string; forumName: string } | null;
  /** The deliverable (and revision) it's about, when it's about one. */
  deliverable: { id: string; number: number; name: string } | null;
  versionNumber: number | null;
  commentId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
  href: string;
}

export interface StudioSummaryDTO {
  id: string;
  name: string;
  slug: string;
  iconEmoji: string | null;
  accentColor: string;
  role: Role;
}

export interface ProjectListItemDTO {
  id: string;
  name: string;
  slug: string;
  key: string;
  icon: string;
  color: string;
  description: string;
  archived: boolean;
  counts: { cards: number; needsReview: number; changesRequested: number; approved: number; inProgress: number };
  /** Live boards in switcher order (the first is where the project opens). */
  boards: Array<{ id: string; number: number; name: string; icon: string | null }>;
  /** Live forums (Bugs, QA, custom ones) in order. */
  forums: Array<{ id: string; slug: string; name: string; icon: string }>;
  /** The viewer's effective role here allows the producer dashboard (project overrides count). */
  canViewReports: boolean;
}

export interface SearchResultDTO {
  card: CardSummaryDTO;
  project: { id: string; slug: string; name: string; icon: string; key: string };
  /** The board the card is on (results open there). */
  board: { id: string; number: number; name: string };
  columnName: string;
  matchedIn: Array<"title" | "description" | "comment" | "label" | "assignee" | "column" | "key">;
  snippet: string | null;
}

// ── Forums ──────────────────────────────────────────────────────────────────

export interface ForumDTO {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  kind: ForumKind;
  keyPrefix: string;
  /** What one item is called ("bug", "issue"). */
  itemLabel: string;
  position: number;
  settings: ForumSettings;
  archived: boolean;
}

export interface ForumTagDTO {
  id: string;
  name: string;
  color: string;
}

/** An item on the list: everything the rows, filters and counts need; no description or files. */
export interface ForumItemSummaryDTO {
  id: string;
  forumId: string;
  projectId: string;
  number: number;
  /** "UTD-B12". */
  key: string;
  title: string;
  status: ItemStatus;
  priority: ItemPriority;
  resolution: ItemResolution | null;
  /** The update it belongs to (null: none). */
  milestoneId: string | null;
  assigneeId: string | null;
  reviewerId: string | null;
  reportedById: string | null;
  tagIds: string[];
  counts: { attachments: number; comments: number };
  /** The first picture or clip, for the list. */
  cover: MediaRefDTO | null;
  fixedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ForumCommentDTO {
  id: string;
  authorId: string | null;
  body: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ForumItemDetailDTO extends ForumItemSummaryDTO {
  description: string;
  fixedById: string | null;
  verifiedById: string | null;
  closedById: string | null;
  attachments: AttachmentDTO[];
  comments: ForumCommentDTO[];
  permissions: ItemPermissions;
}

/** One forum in one call: its items (resolved ones too), tags and the project's updates. The list filters client-side. */
export interface ForumViewDTO {
  project: { id: string; name: string; slug: string; key: string; icon: string; archived: boolean };
  forum: ForumDTO;
  /** Every live forum of the project, for switching. */
  forums: ForumDTO[];
  items: ForumItemSummaryDTO[];
  tags: ForumTagDTO[];
  milestones: MilestoneDTO[];
  viewer: ViewerDTO;
}
