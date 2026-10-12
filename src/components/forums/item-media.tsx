"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Film, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { useItemMutation } from "@/lib/queries";
import type { AttachmentDTO, ForumItemDetailDTO } from "@/lib/types";
import { cn, formatBytes, formatDuration } from "@/lib/utils";
import { ImageViewer } from "../media/image-viewer";
import { VideoPlayer } from "../media/video-player";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Tooltip } from "../ui/menu";
import { useUploads, type UploadTarget } from "../upload/upload-manager";

export const ITEM_MEDIA_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,video/x-m4v";

/** The files an item takes out of a drop, paste or picker: pictures and clips only. */
export function itemMediaFiles(files: Iterable<File>): File[] {
  return [...files].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(f.name));
}

export function itemUploadTarget(item: Pick<ForumItemDetailDTO, "id" | "projectId" | "key" | "title">): UploadTarget {
  return { id: item.id, kind: "item", projectId: item.projectId, title: `${item.key} ${item.title}` };
}

/**
 * Pasted pictures or clips (a fresh screenshot) go to the item — and stop here, so a paste into a
 * comment box keeps working as text when the clipboard has no files.
 */
export function pastedItemMedia(onFiles: (files: File[]) => void) {
  return (e: ClipboardEvent<HTMLElement>) => {
    const files = itemMediaFiles(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    onFiles(files);
  };
}

/** An item's pictures and clips: a thumbnail grid, a lightbox, and (for editors) adding by picker, drop or paste. */
export function ItemMedia({ item, noun, canUpload }: { item: ForumItemDetailDTO; noun: string; canUpload: boolean }) {
  const uploads = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const files = item.attachments;

  const add = (list: File[]) => {
    const media = itemMediaFiles(list);
    if (!media.length) {
      toast.error("Pictures (PNG, JPEG, WebP, GIF) and clips (MP4, WebM, MOV) only.");
      return;
    }
    void uploads.uploadFiles(itemUploadTarget(item), media, "item");
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (!canUpload) return;
    e.preventDefault();
    setDragging(false);
    add([...e.dataTransfer.files]);
  };

  return (
    <section
      aria-label="Pictures and clips"
      onDragOver={(e) => {
        if (canUpload && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn("rounded-xl transition-colors", dragging && "bg-accent-soft/40 ring-2 ring-accent")}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">
          Pictures &amp; clips {files.length ? <span className="font-normal text-fg-subtle">· {files.length}</span> : null}
        </h3>
        {canUpload ? (
          <Button size="xs" variant="ghost" onClick={() => input.current?.click()}>
            <ImagePlus /> Add
          </Button>
        ) : null}
      </div>
      {files.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
          {files.map((file, i) => (
            <li key={file.id}>
              <MediaTile file={file} onOpen={() => setOpen(i)} />
            </li>
          ))}
          {canUpload ? (
            <li>
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong text-[11.5px] text-fg-subtle hover:border-fg-subtle hover:text-fg-muted"
              >
                <ImagePlus className="size-4" /> Add more
              </button>
            </li>
          ) : null}
        </ul>
      ) : canUpload ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong px-3 py-6 text-center text-[13px] text-fg-subtle hover:border-fg-subtle hover:text-fg-muted"
        >
          <ImagePlus className="size-5" />
          <span>Add screenshots or a clip of the {noun}</span>
          <span className="text-[11.5px] [@media(pointer:coarse)]:hidden">Drop files here, or paste a screenshot (Ctrl+V)</span>
        </button>
      ) : (
        <p className="text-[13px] text-fg-subtle">No pictures or clips.</p>
      )}
      {canUpload ? (
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept={ITEM_MEDIA_ACCEPT}
          aria-label="Add pictures or clips"
          onChange={(e) => {
            add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      ) : null}
      {open !== null && files[open] ? <Lightbox item={item} files={files} index={open} onIndex={setOpen} onClose={() => setOpen(null)} canRemove={canUpload} /> : null}
    </section>
  );
}

function MediaTile({ file, onOpen }: { file: AttachmentDTO; onOpen: () => void }) {
  const processing = file.status === "PROCESSING" && !file.thumbUrl;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${file.filename}`}
      className="group relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border border-border-strong bg-surface-4 text-fg-subtle hover:border-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      {file.thumbUrl ? <img src={file.thumbUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : processing ? <Loader2 className="size-4 animate-spin" aria-label="Processing" /> : <Film className="size-5" />}
      {file.kind === "VIDEO" ? (
        <span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/70 px-1 text-[10.5px] font-medium text-white">
          <Film className="size-3" /> {file.durationMs ? formatDuration(file.durationMs) : "Clip"}
        </span>
      ) : null}
    </button>
  );
}

function Lightbox({
  item,
  files,
  index,
  onIndex,
  onClose,
  canRemove,
}: {
  item: ForumItemDetailDTO;
  files: AttachmentDTO[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  canRemove: boolean;
}) {
  const file = files[index]!;
  const remove = useItemMutation("item.removeAttachment", item.id, item.projectId, { onSuccess: () => (files.length <= 1 ? onClose() : onIndex(Math.max(0, index - 1))) });
  const prev = index > 0 ? () => onIndex(index - 1) : null;
  const next = index < files.length - 1 ? () => onIndex(index + 1) : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && prev) prev();
      if (e.key === "ArrowRight" && next) next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" title={file.filename} hideTitle>
        <div className="mb-2 flex items-center gap-2 pr-8 text-[12.5px] text-fg-muted">
          <span className="truncate font-medium text-fg">{file.filename}</span>
          <span className="shrink-0">· {formatBytes(file.sizeBytes)}</span>
          {files.length > 1 ? <span className="ml-auto shrink-0">{index + 1} / {files.length}</span> : null}
        </div>
        <div className="relative h-[min(62dvh,620px)] overflow-hidden rounded-lg bg-surface-4">
          {file.kind === "VIDEO" && file.url ? (
            <VideoPlayer key={file.id} src={file.url} poster={file.thumbUrl} fps={file.fps} durationMs={file.durationMs} label={file.filename} className="h-full" />
          ) : file.url ? (
            <ImageViewer key={file.id} src={file.url} alt={file.filename} naturalWidth={file.width} naturalHeight={file.height} markers={[]} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-subtle">
              <Loader2 className="size-5 animate-spin" aria-label="Processing" />
              <span className="text-[12.5px]">Still processing — it will play shortly.</span>
            </div>
          )}
          {prev ? (
            <Button size="icon" variant="secondary" aria-label="Previous" onClick={prev} className="absolute left-2 top-1/2 -translate-y-1/2 opacity-80">
              <ChevronLeft />
            </Button>
          ) : null}
          {next ? (
            <Button size="icon" variant="secondary" aria-label="Next" onClick={next} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-80">
              <ChevronRight />
            </Button>
          ) : null}
        </div>
        <DialogFooter className="justify-between">
          {file.downloadUrl ? (
            <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-muted hover:bg-surface-4 hover:text-fg">
              <ExternalLink className="size-3.5" /> Open original
            </a>
          ) : (
            <span />
          )}
          {canRemove ? (
            <Tooltip content="Remove this file">
              <Button size="sm" variant="danger-ghost" loading={remove.isPending} onClick={() => remove.mutate({ attachmentId: file.id })}>
                <Trash2 /> Remove
              </Button>
            </Tooltip>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
