"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { isBackgroundId, PROJECT_BACKGROUNDS } from "@/lib/column-icons";
import { qk, useRpcMutation } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc-client";
import type { BoardDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

function Tile({ label, selected, className, style, onClick, disabled }: { label: string; selected: boolean; className?: string; style?: React.CSSProperties; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "relative h-16 overflow-hidden rounded-lg border text-left focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        selected ? "border-accent ring-1 ring-accent" : "border-border-strong hover:border-fg-subtle",
        className,
      )}
      style={style}
    >
      <span className="absolute inset-x-0 bottom-0 truncate bg-black/35 px-2 py-0.5 text-[11px] font-medium text-white">{label}</span>
      {selected ? (
        <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-accent text-accent-fg">
          <Check className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

/**
 * A board's own background: the project's default, one of the presets, or an uploaded image
 * (dimmed behind the columns). Everyone on the project sees it.
 */
export function BoardBackgroundDialog({ open, onOpenChange, board }: { open: boolean; onOpenChange: (open: boolean) => void; board: BoardDTO }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.board(board.project.id) });
  const set = useRpcMutation("board.setBackground", { onSuccess: () => void refresh() });
  const { preset, imageUrl } = board.background;
  const projectLabel = PROJECT_BACKGROUNDS.find((b) => b.id === board.project.background)?.label ?? "Graphite";
  const busy = uploading || set.isPending;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/boards/${board.boardId}/background`, { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed.");
      await refresh();
      toast.success("Background updated.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Board background" description={`Shown behind ${board.board.name}'s columns, for everyone on the project.`} size="lg">
        <div className="grid gap-4">
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-fg-muted">Your own image</p>
            {imageUrl ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="h-16 w-28 shrink-0 overflow-hidden rounded-lg border border-accent ring-1 ring-accent">
                  <img src={imageUrl} alt="Current background" className="h-full w-full object-cover" />
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                    {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} Replace image
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => set.mutate({ boardId: board.boardId, background: preset && isBackgroundId(preset) ? preset : null })}>
                    <Trash2 /> Remove image
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                  {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} Upload image
                </Button>
                <p className="mt-1 text-[11.5px] text-fg-subtle">PNG, JPG, WebP or GIF, up to 15 MB. It&apos;s dimmed a little so cards stay readable.</p>
              </div>
            )}
            <input
              ref={input}
              type="file"
              hidden
              accept={IMAGE_TYPES}
              aria-label="Background image"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-fg-muted">{imageUrl ? "Or a preset (replaces the image)" : "Presets"}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile
                label={`Project default · ${projectLabel}`}
                className={`board-bg-${board.project.background}`}
                selected={!imageUrl && !preset}
                disabled={busy}
                onClick={() => set.mutate({ boardId: board.boardId, background: null })}
              />
              {PROJECT_BACKGROUNDS.map((bg) => (
                <Tile
                  key={bg.id}
                  label={bg.label}
                  className={`board-bg-${bg.id}`}
                  selected={!imageUrl && preset === bg.id}
                  disabled={busy}
                  onClick={() => set.mutate({ boardId: board.boardId, background: bg.id })}
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
