"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Copy, Eye, Layers, Link2, Paperclip, Plus, Upload, X } from "lucide-react";
import { Dialog as D, VisuallyHidden } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { toast } from "sonner";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { qk, useCardMutation } from "@/lib/queries";
import { errorMessage, rpc, RpcError } from "@/lib/rpc-client";
import type { CardDetailDTO, CommentDTO, DeliverableDTO } from "@/lib/types";
import { cn, isTypingTarget } from "@/lib/utils";
import { pendingCardDrops, useBoard } from "../board/board-context";
import { ColumnIcon } from "../domain/column-icon";
import { DeliverableProgress, ProductionPill } from "../domain/production";
import { StatePill } from "../domain/state";
import type { VideoPlayerHandle } from "../media/video-player";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Kbd, Skeleton } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Tooltip } from "../ui/menu";
import { useUploads } from "../upload/upload-manager";
import { CardSidebar } from "./card-sidebar";
import { CardTabs } from "./card-tabs";
import { Checklists } from "./checklists";
import { DeliverableBreadcrumb, DeliverableHeader } from "./deliverable-header";
import { AddDeliverableDialog, DeliverablesPanel } from "./deliverables-panel";
import { Description } from "./description";
import { FeedbackPanel, MediaSection, UploadVersionDialog } from "./media-section";
import { ReferenceFiles } from "./reference-files";
import { ApproveDialog, FeedbackSummary, RequestChangesDialog, ReviewBanner, SubmitDialog, useReviewDialogs } from "./review-panel";
import { buildScope, useWorkspace, WorkspaceContext, type CommentActions, type PendingAnnotation, type TimelineHandle, type WorkspaceValue } from "./workspace-context";

