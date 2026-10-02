"use client";

import { createContext, useContext, type RefObject } from "react";
import type {
  AnnotationDTO,
  CardDetailDTO,
  CardState,
  CommentDTO,
  DeliverableDTO,
  DeliverablePermissions,
  MemberDTO,
  ReviewDTO,
  VersionDTO,
} from "@/lib/types";
import type { VideoPlayerHandle } from "../media/video-player";
import type { UploadTarget } from "../upload/upload-manager";

export interface PendingAnnotation {
  attachmentId: string;
  type: "POINT" | "TIMESTAMP";
  x?: number | null;
  y?: number | null;
  timestampMs?: number | null;
}

export interface CommentActions {
  create: (input: {
    body: string;
    kind?: "DISCUSSION" | "FEEDBACK";
    parentId?: string | null;
    /** Scope of a comment that isn't tied to a file: null = the whole card. */
    deliverableId?: string | null;
    versionId?: string | null;
    attachmentId?: string | null;
    annotation?: Omit<AnnotationDTO, "id" | "attachmentId" | "versionId"> | null;
    attachmentIds?: string[];
  }) => Promise<unknown>;
  edit: (commentId: string, body: string) => Promise<unknown>;
  remove: (commentId: string) => void;
  resolve: (commentId: string, resolved: boolean) => void;
  react: (commentId: string, emoji: string) => void;
}

/**
 * The deliverable currently in focus: its revisions, review state, feedback and
 * permissions. Review components read this instead of the whole card, so nothing
 * from another deliverable leaks into a review.
 */
export interface ScopeView {
  deliverable: DeliverableDTO;
  state: CardState;
  versions: VersionDTO[];
  currentVersionId: string | null;
  /** Comments owned by this deliverable (for a simple card, also the card-level discussion). */
  comments: CommentDTO[];
  reviews: ReviewDTO[];
  permissions: DeliverablePermissions & { canComment: boolean };
  uploadTarget: UploadTarget;
}

/** Anything the player on stage can do (video, audio or animation timeline). */
export interface TimelineHandle {
  seek: (ms: number) => void;
  play: () => void;
  pause: () => void;
  currentTimeMs: () => number;
}

export interface WorkspaceValue {
  card: CardDetailDTO;
  /** Active (non-archived) deliverables in list order. */
  deliverables: DeliverableDTO[];
  /** More than one active deliverable — the card has an overview and deliverables are named. */
  multi: boolean;
  scope: ScopeView | null;
  openDeliverable: (deliverableId: string | null) => void;
  members: MemberDTO[];
  membersById: Map<string, MemberDTO>;
  mentionSet: ReadonlySet<string>;
  viewerId: string;
  uploadTarget: UploadTarget;
  versionId: string | null;
  setVersionId: (id: string | null) => void;
  attachmentId: string | null;
  setAttachmentId: (id: string | null) => void;
  activeCommentId: string | null;
  setActiveCommentId: (id: string | null) => void;
  /** Selects a comment, switching deliverable/version/media and seeking to its anchor. */
  focusComment: (comment: CommentDTO) => void;
  pending: PendingAnnotation | null;
  setPending: (p: PendingAnnotation | null) => void;
  player: RefObject<VideoPlayerHandle | null>;
  /** The active timeline (video, audio or animation) for timestamp feedback. */
  timeline: RefObject<TimelineHandle | null>;
  focusFeedbackComposer: () => void;
  registerFeedbackComposer: (focus: () => void) => void;
  comments: CommentActions;
  scrollTo: (section: "feedback" | "discussion" | "history" | "media" | "deliverables") => void;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside the card workspace");
  return ctx;
}

/** Workspace for components that only make sense with a deliverable in focus. */
export function useScope(): WorkspaceValue & { scope: ScopeView } {
  const ctx = useWorkspace();
  if (!ctx.scope) throw new Error("useScope needs a deliverable in focus");
  return ctx as WorkspaceValue & { scope: ScopeView };
}

export function buildScope(card: CardDetailDTO, deliverable: DeliverableDTO, multi: boolean): ScopeView {
  const own = (c: CommentDTO) => c.deliverableId === deliverable.id || (!multi && c.deliverableId === null);
  return {
    deliverable,
    state: deliverable.state,
    versions: card.versions.filter((v) => v.deliverableId === deliverable.id),
    currentVersionId: deliverable.currentVersionId,
    comments: card.comments.filter(own),
    reviews: card.reviews.filter((r) => r.deliverableId === deliverable.id || (!multi && r.deliverableId === null)),
    permissions: { ...deliverable.permissions, canComment: card.permissions.canComment },
    uploadTarget: { id: card.id, projectId: card.projectId, title: card.title, deliverableId: deliverable.id, label: multi ? deliverable.name : undefined },
  };
}
