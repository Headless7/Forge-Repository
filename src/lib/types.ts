/**
 * Data transfer objects shared by the server (producers) and the client (consumers).
 * Dates are ISO strings so every DTO is JSON-serialisable.
 */
import type { CardPermissions, Permission, Role } from "./permissions";

export type CardState = "NOT_SUBMITTED" | "IN_PROGRESS" | "NEEDS_REVIEW" | "CHANGES_REQUESTED" | "APPROVED";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type CardDisplayMode = "VISUAL" | "COMPACT";
export type AttachmentKind = "IMAGE" | "VIDEO" | "AUDIO" | "ROBLOX" | "FILE";
export type AttachmentPurpose = "VERSION" | "CARD" | "COMMENT" | "RESOURCE" | "COVER";
export type ProductionStatus = "TODO" | "COMPLETED" | "PUBLISHED";
export type BoardView = "CATEGORY" | "PRODUCTION";
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

export interface MemberDTO extends UserDTO {
  role: Role;
  title: string | null;
  online: boolean;
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
  dueAt: string | null;
  milestoneId: string | null;
  assigneeIds: string[];
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

export interface BoardDTO {
  project: ProjectDTO;
  boardId: string;
  columns: ColumnDTO[];
  cards: CardSummaryDTO[];
  members: MemberDTO[];
  labels: LabelDTO[];
  milestones: MilestoneDTO[];
  viewer: ViewerDTO;
  prefs: { collapsedColumnIds: string[]; view: BoardView };
}

export interface AttachmentDTO {
  id: string;
  cardId: string;
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
  ownerId: string | null;
  reviewerId: string | null;
  dueAt: string | null;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  canvasX: number;
  canvasY: number;
  position: number;
  createdById: string | null;
  createdAt: string;
  archivedAt: string | null;
  cover: MediaRefDTO | null;
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
  type: string;
  actor: UserDTO | null;
  studio: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string; icon: string } | null;
  card: { id: string; key: string; title: string } | null;
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
}

export interface SearchResultDTO {
  card: CardSummaryDTO;
  project: { id: string; slug: string; name: string; icon: string; key: string };
  columnName: string;
  matchedIn: Array<"title" | "description" | "comment" | "label" | "assignee" | "column" | "key">;
  snippet: string | null;
}