function TitleEditor({ card }: { card: CardDetailDTO }) {
  const [value, setValue] = useState(card.title);
  const [editing, setEditing] = useState(false);
  const save = useCardMutation("card.update", card.id, card.projectId, { onError: () => setValue(card.title) });
  useEffect(() => {
    if (!editing) setValue(card.title);
  }, [card.title, editing]);
  const commit = () => {
    setEditing(false);
    const title = value.trim();
    if (title && title !== card.title) save.mutate({ cardId: card.id, title, base: { title: card.title } });
    else setValue(card.title);
  };
  if (!card.permissions.canEdit) return <h2 className="text-lg font-semibold leading-snug tracking-tight md:text-xl">{card.title}</h2>;
  return editing ? (
    <textarea
      autoFocus
      value={value}
      rows={1}
      maxLength={200}
      aria-label="Card title"
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          setValue(card.title);
          setEditing(false);
        }
      }}
      style={{ fieldSizing: "content" } as React.CSSProperties}
      className="w-full resize-none rounded-md border border-accent bg-surface-3 px-1.5 py-0.5 text-lg font-semibold leading-snug outline-none md:text-xl"
    />
  ) : (
    <h2>
      <button type="button" onClick={() => setEditing(true)} className="-mx-1.5 rounded-md px-1.5 text-left text-lg font-semibold leading-snug tracking-tight hover:bg-surface-3 md:text-xl" title="Click to rename">
        {card.title}
      </button>
    </h2>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="grid h-full gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid content-start gap-4">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-14" />
        <Skeleton className="aspect-video max-h-[60vh]" />
        <Skeleton className="h-24" />
      </div>
      <div className="grid content-start gap-3">
        <Skeleton className="h-36" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

/** Asks which deliverable dropped or pasted files belong to (cards with several deliverables). */
function DeliverablePicker({ files, onClose }: { files: File[] | null; onClose: () => void }) {
  const { card, deliverables, openDeliverable } = useWorkspace();
  const uploads = useUploads();
  const allowed = deliverables.filter((d) => d.permissions.canUpload);
  return (
    <Dialog open={Boolean(files?.length)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Which deliverable are these files for?" description={`${files?.length ?? 0} file${files?.length === 1 ? "" : "s"} · each deliverable keeps its own revisions`}>
        <ul className="grid gap-1.5">
          {allowed.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => {
                  if (!files) return;
                  void uploads.uploadVersion({ id: card.id, projectId: card.projectId, title: card.title, deliverableId: d.id, label: d.name }, files);
                  onClose();
                  openDeliverable(d.id);
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left hover:border-accent"
              >
                <span className="flex-1">
                  <span className="block text-[13px] font-medium">{d.name}</span>
                  <span className="text-[11.5px] text-fg-muted">
                    {d.assetType || "Deliverable"} · becomes V{d.versionCount + 1}
                  </span>
                </span>
                <StatePill state={d.state} size="sm" />
              </button>
            </li>
          ))}
          {!allowed.length ? <p className="text-[13px] text-fg-muted">You don&apos;t have permission to upload to any deliverable on this card.</p> : null}
        </ul>
        <DialogFooter>
          {card.permissions.canUpload && files ? (
            <Button
              variant="ghost"
              onClick={() => {
                void uploads.uploadFiles({ id: card.id, projectId: card.projectId, title: card.title }, files, "attachment");
                onClose();
              }}
            >
              <Paperclip /> Attach to the card instead
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reads/writes the open deliverable (by number) in the URL so it can be linked and survives reloads. */
function readDeliverableParam(): number | null {
  const d = new URLSearchParams(window.location.search).get("d");
  const n = d ? Number(d) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}
/** A revision number from a link (e.g. a notification), opened once when the card loads. */
function readVersionParam(): number | null {
  const v = new URLSearchParams(window.location.search).get("v");
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}
function writeDeliverableParam(n: number | null) {
  const params = new URLSearchParams(window.location.search);
  if (n) params.set("d", String(n));
  else params.delete("d");
  window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
}

export function CardModal({
  cardKey,
  queue,
  initialAction,
  focusCommentId,
  onClose,
  onNavigate,
}: {
  cardKey: string;
  queue: string[] | null;
  initialAction: "request-changes" | "approve" | null;
  focusCommentId: string | null;
  onClose: () => void;
  onNavigate: (key: string) => void;
}) {
  const board = useBoard();
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const projectId = board.board.project.id;
  const summary = useMemo(() => board.board.cards.find((c) => c.key.toUpperCase() === cardKey.toUpperCase()), [board.board.cards, cardKey]);
  const number = Number(/-(\d+)$/.exec(cardKey)?.[1] ?? NaN);

  // Archived or filtered-out cards aren't in the board payload: resolve by number.
  const resolved = useQuery({
    queryKey: qk.cardByNumber(projectId, number),
    queryFn: async () => {
      const detail = await rpc("card.get", { projectId, number });
      queryClient.setQueryData(qk.card(detail.id), detail);
      return detail.id;
    },
    enabled: !summary && Number.isFinite(number),
    retry: false,
  });
  const cardId = summary?.id ?? resolved.data ?? null;
  const detail = useQuery({
    queryKey: qk.card(cardId ?? "none"),
    queryFn: () => rpc("card.get", { cardId: cardId! }),
    enabled: Boolean(cardId),
    staleTime: 10_000,
  });
  const card = detail.data;

  // Opening a card clears its unread marker.
  const viewedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!card || viewedFor.current === card.id) return;
    viewedFor.current = card.id;
    void rpc("card.viewed", { cardId: card.id }).then(() => {
      // Only the board views: the timeline/calendar caches share this key prefix.
      queryClient.setQueriesData({ queryKey: qk.board(projectId) }, (b: typeof board.board | undefined) =>
        b && "columns" in b ? { ...b, cards: b.cards.map((c) => (c.id === card.id ? { ...c, unread: false } : c)) } : b,
      );
    });
  }, [card, projectId, queryClient]);

  // Opening a card is the moment for card-level tips, most important first (one shows, if any).
  const tutorial = useTutorial();
  const tipsFor = useRef<string | null>(null);
  useEffect(() => {
    if (!card || tipsFor.current === card.id) return;
    tipsFor.current = card.id;
    tutorial.trigger(["card.workspace", "card.review-decision", "card.resolve-feedback", "card.deliverables", "card.canvas", "card.pending-changes", "production.stages"]);
  }, [card, tutorial]);

  // ── Deliverable scope ──────────────────────────────────────────────────────
  const deliverables = useMemo<DeliverableDTO[]>(() => (card ? card.deliverables.filter((d) => !d.archivedAt) : []), [card]);
  const multi = deliverables.length > 1;
  const [activeId, setActiveId] = useState<string | null>(null);
  const initialised = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const versionByDeliverable = useRef(new Map<string, string | null>());
  const [versionId, setVersionIdState] = useState<string | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAnnotation | null>(null);
  const player = useRef<VideoPlayerHandle | null>(null);
  const timeline = useRef<TimelineHandle | null>(null);
  const focusComposer = useRef<() => void>(() => {});
  const { dialog, setDialog } = useReviewDialogs(initialAction);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[] | undefined>(undefined);
  const [decided, setDecided] = useState(false);
  const [pickerFiles, setPickerFiles] = useState<File[] | null>(null);
  const [addingDeliverable, setAddingDeliverable] = useState(false);

  const active = deliverables.find((d) => d.id === activeId) ?? (!multi ? deliverables[0] : undefined) ?? null;
  const scope = useMemo(() => (card && active ? buildScope(card, active, multi) : null), [card, active, multi]);
  const viewKey = active ? active.id : "overview";

  // Pick the starting view once the card loads.
  useEffect(() => {
    if (!card || initialised.current || !deliverables.length) return;
    initialised.current = true;
    const fromUrl = readDeliverableParam();
    let start: DeliverableDTO | undefined = fromUrl ? deliverables.find((d) => d.number === fromUrl) : undefined;
    if (fromUrl && !start) {
      // An old link (notification, email, bookmark) to a deliverable that's since been archived or deleted.
      const gone = card.deliverables.find((d) => d.number === fromUrl);
      toast(gone ? `D${gone.number} ${gone.name} is archived — showing the card instead.` : "That deliverable no longer exists — showing the card instead.");
      writeDeliverableParam(null);
    }
    if (!start && focusCommentId) {
      const all = card.comments.flatMap((c) => [c, ...c.replies]);
      const target = all.find((c) => c.id === focusCommentId);
      const root = target?.parentId ? all.find((c) => c.id === target.parentId) : target;
      if (root?.deliverableId) start = deliverables.find((d) => d.id === root.deliverableId);
    }
    if (!start && multi && (initialAction || queue)) start = deliverables.find((d) => d.state === "NEEDS_REVIEW");
    if (start && multi) setActiveId(start.id);
    else if (!multi) setActiveId(deliverables[0]!.id);
    // Open the linked revision of that deliverable (the selection is remembered per deliverable).
    const linkedVersion = readVersionParam();
    const target = start ?? (!multi ? deliverables[0] : undefined);
    if (linkedVersion && target) {
      const version = card.versions.find((x) => x.deliverableId === target.id && x.number === linkedVersion);
      if (version) versionByDeliverable.current.set(target.id, version.id);
    }
    // Files dropped on the board tile of a multi-deliverable card wait for a choice.
    const dropped = pendingCardDrops.get(card.id);
    if (dropped?.length) {
      pendingCardDrops.delete(card.id);
      if (multi) setPickerFiles(dropped);
      else void uploads.uploadVersion({ id: card.id, projectId: card.projectId, title: card.title }, dropped);
    }
  }, [card, deliverables, multi, focusCommentId, initialAction, queue, uploads]);

  // The selected revision is remembered per deliverable.
  useEffect(() => {
    if (!scope) return;
    const remembered = versionByDeliverable.current.get(scope.deliverable.id);
    const valid = remembered && scope.versions.some((v) => v.id === remembered);
    setVersionIdState(valid ? remembered! : (scope.currentVersionId ?? scope.versions.at(-1)?.id ?? null));
  }, [scope?.deliverable.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a new revision arrives (upload or realtime), follow it.
  const lastCurrent = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (!scope) return;
    const id = scope.deliverable.id;
    const previous = lastCurrent.current.get(id);
    if (previous !== undefined && scope.currentVersionId && scope.currentVersionId !== previous) {
      setVersionIdState(scope.currentVersionId);
      versionByDeliverable.current.set(id, scope.currentVersionId);
      setAttachmentId(null);
    }
    lastCurrent.current.set(id, scope.currentVersionId);
  }, [scope]);

  const setVersionId = useCallback(
    (id: string | null) => {
      setVersionIdState(id);
      if (active) versionByDeliverable.current.set(active.id, id);
      setAttachmentId(null);
      setPending(null);
    },
    [active],
  );

  const openDeliverable = useCallback(
    (id: string | null) => {
      if (scroller.current) scrollPositions.current.set(viewKey, scroller.current.scrollTop);
      timeline.current?.pause();
      setPending(null);
      setAttachmentId(null);
      setActiveCommentId(null);
      setActiveId(id);
      const d = id ? deliverables.find((x) => x.id === id) : null;
      writeDeliverableParam(multi && d ? d.number : null);
      // Opening a deliverable: its review state decides what's worth explaining.
      if (d) tutorial.trigger(["card.review-decision", "card.resolve-feedback"]);
    },
    [viewKey, deliverables, multi, tutorial],
  );

  // Restore where you were in each view (overview canvas/list, each deliverable).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = scrollPositions.current.get(viewKey) ?? 0;
  }, [viewKey]);

  const focusComment = useCallback(
    (comment: CommentDTO) => {
      if (multi && comment.deliverableId && comment.deliverableId !== active?.id) openDeliverable(comment.deliverableId);
      setActiveCommentId(comment.id);
      if (comment.versionId) {
        setVersionIdState(comment.versionId);
        if (comment.deliverableId) versionByDeliverable.current.set(comment.deliverableId, comment.versionId);
      }
      const anchor = comment.annotation;
      if (anchor) {
        setTimeout(() => setAttachmentId(anchor.attachmentId), 0);
        if (anchor.type === "TIMESTAMP" && anchor.timestampMs != null) {
          // Wait for the player to mount if we switched deliverable/revision/file.
          const seek = (tries = 0) => {
            if (timeline.current) {
              timeline.current.pause();
              timeline.current.seek(anchor.timestampMs!);
            } else if (tries < 40) setTimeout(() => seek(tries + 1), 50);
          };
          setTimeout(() => seek(), 60);
        }
        setTimeout(() => document.getElementById("media")?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
      }
      setTimeout(() => document.getElementById(`comment-${comment.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 160);
    },
    [multi, active, openDeliverable],
  );

  // Deep link to a specific comment (from notifications)
  const focused = useRef(false);
  useEffect(() => {
    if (!card || !focusCommentId || focused.current || !initialised.current) return;
    const all = card.comments.flatMap((c) => [c, ...c.replies]);
    const target = all.find((c) => c.id === focusCommentId);
    if (!target) return;
    focused.current = true;
    const root = target.parentId ? (all.find((c) => c.id === target.parentId) ?? target) : target;
    setTimeout(() => focusComment(root), 200);
  }, [card, focusCommentId, focusComment, activeId]);

  const cardMutationArgs = [card?.id ?? "", projectId] as const;
  const createComment = useCardMutation("comment.create", ...cardMutationArgs);
  const editComment = useCardMutation("comment.edit", ...cardMutationArgs);
  const deleteComment = useCardMutation("comment.delete", ...cardMutationArgs);
  const resolveComment = useCardMutation("comment.resolve", ...cardMutationArgs);
  const reactComment = useCardMutation("comment.react", ...cardMutationArgs, { silent: false });

  const comments = useMemo<CommentActions>(
    () => ({
      create: (input) =>
        createComment.mutateAsync({
          cardId: card!.id,
          body: input.body,
          kind: input.kind,
          parentId: input.parentId,
          deliverableId: input.deliverableId,
          versionId: input.versionId,
          attachmentId: input.attachmentId,
          annotation: input.annotation ?? null,
          attachmentIds: input.attachmentIds,
        }),
      edit: (commentId, body) => editComment.mutateAsync({ commentId, body }),
      remove: (commentId) => deleteComment.mutate({ commentId }),
      resolve: (commentId, resolved) => {
        // Optimistic toggle so the checklist feels instant.
        queryClient.setQueryData<CardDetailDTO>(qk.card(card!.id), (old) =>
          old
            ? {
                ...old,
                comments: old.comments.map((c) => (c.id === commentId ? { ...c, resolvedAt: resolved ? new Date().toISOString() : null, resolvedById: resolved ? board.board.viewer.userId : null } : c)),
              }
            : old,
        );
        resolveComment.mutate({ commentId, resolved });
      },
      react: (commentId, emoji) => reactComment.mutate({ commentId, emoji }),
    }),
    [card, createComment, editComment, deleteComment, resolveComment, reactComment, queryClient, board.board.viewer.userId],
  );

  const members = board.board.members;
  const workspace = useMemo<WorkspaceValue | null>(
    () =>
      card
        ? {
            card,
            deliverables,
            multi,
            scope,
            openDeliverable,
            members,
            membersById: board.membersById,
            mentionSet: new Set(members.map((m) => m.username)),
            viewerId: board.board.viewer.userId,
            uploadTarget: scope?.uploadTarget ?? { id: card.id, projectId, title: card.title },
            versionId,
            setVersionId,
            attachmentId,
            setAttachmentId,
            activeCommentId,
            setActiveCommentId,
            focusComment,
            pending,
            setPending,
            player,
            timeline,
            focusFeedbackComposer: () => focusComposer.current(),
            registerFeedbackComposer: (fn) => {
              focusComposer.current = fn;
            },
            comments,
            scrollTo: (section) => document.getElementById(section)?.scrollIntoView({ block: "start", behavior: "smooth" }),
          }
        : null,
    [card, deliverables, multi, scope, openDeliverable, members, board.membersById, board.board.viewer.userId, projectId, versionId, setVersionId, attachmentId, activeCommentId, focusComment, pending, comments],
  );

  // Review queue navigation
  const queueIndex = queue ? queue.findIndex((k) => k.toUpperCase() === cardKey.toUpperCase()) : -1;
  const queueList = queue && queueIndex === -1 ? [cardKey, ...queue] : queue;
  const position = queueList ? queueList.findIndex((k) => k.toUpperCase() === cardKey.toUpperCase()) : -1;
  const prevKey = queueList && position > 0 ? queueList[position - 1]! : null;
  const nextKey = queueList && position >= 0 && position < queueList.length - 1 ? queueList[position + 1]! : null;
  const remaining = queue ? queue.filter((k) => k.toUpperCase() !== cardKey.toUpperCase()).length : 0;

  useHotkeys(
    {
      arrowleft: () => prevKey && onNavigate(prevKey),
      arrowright: () => nextKey && onNavigate(nextKey),
    },
    { enabled: Boolean(queueList) },
  );

  const openUpload = (files?: File[]) => {
    setUploadFiles(files);
    setUploadOpen(true);
  };

  // Paste screenshots / image links anywhere in the card (outside text fields).
  const onPaste = (e: ClipboardEvent) => {
    if (!card || isTypingTarget(e.target)) return;
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/"));
    if (files.length) {
      e.preventDefault();
      if (!scope) {
        setPickerFiles(files);
        return;
      }
      if (!scope.permissions.canUpload) {
        toast.error("You don't have permission to upload here.");
        return;
      }
      void uploads.uploadVersion(scope.uploadTarget, files, { notes: "Pasted screenshot" });
      return;
    }
    const text = e.clipboardData.getData("text/plain").trim();
    if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i.test(text) && scope?.permissions.canUpload) {
      e.preventDefault();
      toast(`Import this image as a new revision${multi ? ` of ${scope.deliverable.name}` : ""}?`, {
        description: text,
        action: {
          label: "Import",
          onClick: async () => {
            try {
              const version = await rpc("version.create", { deliverableId: scope.deliverable.id });
              await rpc("upload.importUrl", { cardId: card.id, url: text, purpose: "version", versionId: version.id });
              void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
              void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
              toast.success(`Imported as V${version.number}.`);
            } catch (error) {
              toast.error(errorMessage(error));
            }
          },
        },
      });
    }
  };

  const column = card ? board.columnsById.get(card.columnId) : summary ? board.columnsById.get(summary.columnId) : undefined;
  const milestone = card?.milestoneId ? board.board.milestones.find((m) => m.id === card.milestoneId) : undefined;
  const notFound = (resolved.isError && !summary) || (detail.isError && detail.error instanceof RpcError && (detail.error.status === 404 || detail.error.status === 403));
  const hasFiles = Boolean(scope?.versions.length);

  const copyLink = () => {
    const params = new URLSearchParams({ card: card?.key ?? cardKey });
    if (multi && active) params.set("d", String(active.number));
    const url = `${window.location.origin}/${board.studioSlug}/${board.board.project.slug}?${params.toString()}`;
    void navigator.clipboard.writeText(url).then(() => toast.success(multi && active ? `Link to ${active.name} copied` : "Link copied"));
  };

  const mode: "simple" | "overview" | "deliverable" = !multi ? "simple" : scope ? "deliverable" : "overview";

  return (
    <D.Root open onOpenChange={(open) => !open && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content
          onPaste={onPaste}
          onDragOver={(e) => {
            if (card && e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            // Stages handle their own drops; anywhere else, files still land in the right place.
            if (!card || !e.dataTransfer.files.length || e.defaultPrevented) return;
            e.preventDefault();
            const files = [...e.dataTransfer.files];
            if (scope?.permissions.canUpload) openUpload(files);
            else if (!scope && multi) setPickerFiles(files);
            else toast.error("You don't have permission to upload here.");
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            // Esc steps back from a deliverable to the card overview before closing.
            if (mode === "deliverable" && !isTypingTarget(e.target)) {
              e.preventDefault();
              openDeliverable(null);
            }
          }}
          aria-describedby={undefined}
          className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg shadow-lg outline-none data-[state=open]:animate-pop-in md:inset-3 md:rounded-xl md:border md:border-border-strong lg:inset-x-[max(16px,calc((100vw-1760px)/2))] lg:inset-y-4"
        >
          <VisuallyHidden.Root>
            <D.Title>{card?.title ?? summary?.title ?? "Card"}</D.Title>
          </VisuallyHidden.Root>

          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2 md:px-5">
            <Tooltip content="Copy link to this card">
              <button type="button" onClick={copyLink} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 px-2 font-mono text-[11.5px] text-fg-muted hover:text-fg">
                {card?.key ?? cardKey}
                {multi && active ? `·D${active.number}` : ""} <Copy className="size-3" />
              </button>
            </Tooltip>
            {column ? (
              <span className="hidden items-center gap-1.5 text-[12.5px] text-fg-muted sm:inline-flex">
                <ColumnIcon name={column.icon} color={column.color} className="size-3.5" /> {column.name}
                {milestone ? <span className="text-fg-subtle">· {milestone.name}</span> : null}
              </span>
            ) : null}
            {card ? <ProductionPill status={card.productionStatus} pending={card.pendingChanges} className="hidden sm:inline-flex" /> : null}
            {card?.archivedAt ? <span className="rounded bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">Archived</span> : null}
            <span className="flex-1" />
            {queueList && position >= 0 ? (
              <div className="flex items-center gap-1 rounded-lg border border-state-review/40 bg-state-review/10 px-1 py-0.5 text-[12px]">
                <Eye className="ml-1 size-3.5 text-state-review" />
                <span className="px-1 font-medium">
                  Review queue {position + 1} / {queueList.length}
                </span>
                <Tooltip content="Previous" shortcut="←">
                  <Button size="icon-xs" variant="ghost" aria-label="Previous in queue" disabled={!prevKey} onClick={() => prevKey && onNavigate(prevKey)}>
                    <ArrowLeft />
                  </Button>
                </Tooltip>
                <Tooltip content="Next" shortcut="→">
                  <Button size="icon-xs" variant="ghost" aria-label="Next in queue" disabled={!nextKey} onClick={() => nextKey && onNavigate(nextKey)}>
                    <ArrowRight />
                  </Button>
                </Tooltip>
              </div>
            ) : null}
            {card ? <StatePill state={card.state} size="md" className="hidden md:inline-flex" /> : null}
            <Tooltip content="Copy link">
              <Button size="icon-sm" variant="ghost" aria-label="Copy link" onClick={copyLink} className="hidden sm:inline-flex">
                <Link2 />
              </Button>
            </Tooltip>
            <Tooltip content="Close" shortcut="Esc">
              <D.Close asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Close card">
                  <X />
                </Button>
              </D.Close>
            </Tooltip>
          </header>

          {notFound ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[15px] font-semibold">This card doesn&apos;t exist or you no longer have access to it.</p>
              <p className="text-[13px] text-fg-muted">It may have been deleted, or your permissions changed.</p>
              <Button variant="secondary" className="mt-3" onClick={onClose}>
                Back to the board
              </Button>
            </div>
          ) : !card || !workspace || (!multi && !scope) ? (
            <WorkspaceSkeleton />
          ) : (
            <WorkspaceContext.Provider value={workspace}>
              <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
                <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div key={viewKey} className="grid min-w-0 content-start gap-5 animate-fade-in">
                    {mode === "deliverable" ? (
                      <>
                        <DeliverableBreadcrumb />
                        <DeliverableHeader />
                        <FeedbackSummary />
                      </>
                    ) : (
                      <div>
                        <TipAnchor tip="card.workspace" facts={{}}>
                          <div>
                            <TitleEditor card={card} />
                          </div>
                        </TipAnchor>
                        <div className="mt-1.5">{mode === "overview" ? <DeliverableProgress progress={card.progress} detailed className="max-w-xl" /> : <FeedbackSummary />}</div>
                      </div>
                    )}
                    {mode === "simple" && card.permissions.canEdit ? (
                      <div className="-mt-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-subtle">
                        <Layers className="size-3.5" />
                        <span>One deliverable.</span>
                        <button type="button" onClick={() => setAddingDeliverable(true)} className="inline-flex min-h-6 items-center gap-1 font-medium text-accent hover:underline">
                          <Plus className="size-3" /> Add another deliverable
                        </button>
                        <span className="hidden md:inline">— split the work (e.g. model, animation, VFX, sound) with separate files and reviews.</span>
                      </div>
                    ) : null}
                    {mode === "overview" ? (
                      <DeliverablesPanel />
                    ) : (
                      <>
                        <ReviewBanner
                          onApprove={() => setDialog("approve")}
                          onRequestChanges={() => setDialog("changes")}
                          onUploadVersion={() => openUpload()}
                          nextInQueue={nextKey}
                          onNext={() => nextKey && onNavigate(nextKey)}
                          decidedInQueue={decided && Boolean(queueList)}
                        />
                        <MediaSection onUploadVersion={openUpload} />
                        {!hasFiles && scope && (scope.comments.some((c) => c.kind === "FEEDBACK") || scope.state === "NEEDS_REVIEW") ? <FeedbackPanel media={null} version={null} /> : null}
                      </>
                    )}
                    {mode !== "deliverable" ? (
                      <>
                        <Description />
                        <Checklists />
                        <ReferenceFiles />
                      </>
                    ) : null}
                    <CardTabs key={`${mode}-${scope?.deliverable.id ?? "card"}`} mode={mode} />
                  </div>
                  <CardSidebar
                    onApprove={() => setDialog("approve")}
                    onRequestChanges={() => setDialog("changes")}
                    onSubmit={() => setDialog("submit")}
                    onUploadVersion={() => (scope ? openUpload() : undefined)}
                    onClose={onClose}
                  />
                </div>
                {queueList ? (
                  <p className="pb-4 text-center text-[11px] text-fg-subtle">
                    <Kbd>←</Kbd> <Kbd>→</Kbd> move through the review queue · {remaining} other{remaining === 1 ? "" : "s"} waiting
                  </p>
                ) : null}
              </div>
              {scope ? (
                <>
                  <ApproveDialog open={dialog === "approve"} onOpenChange={(o) => setDialog(o ? "approve" : null)} onDone={() => setDecided(true)} />
                  <RequestChangesDialog open={dialog === "changes"} onOpenChange={(o) => setDialog(o ? "changes" : null)} onDone={() => setDecided(true)} />
                  <SubmitDialog open={dialog === "submit"} onOpenChange={(o) => setDialog(o ? "submit" : null)} />
                  <UploadVersionDialog key={`${scope.deliverable.id}-${uploadFiles?.length ?? 0}`} open={uploadOpen} onOpenChange={setUploadOpen} initialFiles={uploadFiles} />
                </>
              ) : null}
              <DeliverablePicker files={pickerFiles} onClose={() => setPickerFiles(null)} />
              <AddDeliverableDialog open={addingDeliverable} onOpenChange={setAddingDeliverable} />
            </WorkspaceContext.Provider>
          )}
          {card && !card.permissions.canComment && !card.permissions.canEdit ? (
            <div className={cn("shrink-0 border-t border-border bg-surface px-4 py-1.5 text-center text-[12px] text-fg-subtle")}>View only — you can see everything but can&apos;t make changes.</div>
          ) : null}
          {card && mode === "overview" && card.permissions.canUpload ? (
            <div className="pointer-events-none absolute bottom-3 right-4 hidden text-[11px] text-fg-subtle xl:block">
              <Upload className="mr-1 inline size-3" /> Drop or paste files anywhere — you&apos;ll choose the deliverable.
            </div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
