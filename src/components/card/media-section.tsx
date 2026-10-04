"use client";

import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  FileText,
  Film,
  ImagePlus,
  Link2,
  MapPin,
  Timer,
  Upload,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { VERSION_STATUS_META } from "@/lib/card-meta";
import type { RobloxFileMeta } from "@/lib/roblox/manifest";
import { useCardMutation } from "@/lib/queries";
import type { AttachmentDTO, CommentDTO, VersionDTO } from "@/lib/types";
import { cn, formatBytes, formatTimecode, timeAgo } from "@/lib/utils";
import { Composer } from "../comments/composer";
import { CommentThread, type CommentAnchorInfo } from "../comments/comment-thread";
import { KIND_ICONS } from "../domain/production";
import { StatePill } from "../domain/state";
import { AudioPlayer, type AudioMarker } from "../media/audio-player";
import { CompareView } from "../media/compare-view";
import { ImageViewer, type ImageMarker } from "../media/image-viewer";
import { VideoPlayer, type VideoMarker } from "../media/video-player";
import { Button } from "../ui/button";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Checkbox, EmptyState } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Tooltip } from "../ui/menu";
import { useUploads } from "../upload/upload-manager";
import { useScope, useWorkspace } from "./workspace-context";

// three.js and the Roblox viewer only load when a Roblox file is opened.
const RobloxPreview = dynamic(() => import("../roblox/roblox-preview").then((m) => m.RobloxPreview), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[13px] text-white/60">Loading the 3D viewer…</div>,
});

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
export const circled = (n: number) => CIRCLED[n - 1] ?? `#${n}`;

/** Numbers image pins per attachment in creation order (① ② ③ …). */
export function pinNumbers(comments: CommentDTO[]): Map<string, number> {
  const byAttachment = new Map<string, CommentDTO[]>();
  for (const c of comments) {
    if (c.deletedAt || c.parentId || !c.annotation || c.annotation.type === "TIMESTAMP") continue;
    const list = byAttachment.get(c.annotation.attachmentId) ?? [];
    list.push(c);
    byAttachment.set(c.annotation.attachmentId, list);
  }
  const numbers = new Map<string, number>();
  for (const list of byAttachment.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((c, i) => numbers.set(c.id, i + 1));
  }
  return numbers;
}

export function anchorFor(comment: CommentDTO, numbers: Map<string, number>): CommentAnchorInfo | null {
  const a = comment.annotation;
  if (!a) return null;
  if (a.type === "TIMESTAMP" && a.timestampMs != null) return { kind: "time", label: formatTimecode(a.timestampMs) };
  const n = numbers.get(comment.id);
  return n ? { kind: "pin", label: circled(n) } : null;
}

function mediaOf(version: VersionDTO | undefined, attachments: AttachmentDTO[]) {
  if (!version) return [];
  return attachments.filter((a) => version.attachmentIds.includes(a.id));
}

// ── Upload dialog ────────────────────────────────────────────────────────────

