"use client";

import { Check, Film, ImageOff, ImagePlus, Images, Loader2, RotateCcw, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useCardMutation } from "@/lib/queries";
import type { AttachmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/menu";
import { TipAnchor } from "../tutorial/tutorial";
import { useUploads } from "../upload/upload-manager";
import { useWorkspace } from "./workspace-context";

const COVER_FILE_TYPES = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime";

/** Images and videos on this card that can be the cover. */
function coverChoices(attachments: AttachmentDTO[]) {
  return attachments.filter((a) => (a.kind === "IMAGE" || a.kind === "VIDEO") && ["CARD", "VERSION", "COVER"].includes(a.purpose) && (a.status === "READY" || a.status === "PROCESSING"));
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
  const choices = coverChoices(card.attachments);
  const pinned = card.coverPinnedId ? card.attachments.find((a) => a.id === card.coverPinnedId) : undefined;
  const pinnedShown = card.coverMode === "MANUAL" && card.cover?.attachmentId === card.coverPinnedId;

  const status =
    card.coverMode === "NONE"
      ? "No cover"
      : card.coverMode === "AUTO"
        ? card.cover
          ? "Automatic — the first deliverable's current file"
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
        <div className="rounded-lg border border-border bg-surface-3/50 p-2" role="group" aria-label="Choose a cover">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-fg-muted">Images and videos on this card</span>
            <Button size="xs" variant="ghost" onClick={() => setChoosing(false)}>
              Done
            </Button>
          </div>
          <ul className="grid max-h-56 grid-cols-3 gap-1.5 overflow-y-auto">
            {choices.map((a) => {
              const current = card.cover?.attachmentId === a.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    aria-label={`Use ${a.filename} as the cover`}
                    aria-pressed={current}
                    title={a.filename}
                    onClick={() => setCover.mutate({ cardId: card.id, attachmentId: a.id })}
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
        </div>
      ) : null}
    </div>
    </TipAnchor>
  );
}
