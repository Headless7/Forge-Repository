"use client";

import { Pencil, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useCardMutation } from "@/lib/queries";
import { errorMessage, RpcError } from "@/lib/rpc-client";
import { RichText } from "../comments/rich-text";
import { Button } from "../ui/button";
import { DescriptionTextarea, releaseUnusedImages, useCoverFromDescription, useDescriptionImageUploads, useImageRenderer } from "./description-images";
import { useWorkspace } from "./workspace-context";

/**
 * Description with optimistic-concurrency protection: saves send the text the
 * editor started from, and if someone else changed it meanwhile the server
 * refuses. The user then sees both versions and decides — nothing is lost.
 */
export function Description() {
  const { card, mentionSet } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.description);
  const [base, setBase] = useState(card.description);
  const [conflict, setConflict] = useState<string | null>(null);
  /** Any other failure (permission, validation, server): explained here, the draft kept. */
  const [failure, setFailure] = useState<string | null>(null);
  const images = useDescriptionImageUploads(useMemo(() => ({ id: card.id, projectId: card.projectId, title: card.title, deliverableId: null }), [card.id, card.projectId, card.title]), setDraft);
  const cover = useCoverFromDescription(card.id, card.projectId);
  const renderImage = useImageRenderer({
    attachments: card.attachments,
    coverId: card.coverMode === "MANUAL" ? (card.cover?.attachmentId ?? null) : null,
    canEdit: card.permissions.canEdit,
    onUseAsCover: (id) => cover.forCard(id),
    coverLabel: "Use as card cover",
  });
  const save = useCardMutation("card.update", card.id, card.projectId, {
    silent: true, // explained in the editor (one message, not also a toast)
    onMutate: () => setFailure(null),
    onSuccess: () => {
      setEditing(false);
      setConflict(null);
      images.uploaded.current.clear();
    },
    onError: (error) => {
      if (error instanceof RpcError && error.code === "CONFLICT") {
        setConflict(String(error.details?.current ?? ""));
      } else {
        setFailure(errorMessage(error));
      }
    },
  });
  const canEdit = card.permissions.canEdit;

  const start = () => {
    setDraft(card.description);
    setBase(card.description);
    setConflict(null);
    setFailure(null);
    setEditing(true);
  };
  const cancel = () => {
    // Images added during this edit and never saved don't linger.
    releaseUnusedImages(images.uploaded.current, card.description);
    setEditing(false);
  };

  if (!editing) {
    return (
      <section aria-label="Description" className="group relative">
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Description</h3>
          {canEdit ? (
            <Button size="xs" variant="ghost" onClick={start} className="opacity-60 group-hover:opacity-100">
              <Pencil /> Edit
            </Button>
          ) : null}
        </div>
        {card.description.trim() ? (
          <div role={canEdit ? "button" : undefined} tabIndex={canEdit ? 0 : undefined} onDoubleClick={canEdit ? start : undefined} onKeyDown={(e) => canEdit && e.key === "Enter" && start()}>
            <RichText text={card.description} mentions={mentionSet} className="text-fg" renderImage={renderImage} />
          </div>
        ) : canEdit ? (
          <button type="button" onClick={start} className="w-full rounded-lg border border-dashed border-border-strong px-3 py-3 text-left text-[13px] text-fg-subtle hover:border-fg-subtle hover:text-fg-muted">
            Add a description — references, requirements, links, images…
          </button>
        ) : (
          <p className="text-[13px] text-fg-subtle">No description.</p>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Edit description">
      <h3 className="mb-1.5 text-[13px] font-semibold">Description</h3>
      {conflict !== null ? (
        <div className="mb-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-[12.5px]">
          <p className="flex items-center gap-1.5 font-semibold text-warning">
            <TriangleAlert className="size-4" /> This description was changed by another user while you were editing.
          </p>
          <p className="mt-1 text-fg-muted">Their version:</p>
          <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-surface-2 p-2">
            <RichText text={conflict || "(empty)"} mentions={mentionSet} />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                setDraft(conflict);
                setBase(conflict);
                setConflict(null);
              }}
            >
              Use their version
            </Button>
            <Button size="xs" variant="primary" loading={save.isPending} onClick={() => save.mutate({ cardId: card.id, description: draft, base: { description: conflict } })}>
              Keep mine (overwrite)
            </Button>
          </div>
        </div>
      ) : null}
      <DescriptionTextarea
        autoFocus
        autoGrow
        maxRows={24}
        value={draft}
        onChange={setDraft}
        onImages={images.start}
        busy={images.busy}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !images.busy) save.mutate({ cardId: card.id, description: draft, base: { description: base } });
          if (e.key === "Escape") cancel();
        }}
        placeholder="Supports **bold**, *italic*, `code`, - lists, links, @mentions and images"
        aria-label="Card description"
        className="min-h-32"
        aria-describedby={failure ? "description-save-error" : undefined}
      />
      {failure ? (
        <p id="description-save-error" role="alert" className="mt-2 flex items-start gap-1.5 text-[12.5px] text-danger">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Couldn&apos;t save the description: {failure} Your text is still here — select Save to try again.
        </p>
      ) : save.isPaused ? (
        <p role="status" className="mt-2 text-[12.5px] text-fg-muted">
          Waiting for a connection — it will be saved when you&apos;re back online.
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={images.busy > 0} loading={save.isPending} onClick={() => save.mutate({ cardId: card.id, description: draft, base: { description: base } })}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <span className="ml-auto text-[11px] text-fg-subtle">Ctrl+Enter to save · Esc to cancel</span>
      </div>
    </section>
  );
}
