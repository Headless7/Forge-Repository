"use client";

import { Check, ImageOff, ImagePlus, Loader2, Maximize2 } from "lucide-react";
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { descriptionImageIds, imageToken, looksLikeImageUrl } from "@/lib/description-images";
import { useCardMutation } from "@/lib/queries";
import { errorMessage, rpc } from "@/lib/rpc-client";
import type { AttachmentDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { useUploads, type UploadTarget } from "../upload/upload-manager";

/**
 * Images in descriptions (see lib/description-images): pasted, dropped or picked images are stored
 * in Forge and the text gets a marker where each one goes. Pasted image links are copied in too
 * (Discord's expire). While an image uploads its marker says so, and saving waits for it.
 */

export interface ImageSource {
  /** Marks the image's place in the text until it's stored. */
  pendingId: string;
  name: string;
  file?: File;
  url?: string;
}

export const pendingToken = (s: Pick<ImageSource, "pendingId" | "name">) => `![${s.name.replace(/[[\]\n\r]/g, " ").trim() || "image"}](image:pending-${s.pendingId})`;

const newPendingId = () => Math.random().toString(36).slice(2, 10);

/** A name for a pasted link's image: the last part of its path. */
function nameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "image");
  } catch {
    return "image";
  }
}

/**
 * Stores images for one description as they're added, swapping each marker for the stored image's.
 * `uploaded`: images stored while editing (so a cancelled edit can let them go again).
 */
export function useDescriptionImageUploads(target: UploadTarget & { deliverableId: string | null }, setText: (update: (text: string) => string) => void) {
  const uploads = useUploads();
  const [busy, setBusy] = useState(0);
  const uploaded = useRef(new Set<string>());
  const start = useCallback(
    (sources: ImageSource[]) => {
      for (const s of sources) {
        setBusy((n) => n + 1);
        const stored = s.file
          ? uploads.uploadOne({ ...target, label: "Description" }, s.file, "description")
          : rpc("upload.importUrl", { cardId: target.id, url: s.url!, purpose: "description", deliverableId: target.deliverableId });
        stored
          .then((a) => {
            uploaded.current.add(a.id);
            setText((text) => text.replace(pendingToken(s), imageToken(a.filename || s.name, a.id)));
            if (s.url && /discord(app)?\.(com|net)/i.test(s.url)) toast.success("Copied the image into Forge.", { description: "Discord image links stop working after about a day; this copy doesn't." });
          })
          .catch((error) => {
            // A link that couldn't be copied stays as a link; a file that couldn't be stored goes.
            setText((text) => text.replace(pendingToken(s), s.url ?? ""));
            toast.error(`Couldn't add ${s.name}: ${errorMessage(error)}`);
          })
          .finally(() => setBusy((n) => n - 1));
      }
    },
    [target, uploads, setText],
  );
  return { start, busy, uploaded };
}

/** Takes images out of a paste or drop: picture files, or one pasted image link. Other files are refused with a reason. */
function imagesFrom(data: DataTransfer, allowLink: boolean): ImageSource[] | null {
  const files = [...data.files];
  if (files.length) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length < files.length) toast.error("Only images can go in a description. Attach other files to the card, or upload them as a revision.");
    return images.map((file) => ({ pendingId: newPendingId(), name: file.name || "pasted-image.png", file }));
  }
  const text = data.getData("text/plain").trim();
  if (allowLink && looksLikeImageUrl(text)) return [{ pendingId: newPendingId(), name: nameFromUrl(text), url: text }];
  return null;
}

/**
 * The description field: text, plus images pasted (screenshots or image links), dropped, or picked
 * with "Add image". Each image goes in where the cursor is.
 */
export function DescriptionTextarea({
  value,
  onChange,
  onImages,
  busy,
  className,
  footer,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
  onImages: (sources: ImageSource[]) => void;
  busy: number;
  className?: string;
  /** Shown beside "Add image" (e.g. the save buttons). */
  footer?: ReactNode;
} & Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange">) {
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const insert = (sources: ImageSource[]) => {
    if (!sources.length) return;
    const el = area.current;
    const at = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const before = value.slice(0, at);
    const after = value.slice(end);
    // Each image on a line of its own.
    const block = `${before && !before.endsWith("\n") ? "\n" : ""}${sources.map(pendingToken).join("\n")}${after && !after.startsWith("\n") ? "\n" : ""}`;
    onChange(`${before}${block}${after}`);
    onImages(sources);
    requestAnimationFrame(() => {
      if (!el) return;
      const caret = before.length + block.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Textarea
          ref={area}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
            const sources = imagesFrom(e.clipboardData, true);
            if (!sources) return;
            e.preventDefault();
            insert(sources);
          }}
          onDragOver={(e: DragEvent) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e: DragEvent<HTMLTextAreaElement>) => {
            setOver(false);
            const sources = e.dataTransfer.files.length ? imagesFrom(e.dataTransfer, false) : null;
            if (!sources) return;
            // Handled here: the card around it would otherwise treat the drop as an upload.
            e.preventDefault();
            insert(sources);
          }}
          className={cn(over && "border-accent bg-accent-soft/40", className)}
          {...props}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={() => picker.current?.click()}>
          <ImagePlus /> Add image
        </Button>
        {busy ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-fg-muted" role="status">
            <Loader2 className="size-3 animate-spin" /> Adding {busy} image{busy === 1 ? "" : "s"}…
          </span>
        ) : (
          <span className="hidden text-[11px] text-fg-subtle sm:inline">or paste a screenshot or image link</span>
        )}
        {footer}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          aria-label="Add images to the description"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            insert(files.map((file) => ({ pendingId: newPendingId(), name: file.name, file })));
          }}
        />
      </div>
    </div>
  );
}

