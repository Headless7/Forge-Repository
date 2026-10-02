"use client";

import { Download, File as FileIcon, Film, Image as ImageIcon, Paperclip, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useCardMutation } from "@/lib/queries";
import { formatBytes, timeAgo } from "@/lib/utils";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/menu";
import { useUploads } from "../upload/upload-manager";
import { useWorkspace } from "./workspace-context";

/** Reference files that aren't part of a reviewable version (Roblox .rbxm, PSDs, docs…). */
export function ReferenceFiles() {
  const { card, membersById, uploadTarget, viewerId } = useWorkspace();
  const uploads = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const remove = useCardMutation("attachment.archive", card.id, card.projectId);
  const setCover = useCardMutation("attachment.setCover", card.id, card.projectId);
  const files = card.attachments.filter((a) => a.purpose === "CARD");
  if (!files.length && !card.permissions.canUpload) return null;
  return (
    <section aria-label="Attachments">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">
          Attachments {files.length ? <span className="font-normal text-fg-muted">({files.length})</span> : null}
        </h3>
        {card.permissions.canUpload ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => input.current?.click()}>
              <Paperclip /> Attach files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void uploads.uploadFiles(uploadTarget, [...(e.target.files ?? [])], "attachment");
                e.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="text-[12.5px] text-fg-subtle">Reference files, place files (.rbxl/.rbxm), docs — anything that isn't a reviewable version.</p>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {files.map((a) => {
            const uploader = a.uploadedById ? membersById.get(a.uploadedById) : undefined;
            return (
              <li key={a.id} className="group flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 p-2">
                <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-4">
                  {a.thumbUrl ? <img src={a.thumbUrl} alt="" className="h-full w-full object-cover" /> : a.kind === "VIDEO" ? <Film className="size-4 text-fg-subtle" /> : a.kind === "IMAGE" ? <ImageIcon className="size-4 text-fg-subtle" /> : <FileIcon className="size-4 text-fg-subtle" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium">{a.filename}</p>
                  <p className="truncate text-[11px] text-fg-subtle">
                    {formatBytes(a.sizeBytes)} · {uploader?.displayName ?? "someone"} · {timeAgo(a.createdAt)}
                    {a.status === "FAILED" ? <span className="text-danger"> · failed</span> : null}
                  </p>
                </div>
                {card.cover?.attachmentId === a.id ? <span className="rounded bg-accent-soft px-1.5 text-[10.5px] font-medium leading-5 text-accent">Cover</span> : null}
                {(a.kind === "IMAGE" || a.kind === "VIDEO") && a.status !== "FAILED" && card.permissions.canEdit && card.cover?.attachmentId !== a.id ? (
                  <Tooltip content="Use as board cover">
                    <Button size="icon-xs" variant="ghost" aria-label={`Use ${a.filename} as cover`} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" onClick={() => setCover.mutate({ cardId: card.id, attachmentId: a.id })}>
                      <ImageIcon />
                    </Button>
                  </Tooltip>
                ) : null}
                {a.downloadUrl ? (
                  <Tooltip content="Download">
                    <Button size="icon-xs" variant="ghost" asChild aria-label={`Download ${a.filename}`}>
                      <a href={a.downloadUrl}>
                        <Download />
                      </a>
                    </Button>
                  </Tooltip>
                ) : null}
                {card.permissions.canEdit || a.uploadedById === viewerId ? (
                  <Tooltip content="Remove">
                    <Button size="icon-xs" variant="ghost" aria-label={`Remove ${a.filename}`} className="opacity-0 group-hover:opacity-100" onClick={() => remove.mutate({ attachmentId: a.id })}>
                      <Trash2 />
                    </Button>
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