export function UploadVersionDialog({ open, onOpenChange, initialFiles }: { open: boolean; onOpenChange: (open: boolean) => void; initialFiles?: File[] }) {
  const { card, scope, multi } = useScope();
  const uploadTarget = scope.uploadTarget;
  const uploads = useUploads();
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [notes, setNotes] = useState("");
  const [submit, setSubmit] = useState(false);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const importUrl = useCardMutation("upload.importUrl", card.id, card.projectId);
  const createVersion = useCardMutation("version.create", card.id, card.projectId, { silent: true });
  const nextNumber = (scope.versions.at(-1)?.number ?? 0) + 1;

  const start = async () => {
    if (files.length) {
      onOpenChange(false);
      void uploads.uploadVersion(uploadTarget, files, { notes, submit });
    } else if (url.trim()) {
      try {
        const version = await createVersion.mutateAsync({ deliverableId: scope.deliverable.id, notes });
        await importUrl.mutateAsync({ cardId: card.id, url: url.trim(), purpose: "version", versionId: version.id });
        toast.success(`V${version.number} imported.`);
        onOpenChange(false);
      } catch {
        // toast already shown
      }
    }
    setFiles([]);
    setNotes("");
    setUrl("");
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    setFiles((list) => [...list, ...e.dataTransfer.files]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={multi ? `Upload ${scope.deliverable.name} V${nextNumber}` : `Upload V${nextNumber}`}
        description={multi ? "Only this deliverable gets a new revision. Its earlier revisions, and every other deliverable, stay exactly as they are." : "Previous versions and their feedback are kept exactly as they are."}
        size="lg"
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn("flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors", over ? "border-accent bg-accent-soft" : "border-border-strong")}
        >
          <Upload className="size-6 text-fg-subtle" />
          <p className="mt-2 text-[13px]">Drop renders, videos, audio (.mp3 / .ogg) or Roblox files (.rbxm / .rbxmx) here</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={() => input.current?.click()}>
            Browse files
          </Button>
          <input ref={input} type="file" multiple hidden onChange={(e) => { setFiles((list) => [...list, ...(e.target.files ?? [])]); e.target.value = ""; }} />
        </div>
        {files.length ? (
          <ul className="mt-3 grid gap-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border border-border bg-surface-3/40 px-2.5 py-1.5 text-[12.5px]">
                {(() => {
                  const Icon = f.type.startsWith("video/") ? Film : f.type.startsWith("image/") ? ImagePlus : f.type.startsWith("audio/") || /\.(mp3|ogg|oga)$/i.test(f.name) ? KIND_ICONS.AUDIO : /\.rbx[ml]x?$/i.test(f.name) ? KIND_ICONS.ROBLOX : FileText;
                  return <Icon className="size-4 text-fg-subtle" />;
                })()}
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-fg-subtle">{formatBytes(f.size)}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((list) => list.filter((_, j) => j !== i))} className="text-fg-subtle hover:text-fg">
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <Link2 className="size-4 text-fg-subtle" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="…or paste an image URL"
              aria-label="Image URL"
              className="h-8 flex-1 rounded-md border border-border-strong bg-surface-3 px-2.5 text-[13px] outline-none focus:border-accent"
            />
          </div>
        )}
        <Textarea className="mt-3" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Version notes — what changed?" />
        {scope.permissions.canSubmit ? (
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <Checkbox checked={submit} onCheckedChange={(v) => setSubmit(v === true)} />
            Submit V{nextNumber} for review when the upload finishes
          </label>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!files.length && !url.trim()} loading={importUrl.isPending || createVersion.isPending} onClick={() => void start()}>
            <Upload /> Upload as V{nextNumber}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Feedback panel ───────────────────────────────────────────────────────────

export function FeedbackPanel({
  media,
  version,
  className,
  pausedAt = null,
  timedRoblox = false,
}: {
  media: AttachmentDTO | null;
  version: VersionDTO | null;
  className?: string;
  /** Playhead while paused — new feedback is stamped here. */
  pausedAt?: number | null;
  /** A Roblox file whose animation timeline is active. */
  timedRoblox?: boolean;
}) {
  const ws = useScope();
  const { card, scope, pending, setPending, timeline, comments } = ws;
  const tutorial = useTutorial();
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("all");
  const [kind, setKind] = useState<"FEEDBACK" | "DISCUSSION">("FEEDBACK");
  const [stamp, setStamp] = useState(true);
  const numbers = useMemo(() => pinNumbers(scope.comments), [scope.comments]);

  const roots = scope.comments.filter((c) => !c.parentId && !c.deletedAt);
  const inScope = (c: CommentDTO) => {
    if (!version) return c.kind === "FEEDBACK" || Boolean(c.annotation);
    if (c.annotation) return media ? c.annotation.attachmentId === media.id : c.versionId === version.id;
    return c.kind === "FEEDBACK" && c.versionId === version.id;
  };
  const scoped = roots.filter(inScope);
  const sorted = [...scoped].sort((a, b) => {
    const ta = a.annotation?.timestampMs ?? Number.MAX_SAFE_INTEGER;
    const tb = b.annotation?.timestampMs ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return (numbers.get(a.id) ?? 999) - (numbers.get(b.id) ?? 999) || a.createdAt.localeCompare(b.createdAt);
  });
  const shown = sorted.filter((c) => (filter === "all" ? true : filter === "open" ? !c.resolvedAt : Boolean(c.resolvedAt)));
  const olderOpen = version
    ? roots.filter((c) => c.kind === "FEEDBACK" && !c.resolvedAt && c.versionId && c.versionId !== version.id)
    : [];
  const openCount = scoped.filter((c) => c.kind === "FEEDBACK" && !c.resolvedAt).length;

  const isVideo = media?.kind === "VIDEO";
  // Audio and Roblox animations have a timeline too: feedback is stamped at the playhead.
  const timed = isVideo || media?.kind === "AUDIO" || (media?.kind === "ROBLOX" && timedRoblox);
  // Starting to write pauses playback so the note lands on the moment being looked at.
  const onComposerFocus = () => {
    if (timed) timeline.current?.pause();
  };
  const pendingForMedia = pending && media && pending.attachmentId === media.id ? pending : null;
  const stampTime = pendingForMedia?.timestampMs ?? pausedAt ?? timeline.current?.currentTimeMs() ?? 0;
  const nextPin = media ? [...numbers.entries()].filter(([id]) => scope.comments.some((c) => c.id === id && c.annotation?.attachmentId === media.id)).length + 1 : 1;

  const composerWrap = useRef<HTMLDivElement>(null);
  const { registerFeedbackComposer } = ws;
  useEffect(() => {
    registerFeedbackComposer(() => {
      composerWrap.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      composerWrap.current?.querySelector("textarea")?.focus();
    });
  }, [registerFeedbackComposer]);

  const submit = async ({ body, attachmentIds }: { body: string; attachmentIds: string[] }) => {
    let annotation = null;
    if (media && pendingForMedia?.type === "POINT") {
      annotation = { type: "POINT" as const, x: pendingForMedia.x ?? null, y: pendingForMedia.y ?? null, width: null, height: null, timestampMs: null };
    } else if (timed && stamp) {
      const t = Math.round(pendingForMedia?.timestampMs ?? pausedAt ?? timeline.current?.currentTimeMs() ?? 0);
      annotation = { type: "TIMESTAMP" as const, timestampMs: t, x: isVideo ? (pendingForMedia?.x ?? null) : null, y: isVideo ? (pendingForMedia?.y ?? null) : null, width: null, height: null };
    }
    await comments.create({
      body,
      kind,
      deliverableId: scope.deliverable.id,
      versionId: version?.id ?? null,
      attachmentId: annotation ? (media?.id ?? null) : null,
      annotation,
      attachmentIds,
    });
    setPending(null);
    // Having just written one, it's the moment to explain feedback versus comments.
    tutorial.trigger("card.feedback");
  };

  const header = timed ? (
    <>
      <button
        type="button"
        onClick={() => setStamp((s) => !s)}
        className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] font-semibold", stamp ? "bg-state-changes/15 text-state-changes" : "bg-surface-4 text-fg-subtle line-through")}
        title={stamp ? "Attached to this moment — click to leave general feedback" : "Attach to the current moment"}
        aria-pressed={stamp}
      >
        <Timer className="size-3" /> {formatTimecode(stampTime)}
      </button>
      {isVideo && pendingForMedia?.x != null ? (
        <span className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-soft px-1.5 text-[11px] font-semibold text-accent">
          <MapPin className="size-3" /> Pinned on frame
          <button type="button" aria-label="Remove pin" onClick={() => setPending(null)}>
            <X className="size-3" />
          </button>
        </span>
      ) : null}
    </>
  ) : media?.kind === "IMAGE" ? (
    pendingForMedia ? (
      <span className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-soft px-1.5 text-[11px] font-semibold text-accent">
        <MapPin className="size-3" /> Pin {circled(nextPin)}
        <button type="button" aria-label="Remove pin" onClick={() => setPending(null)}>
          <X className="size-3" />
        </button>
      </span>
    ) : (
      <span className="text-[11.5px] text-fg-subtle">Click the image to pin this feedback to a spot.</span>
    )
  ) : null;

  return (
    <section id="feedback" aria-label="Feedback" className={cn("flex min-h-0 flex-col rounded-xl border border-border bg-surface-2", className)}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-[13px] font-semibold">
          Feedback{version ? <span className="font-normal text-fg-muted"> on V{version.number}</span> : null}
        </h3>
        {openCount ? <span className="rounded bg-state-changes/15 px-1.5 text-[11px] font-semibold text-state-changes">{openCount} open</span> : null}
        <span className="flex-1" />
        <div className="flex rounded-md bg-surface-3 p-0.5 text-[11.5px]">
          {(["all", "open", "resolved"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={cn("h-6 rounded px-2 font-medium capitalize", filter === f ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")}>
              {f}
            </button>
          ))}
        </div>
      </header>
      <div className="scrollbar-thin min-h-24 flex-1 overflow-y-auto px-1.5 py-1.5">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-fg-muted">
            {scoped.length === 0 ? (timed ? "Pause on a moment and leave the first note." : media?.kind === "IMAGE" ? "Click on the image to leave the first note." : "No feedback yet.") : "Nothing matches this filter."}
          </p>
        ) : (
          shown.map((c) => <CommentThread key={c.id} comment={c} anchor={anchorFor(c, numbers)} />)
        )}
        {olderOpen.length ? (
          <div className="mt-2 rounded-lg border border-state-changes/30 bg-state-changes/[0.05] p-1.5">
            <p className="px-2 py-1 text-[11.5px] font-semibold text-state-changes">Still open from earlier versions ({olderOpen.length})</p>
            {olderOpen.map((c) => (
              <CommentThread key={c.id} comment={c} anchor={anchorFor(c, numbers)} versionLabel={`V${scope.versions.find((v) => v.id === c.versionId)?.number ?? "?"}`} />
            ))}
          </div>
        ) : null}
      </div>
      {card.permissions.canComment ? (
        <div ref={composerWrap} className="border-t border-border p-2">
          <TipAnchor tip="card.feedback" facts={{ canComment: card.permissions.canComment, media: media?.kind === "IMAGE" ? "image" : timed ? "timed" : "other" }}>
            <div className="mb-1.5 flex items-center gap-1 text-[11.5px]">
              {(["FEEDBACK", "DISCUSSION"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                    tutorial.trigger("card.feedback");
                  }}
                  aria-pressed={kind === k}
                  className={cn("h-6 rounded-md px-2 font-medium", kind === k ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")}
                >
                  {k === "FEEDBACK" ? "Feedback (actionable)" : "Comment"}
                </button>
              ))}
            </div>
          </TipAnchor>
          <Composer
            members={ws.members}
            card={scope.uploadTarget}
            compact
            header={header}
            onFocus={onComposerFocus}
            placeholder={timed ? "Feedback at this moment…" : media?.kind === "IMAGE" ? "Feedback on this image…" : media ? `Feedback on ${media.filename}…` : "Leave feedback…"}
            submitLabel={kind === "FEEDBACK" ? "Add feedback" : "Comment"}
            onSubmit={submit}
          />
        </div>
      ) : null}
    </section>
  );
}

// ── Media section ────────────────────────────────────────────────────────────

function stageLabel(kind: AttachmentDTO["kind"]) {
  return kind === "ROBLOX" ? "Roblox preview" : kind === "AUDIO" ? "Audio review" : "Media review";
}

export function MediaSection({ onUploadVersion }: { onUploadVersion: (files?: File[]) => void }) {
  const ws = useScope();
  const { card, scope, multi, versionId, setVersionId: selectVersion, attachmentId, setAttachmentId, activeCommentId, setActiveCommentId, pending, setPending, player, timeline, focusFeedbackComposer } = ws;
  const tutorial = useTutorial();
  // Moving between revisions is when "earlier revisions keep their feedback" matters.
  const setVersionId = (id: string | null) => {
    selectVersion(id);
    tutorial.trigger("card.revisions");
  };
  const [compare, setCompare] = useState(false);
  const [over, setOver] = useState(false);
  // Tracked only while paused (seeks/steps), so playback doesn't re-render the panel every frame.
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [robloxTimed, setRobloxTimed] = useState(false);
  const playing = useRef(false);
  const versions = scope.versions;
  const perms = scope.permissions;
  const version = versions.find((v) => v.id === versionId) ?? versions.find((v) => v.id === scope.currentVersionId) ?? versions.at(-1);
  const media = mediaOf(version, card.attachments);
  const visualMedia = media.filter((a) => a.kind !== "FILE");
  const current = media.find((a) => a.id === attachmentId) ?? visualMedia[0] ?? media[0] ?? null;
  const numbers = useMemo(() => pinNumbers(scope.comments), [scope.comments]);
  const versionsWithMedia = versions.filter((v) => mediaOf(v, card.attachments).some((a) => a.kind === "IMAGE" || a.kind === "VIDEO"));
  const idx = version ? versions.findIndex((v) => v.id === version.id) : -1;

  // Switching files or revisions resets the playhead used for stamping.
  useEffect(() => {
    setPausedAt(null);
    playing.current = false;
  }, [current?.id]);

  const commentsOnMedia = useMemo(
    () => (current ? scope.comments.filter((c) => !c.parentId && !c.deletedAt && c.annotation?.attachmentId === current.id) : []),
    [scope.comments, current],
  );
  const imageMarkers: ImageMarker[] = commentsOnMedia
    .filter((c) => c.annotation && c.annotation.type !== "TIMESTAMP" && c.annotation.x != null && c.annotation.y != null)
    .map((c) => ({ id: c.id, number: numbers.get(c.id) ?? 0, x: c.annotation!.x!, y: c.annotation!.y!, resolved: Boolean(c.resolvedAt), label: c.body }));
  const timeMarkers = commentsOnMedia
    .filter((c) => c.annotation?.type === "TIMESTAMP" && c.annotation.timestampMs != null)
    .map((c) => ({
      id: c.id,
      timestampMs: c.annotation!.timestampMs!,
      author: ws.membersById.get(c.authorId ?? "")?.displayName.split(" ")[0] ?? "Someone",
      text: c.body,
      resolved: Boolean(c.resolvedAt),
      x: c.annotation!.x,
      y: c.annotation!.y,
    }));
  const videoMarkers: VideoMarker[] = timeMarkers;
  const audioMarkers: AudioMarker[] = timeMarkers;

  const onPlacePin = useCallback(
    (x: number, y: number) => {
      if (!current) return;
      setPending({ attachmentId: current.id, type: "POINT", x, y });
      focusFeedbackComposer();
    },
    [current, setPending, focusFeedbackComposer],
  );

  const trackPlayhead = {
    onPlayingChange: (p: boolean) => {
      playing.current = p;
      if (!p) setPausedAt(timeline.current?.currentTimeMs() ?? null);
    },
    onTimeChange: (ms: number) => {
      if (!playing.current) setPausedAt(ms);
    },
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (perms.canUpload && e.dataTransfer.files.length) onUploadVersion([...e.dataTransfer.files]);
  };

  if (!versions.length || !version) {
    return (
      <section
        id="media"
        onDragOver={(e) => {
          if (!perms.canUpload) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn("rounded-xl border-2 border-dashed transition-colors", over ? "border-accent bg-accent-soft" : "border-border-strong")}
      >
        <EmptyState
          className="border-0"
          icon={<ImagePlus />}
          title={perms.canUpload ? (multi ? `Add the first revision of ${scope.deliverable.name}` : "Add the first version") : "No files yet"}
          description={
            perms.canUpload
              ? "Drop a render, video, audio file (.mp3/.ogg) or Roblox file (.rbxm/.rbxmx) here — or paste a screenshot anywhere in this card."
              : "Nothing has been uploaded for this yet."
          }
          action={
            perms.canUpload ? (
              <Button variant="primary" size="sm" onClick={() => onUploadVersion()}>
                <Upload /> Upload V1
              </Button>
            ) : undefined
          }
        />
      </section>
    );
  }

  const uploader = version.createdById ? ws.membersById.get(version.createdById) : undefined;
  const isCurrent = version.id === scope.currentVersionId;
  const isApprovedRecord = version.id === scope.deliverable.approvedVersionId;
  const robloxMeta = current?.kind === "ROBLOX" ? (current.meta as Partial<RobloxFileMeta> | null) : null;

  return (
    <section id="media" aria-label={current ? stageLabel(current.kind) : "Files"} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <TipAnchor tip="card.revisions" facts={{ revisionCount: versions.length }}>
        <div className="flex items-center rounded-lg border border-border-strong bg-surface-2">
          <Tooltip content="Previous revision">
            <button type="button" aria-label="Previous revision" disabled={idx <= 0} onClick={() => setVersionId(versions[idx - 1]!.id)} className="flex size-8 items-center justify-center text-fg-muted hover:text-fg disabled:opacity-30">
              <ChevronLeft className="size-4" />
            </button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex h-8 items-center gap-2 border-x border-border-strong px-2.5 text-[13px] font-semibold">
                V{version.number}
                {isCurrent ? <span className="rounded bg-accent-soft px-1.5 text-[10.5px] font-semibold text-accent">Current</span> : null}
                <StatePill state={VERSION_STATUS_META[version.status].state} size="sm" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              {[...versions].reverse().map((v) => (
                <DropdownMenuItem key={v.id} onSelect={() => { setVersionId(v.id); setAttachmentId(null); }} className="h-auto py-1.5">
                  <span className="w-7 font-mono font-semibold">V{v.number}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5">
                      <StatePill state={VERSION_STATUS_META[v.status].state} size="sm" />
                      {v.id === scope.currentVersionId ? <span className="text-[10.5px] font-semibold text-accent">Current</span> : null}
                    </span>
                    <span className="mt-0.5 truncate text-[11px] text-fg-subtle">
                      {timeAgo(v.createdAt)}
                      {v.feedbackCount ? ` · ${v.feedbackCount} feedback` : ""}
                      {v.unresolvedCount ? ` (${v.unresolvedCount} open)` : ""}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Next revision">
            <button type="button" aria-label="Next revision" disabled={idx >= versions.length - 1} onClick={() => setVersionId(versions[idx + 1]!.id)} className="flex size-8 items-center justify-center text-fg-muted hover:text-fg disabled:opacity-30">
              <ChevronRight className="size-4" />
            </button>
          </Tooltip>
        </div>
        </TipAnchor>
        {media.length > 1 ? (
          <div className="scrollbar-none flex max-w-full items-center gap-1 overflow-x-auto" role="tablist" aria-label="Files in this revision">
            {media.map((a) => {
              const Icon = KIND_ICONS[a.kind];
              return (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={current?.id === a.id}
                  onClick={() => setAttachmentId(a.id)}
                  title={a.filename}
                  className={cn("flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border", current?.id === a.id ? "border-accent ring-1 ring-accent" : "border-border-strong opacity-70 hover:opacity-100")}
                >
                  {a.thumbUrl ? <img src={a.thumbUrl} alt="" className="h-full w-full object-cover" /> : <Icon className="size-4 text-fg-subtle" />}
                </button>
              );
            })}
          </div>
        ) : null}
        <span className="flex-1" />
        {versionsWithMedia.length >= 2 && (current?.kind === "IMAGE" || current?.kind === "VIDEO") ? (
          <Button size="sm" variant={compare ? "primary" : "ghost"} onClick={() => setCompare((c) => !c)} aria-pressed={compare}>
            <Columns2 /> Compare
          </Button>
        ) : null}
        {current?.downloadUrl ? (
          <Tooltip content={`Download original: ${current.filename}`}>
            <Button size="icon-sm" variant="ghost" asChild aria-label="Download original">
              <a href={current.downloadUrl}>
                <Download />
              </a>
            </Button>
          </Tooltip>
        ) : null}
        {perms.canUpload ? (
          <Button size="sm" variant="secondary" onClick={() => onUploadVersion()}>
            <Upload /> New revision
          </Button>
        ) : null}
      </div>

      {!isCurrent || (isApprovedRecord && scope.state !== "APPROVED") ? (
        <p className="rounded-md border border-border-strong bg-surface-2 px-3 py-1.5 text-[12px] text-fg-muted">
          {!isCurrent ? (
            <>
              You&apos;re looking at <strong className="text-fg">V{version.number}</strong>, an earlier revision. The current one is{" "}
              <button type="button" className="font-semibold text-accent hover:underline" onClick={() => setVersionId(scope.currentVersionId)}>
                V{versions.find((v) => v.id === scope.currentVersionId)?.number ?? "?"}
              </button>
              .
            </>
          ) : null}
          {isApprovedRecord && scope.state !== "APPROVED" ? <> V{version.number} is the last approved revision; newer work is not approved yet.</> : null}
        </p>
      ) : null}

      <div className={cn("grid gap-3", current?.kind === "ROBLOX" ? "2xl:grid-cols-[minmax(0,1fr)_360px]" : "2xl:grid-cols-[minmax(0,1fr)_380px]")}>
        <div
          onDragOver={(e) => {
            if (perms.canUpload && e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setOver(true);
            }
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn(
            "relative w-full overflow-hidden rounded-xl border border-border bg-black",
            current?.kind === "ROBLOX" ? "h-[min(72vh,760px)] min-h-[420px]" : current?.kind === "AUDIO" ? "min-h-[260px]" : "aspect-video max-h-[64vh]",
          )}
        >
          {compare && versionsWithMedia.length >= 2 ? (
            <CompareView
              versions={versionsWithMedia}
              attachments={card.attachments}
              initialLeftId={versionsWithMedia[Math.max(0, versionsWithMedia.findIndex((v) => v.id === version.id) - 1)]!.id}
              initialRightId={version.id}
            />
          ) : !current ? (
            <div className="flex h-full min-h-[200px] items-center justify-center text-[13px] text-white/60">This revision has no files yet.</div>
          ) : current.status === "PENDING" ? (
            <div className="flex h-full min-h-[200px] items-center justify-center text-[13px] text-white/60">Uploading…</div>
          ) : current.status === "FAILED" ? (
            <div className="flex h-full min-h-[200px] items-center justify-center p-6 text-center text-[13px] text-danger">{current.error ?? "This upload failed."}</div>
          ) : current.kind === "VIDEO" && current.url ? (
            <VideoPlayer
              ref={(h) => {
                player.current = h;
                timeline.current = h;
              }}
              key={current.id}
              src={current.url}
              poster={current.thumbUrl}
              fps={current.fps}
              durationMs={current.durationMs}
              markers={videoMarkers}
              activeMarkerId={activeCommentId}
              onMarkerClick={(id) => setActiveCommentId(id)}
              {...trackPlayhead}
              pendingPoint={pending && pending.attachmentId === current.id && pending.x != null ? { x: pending.x, y: pending.y! } : null}
              onPlacePoint={
                card.permissions.canComment
                  ? (x, y, t) => {
                      setPending({ attachmentId: current.id, type: "TIMESTAMP", x, y, timestampMs: t });
                      focusFeedbackComposer();
                    }
                  : undefined
              }
              label={current.filename}
            />
          ) : current.kind === "AUDIO" && current.url ? (
            <AudioPlayer
              ref={(h) => {
                timeline.current = h;
              }}
              key={current.id}
              src={current.url}
              mimeType={current.mimeType}
              fallbackSrc={current.previewUrl}
              peaksUrl={current.derivedUrl}
              waveformState={current.status === "PROCESSING" ? "processing" : current.meta?.waveformError ? "failed" : "ready"}
              durationMs={current.durationMs}
              markers={audioMarkers}
              activeMarkerId={activeCommentId}
              onMarkerClick={(id) => setActiveCommentId(id)}
              {...trackPlayhead}
              downloadUrl={current.downloadUrl}
              label={current.filename}
              meta={current.meta}
            />
          ) : current.kind === "ROBLOX" ? (
            <RobloxPreview
              key={current.id}
              attachment={current}
              timelineRef={timeline}
              markers={timeMarkers}
              activeMarkerId={activeCommentId}
              onMarkerClick={(id) => setActiveCommentId(id)}
              onTimelineActive={setRobloxTimed}
              {...trackPlayhead}
            />
          ) : current.kind === "IMAGE" && current.url ? (
            <ImageViewer
              key={current.id}
              src={current.url}
              alt={current.filename}
              naturalWidth={current.width}
              naturalHeight={current.height}
              markers={imageMarkers}
              activeMarkerId={activeCommentId}
              pending={pending && pending.attachmentId === current.id && pending.type === "POINT" ? { x: pending.x!, y: pending.y! } : null}
              onPlace={card.permissions.canComment ? onPlacePin : undefined}
              onMarkerClick={(id) => {
                setActiveCommentId(id);
                document.getElementById(`comment-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
              }}
            />
          ) : (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 p-6 text-center text-white/70">
              <FileText className="size-8" />
              <p className="text-[13px]">{current.filename}</p>
              <p className="max-w-sm text-[12px] text-white/50">This file type can&apos;t be previewed in the app. Download it to open it locally.</p>
              {current.downloadUrl ? (
                <Button size="sm" variant="secondary" asChild>
                  <a href={current.downloadUrl}>
                    <Download /> Download
                  </a>
                </Button>
              ) : null}
            </div>
          )}
          {over ? (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-accent bg-accent-soft/80 text-[13px] font-semibold backdrop-blur-sm">
              Drop to upload {multi ? `${scope.deliverable.name} ` : ""}V{(versions.at(-1)?.number ?? 0) + 1}
            </div>
          ) : null}
        </div>
        <FeedbackPanel
          media={compare ? null : current}
          version={version}
          pausedAt={current?.kind === "VIDEO" || current?.kind === "AUDIO" || (current?.kind === "ROBLOX" && robloxTimed) ? pausedAt : null}
          timedRoblox={robloxTimed}
          className={cn(current?.kind === "ROBLOX" ? "max-h-[min(72vh,760px)]" : "max-h-[64vh]", "2xl:h-auto")}
        />
      </div>

      <p className="text-[12px] text-fg-muted">
        <span className="font-mono font-semibold text-fg">V{version.number}</span> uploaded by {uploader?.displayName ?? "someone"} {timeAgo(version.createdAt)}
        {current ? (
          <>
            {" · "}
            {current.filename} · {formatBytes(current.sizeBytes)}
            {current.width ? ` · ${current.width}×${current.height}` : ""}
            {current.durationMs ? ` · ${formatTimecode(current.durationMs)}` : ""}
            {robloxMeta?.instanceCount ? ` · ${robloxMeta.instanceCount} instances (${robloxMeta.format})` : ""}
          </>
        ) : null}
        {version.notes ? <span className="text-fg"> — “{version.notes}”</span> : null}
      </p>
    </section>
  );
}