/** Lets images stored during an edit go when it's cancelled (only ones the saved text doesn't show). */
export function releaseUnusedImages(uploaded: Set<string>, savedText: string) {
  const kept = new Set(descriptionImageIds(savedText));
  for (const id of uploaded) if (!kept.has(id)) void rpc("attachment.archive", { attachmentId: id }).catch(() => {});
  uploaded.clear();
}

/**
 * An image in a description, as read: the picture (tap for the full size), its name, and — for
 * people who can change the cover — "Use as cover", or a badge when it's the cover.
 */
export function DescriptionImage({ image, name, isCover, onUseAsCover, coverLabel = "Use as cover" }: { image: AttachmentDTO | undefined; name: string; isCover: boolean; onUseAsCover?: () => Promise<unknown>; coverLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!image) {
    return (
      <div className="flex max-w-full items-center gap-2 rounded-md border border-dashed border-border-strong px-2.5 py-2 text-[12px] text-fg-muted">
        <ImageOff className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{name || "Image"} isn&apos;t available any more.</span>
      </div>
    );
  }
  const src = image.url ?? image.thumbUrl;
  return (
    <figure className="w-fit max-w-full overflow-hidden rounded-lg border border-border bg-surface-2">
      <button type="button" onClick={() => setOpen(true)} className="group/img relative block max-w-full" aria-label={`View ${name || image.filename} full size`}>
        {src ? (
          <img src={src} alt={name || image.filename} loading="lazy" decoding="async" className="block max-h-[min(360px,60vh)] max-w-full object-contain" />
        ) : (
          <span className="flex h-24 w-40 items-center justify-center text-fg-subtle">
            <Loader2 className="size-4 animate-spin" aria-label="Processing" />
          </span>
        )}
        <span className="absolute right-1.5 top-1.5 hidden rounded bg-black/55 p-1 text-white group-hover/img:block group-focus-visible/img:block" aria-hidden>
          <Maximize2 className="size-3.5" />
        </span>
      </button>
      <figcaption className="flex min-h-8 flex-wrap items-center gap-1.5 border-t border-border px-2 py-1 text-[11.5px] text-fg-muted">
        <span className="min-w-0 flex-1 truncate" title={name || image.filename}>
          {name || image.filename}
        </span>
        {isCover ? (
          <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
            <Check className="size-3" /> Cover
          </span>
        ) : onUseAsCover ? (
          <Button
            size="xs"
            variant="ghost"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void onUseAsCover()
                .catch(() => {})
                .finally(() => setBusy(false));
            }}
          >
            {coverLabel}
          </Button>
        ) : null}
      </figcaption>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={name || image.filename} size="lg">
          {image.url ? <img src={image.url} alt={name || image.filename} className="mx-auto max-h-[70vh] max-w-full object-contain" /> : null}
          {image.downloadUrl ? (
            <a href={image.downloadUrl} className="mt-2 inline-flex min-h-6 items-center text-[12.5px] text-accent hover:underline">
              Download original
            </a>
          ) : null}
        </DialogContent>
      </Dialog>
    </figure>
  );
}

/** Image markers drawn with the description's own images (anything else isn't shown). */
export function useImageRenderer({ attachments, coverId, canEdit, onUseAsCover, coverLabel }: { attachments: AttachmentDTO[]; coverId: string | null; canEdit: boolean; onUseAsCover: (attachmentId: string) => Promise<unknown>; coverLabel?: string }) {
  return (id: string, name: string, key: string) => {
    const image = attachments.find((a) => a.id === id && a.purpose === "DESCRIPTION");
    return <DescriptionImage key={key} image={image} name={name} isCover={coverId === id} onUseAsCover={canEdit && image && image.status !== "FAILED" ? () => onUseAsCover(id) : undefined} coverLabel={coverLabel} />;
  };
}

/** Mutations for "Use as cover" on a deliverable's or the card's description images. */
export function useCoverFromDescription(cardId: string, projectId: string) {
  const deliverableCover = useCardMutation("deliverable.setCover", cardId, projectId);
  const cardCover = useCardMutation("attachment.setCover", cardId, projectId);
  return {
    forDeliverable: (deliverableId: string, attachmentId: string) => deliverableCover.mutateAsync({ deliverableId, attachmentId }).then(() => toast.success("Cover changed.")),
    forCard: (attachmentId: string) => cardCover.mutateAsync({ cardId, attachmentId }).then(() => toast.success("Card cover changed.")),
  };
}
