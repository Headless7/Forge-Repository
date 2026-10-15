"use client";

import { Check, Film, ImageOff, ImagePlus, Images, Loader2, RotateCcw, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useCardMutation } from "@/lib/queries";
import { descriptionImageIds } from "@/lib/description-images";
import type { AttachmentDTO, DeliverableDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/menu";
import { TipAnchor } from "../tutorial/tutorial";
import { useUploads } from "../upload/upload-manager";
import { useWorkspace } from "./workspace-context";

const COVER_FILE_TYPES = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime";

const coverable = (a: AttachmentDTO) => (a.kind === "IMAGE" || a.kind === "VIDEO") && (a.status === "READY" || a.status === "PROCESSING");

type ChoiceGroup = { label: string; items: AttachmentDTO[] };

/** Images shown in a description (its text decides: images taken out of it aren't offered). */
function descriptionChoices(attachments: AttachmentDTO[], text: string, deliverableId: string | null) {
  const shown = descriptionImageIds(text);
  return shown.map((id) => attachments.find((a) => a.id === id && a.purpose === "DESCRIPTION" && a.deliverableId === deliverableId && coverable(a))).filter((a): a is AttachmentDTO => Boolean(a));
}

/** Images and videos on this card that can be its cover (not ones uploaded as a deliverable's cover or in its description). */
function coverChoices(attachments: AttachmentDTO[], description: string): ChoiceGroup[] {
  return [
    { label: "Files", items: attachments.filter((a) => coverable(a) && ["CARD", "VERSION", "COVER"].includes(a.purpose) && !(a.purpose === "COVER" && a.deliverableId)) },
    { label: "From the description", items: descriptionChoices(attachments, description, null) },
  ].filter((g) => g.items.length);
}

/** A deliverable's own images and videos: from any of its revisions, its description, or uploaded as its cover. */
function deliverableCoverChoices(attachments: AttachmentDTO[], d: Pick<DeliverableDTO, "id" | "description">): ChoiceGroup[] {
  return [
    { label: "Its files", items: attachments.filter((a) => coverable(a) && a.deliverableId === d.id && ["VERSION", "COVER"].includes(a.purpose)) },
    { label: "From its description", items: descriptionChoices(attachments, d.description, d.id) },
  ].filter((g) => g.items.length);
}

/** A grid of images and videos to pick the cover from, grouped by where they come from. */
function CoverChooser({ label, groups, currentId, onPick, onDone }: { label: string; groups: ChoiceGroup[]; currentId: string | null; onPick: (attachmentId: string) => void; onDone: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-surface-3/50 p-2" role="group" aria-label="Choose a cover">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11.5px] font-medium text-fg-muted">{label}</span>
        <Button size="xs" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      <div className="grid max-h-64 gap-2 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            {groups.length > 1 ? <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle">{g.label}</p> : null}
            <ChoiceGrid choices={g.items} currentId={currentId} onPick={onPick} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ChoiceGrid({ choices, currentId, onPick }: { choices: AttachmentDTO[]; currentId: string | null; onPick: (attachmentId: string) => void }) {
  return (
    <ul className="grid grid-cols-3 gap-1.5">
      {choices.map((a) => {
        const current = currentId === a.id;
        return (
          <li key={a.id}>
            <button
              type="button"
              aria-label={`Use ${a.filename} as the cover`}
              aria-pressed={current}
              title={a.filename}
              onClick={() => onPick(a.id)}
              className={cn("relative block w-full overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:ring-ring", current ? "border-accent" : "border-border hover:border-border-strong")}
            >
              <Thumb file={a} className="aspect-video w-full rounded-none border-0" />
              {current ? (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-accent text-accent-fg">
                  <Check className="size-3" />
                </span>
              ) : null}
              <span className="block truncate px-1 py-0.5 text-left text-[10.5px] text-fg-muted">{a.filename}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Thumb({ file, className }: { file: { kind: string; thumbUrl: string | null; status: string } | null; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-4 text-fg-subtle", className)}>
      {file?.thumbUrl ? (
        <img src={file.thumbUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      ) : file?.status === "PROCESSING" || file?.status === "PENDING" ? (
        <Loader2 className="size-4 animate-spin" aria-label="Processing" />
      ) : file?.kind === "VIDEO" ? (
        <Film className="size-4" />
      ) : (
        <ImageOff className="size-4" />
      )}
    </span>
  );
}

/**
 * The card's board cover: automatic (its first deliverable's current file), a chosen image or
 * video (uploaded just for this, or already on the card), or none. Choosing or uploading a
 * cover never creates a revision or changes review status.
 */
export function CoverControl() {
  const { card, uploadTarget } = useWorkspace();
  const uploads = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const setCover = useCardMutation("attachment.setCover", card.id, card.projectId);
  const setMode = useCardMutation("card.setCoverMode", card.id, card.projectId);
  const canEdit = card.permissions.canEdit;
  const choices = coverChoices(card.attachments, card.description);
  const pinned = card.coverPinnedId ? card.attachments.find((a) => a.id === card.coverPinnedId) : undefined;
  const pinnedShown = card.coverMode === "MANUAL" && card.cover?.attachmentId === card.coverPinnedId;

  const status =
    card.coverMode === "NONE"
      ? "No cover"
      : card.coverMode === "AUTO"
        ? card.cover
          ? "Automatic — the first deliverable's cover"
          : "Automatic — appears with the first image or video"
        : pinnedShown
          ? card.cover?.status === "PROCESSING"
            ? `Chosen: ${pinned?.filename ?? "file"} (processing…)`
            : `Chosen: ${pinned?.filename ?? "file"}`
          : "Your chosen cover was removed or couldn't be processed — showing the automatic one";

  const uploadCover = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      await uploads.uploadFiles({ ...uploadTarget, deliverableId: null, label: "Cover" }, files.slice(0, 1), "cover");
    } finally {
      setUploading(false);
    }
  };

  return (
    <TipAnchor tip="card.attachments" place="cover" facts={{ place: "cover", canUpload: card.permissions.canUpload, canEdit }}>
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Thumb file={card.cover} className="h-12 w-[86px]" />
        <span className="flex-1" />
        {canEdit ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" aria-label="Change cover" disabled={uploading}>
                {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} Change
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => input.current?.click()}>
                <Upload /> Upload image or video…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!choices.length} onSelect={() => setChoosing(true)}>
                <Images /> Choose from this card…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={card.coverMode === "AUTO"} onSelect={() => setMode.mutate({ cardId: card.id, mode: "AUTO" })}>
                <RotateCcw /> Use automatic cover
              </DropdownMenuItem>
              <DropdownMenuItem disabled={card.coverMode === "NONE"} onSelect={() => setMode.mutate({ cardId: card.id, mode: "NONE" })}>
                <ImageOff /> Remove cover
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <input
          ref={input}
          type="file"
          hidden
          accept={COVER_FILE_TYPES}
          aria-label="Cover image or video"
          onChange={(e) => {
            void uploadCover([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      <p className={cn("text-[11.5px] leading-snug [overflow-wrap:anywhere]", card.coverMode === "MANUAL" && !pinnedShown ? "text-state-review" : "text-fg-muted")}>{status}</p>
      {choosing && canEdit ? (
        <CoverChooser
          label="Images and videos on this card"
          groups={choices}
          currentId={card.cover?.attachmentId ?? null}
          onPick={(attachmentId) => setCover.mutate({ cardId: card.id, attachmentId })}
          onDone={() => setChoosing(false)}
        />
      ) : null}
    </div>
    </TipAnchor>
  );
}

/**
 * A deliverable's cover, shown on its canvas box, in the list and in its header: automatic (its
 * current file), a chosen image or video (uploaded just for this, or one of its own files), or
 * none. Changing it never creates a revision or changes review status. `compact` fits the
 * canvas summary panel.
 */
export function DeliverableCoverControl({ deliverable: d, compact }: { deliverable: DeliverableDTO; compact?: boolean }) {
  const { card, uploadTarget } = useWorkspace();
  const uploads = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const setCover = useCardMutation("deliverable.setCover", card.id, card.projectId);
  const setMode = useCardMutation("deliverable.setCoverMode", card.id, card.projectId);
  const canEdit = card.permissions.canEdit && !d.archivedAt;
  const choices = deliverableCoverChoices(card.attachments, d);
  const pinned = d.coverPinnedId ? card.attachments.find((a) => a.id === d.coverPinnedId) : undefined;
  const pinnedShown = d.coverMode === "MANUAL" && d.cover?.attachmentId === d.coverPinnedId;

  const status =
    d.coverMode === "NONE"
      ? "No cover"
      : d.coverMode === "AUTO"
        ? d.cover
          ? "Automatic — its current file"
          : "Automatic — appears with its first image or video"
        : pinnedShown
          ? d.cover?.status === "PROCESSING"
            ? `Chosen: ${pinned?.filename ?? "file"} (processing…)`
            : `Chosen: ${pinned?.filename ?? "file"}`
          : "Your chosen cover was removed or couldn't be processed — showing the automatic one";

  const uploadCover = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      await uploads.uploadFiles({ ...uploadTarget, deliverableId: d.id, label: `${d.name} cover` }, files.slice(0, 1), "cover");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Thumb file={d.cover} className={compact ? "h-9 w-16" : "h-12 w-[86px]"} />
        {compact ? <p className="min-w-0 flex-1 text-[11px] leading-snug text-fg-muted [overflow-wrap:anywhere]">{status}</p> : <span className="flex-1" />}
        {canEdit ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" aria-label={`Change the cover of ${d.name}`} disabled={uploading}>
                {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} {compact ? "Cover" : "Change"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => input.current?.click()}>
                <Upload /> Upload image or video…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!choices.length} onSelect={() => setChoosing(true)}>
                <Images /> Choose from its files…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={d.coverMode === "AUTO"} onSelect={() => setMode.mutate({ deliverableId: d.id, mode: "AUTO" })}>
                <RotateCcw /> Use automatic cover
              </DropdownMenuItem>
              <DropdownMenuItem disabled={d.coverMode === "NONE"} onSelect={() => setMode.mutate({ deliverableId: d.id, mode: "NONE" })}>
                <ImageOff /> Remove cover
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <input
          ref={input}
          type="file"
          hidden
          accept={COVER_FILE_TYPES}
          aria-label={`Cover image or video for ${d.name}`}
          onChange={(e) => {
            void uploadCover([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {compact ? null : <p className={cn("text-[11.5px] leading-snug [overflow-wrap:anywhere]", d.coverMode === "MANUAL" && !pinnedShown ? "text-state-review" : "text-fg-muted")}>{status}</p>}
      {choosing && canEdit ? (
        <CoverChooser
          label={`Images and videos of ${d.name}`}
          groups={choices}
          currentId={d.cover?.attachmentId ?? null}
          onPick={(attachmentId) => setCover.mutate({ deliverableId: d.id, attachmentId })}
          onDone={() => setChoosing(false)}
        />
      ) : null}
    </div>
  );
}
