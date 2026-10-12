"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Film, ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FORUM_KIND_META, ITEM_PRIORITY_META, ITEM_PRIORITY_ORDER, priorityLabel, withArticle } from "@/lib/forum-meta";
import { qk, useRpcMutation } from "@/lib/queries";
import { recentPeopleKey } from "@/lib/recent-people";
import type { ForumItemDetailDTO, ForumViewDTO, ItemPriority, MemberDTO } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Input, Label, Textarea } from "../ui/input";
import { useUploads } from "../upload/upload-manager";
import { ItemPriorityIcon } from "./item-badges";
import { ITEM_MEDIA_ACCEPT, itemMediaFiles, itemUploadTarget, pastedItemMedia } from "./item-media";
import { PersonPicker, TagPicker } from "./pickers";

interface Picked {
  id: string;
  file: File;
  preview: string | null;
}

/** Report an item: the essentials in one form, with screenshots or a clip attached before it's sent. */
export function NewItemDialog({
  open,
  onOpenChange,
  view,
  members,
  defaultMilestoneId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: ForumViewDTO;
  members: MemberDTO[];
  /** The update the list is filtered to, so the item lands there. */
  defaultMilestoneId: string | null;
  onCreated: (item: ForumItemDetailDTO) => void;
}) {
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const { forum } = view;
  const noun = forum.itemLabel;
  const verb = FORUM_KIND_META[forum.kind].actions.create;
  const can = (p: (typeof view.viewer.permissions)[number]) => view.viewer.permissions.includes(p);
  const canAssign = can("item.assign");
  const viewerId = view.viewer.userId;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<ItemPriority>("MEDIUM");
  const [milestoneId, setMilestoneId] = useState<string | null>(defaultMilestoneId);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [reviewerId, setReviewerId] = useState<string | null>(forum.settings.defaultReviewerId);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [files, setFiles] = useState<Picked[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setMilestoneId(defaultMilestoneId);
  }, [open, defaultMilestoneId]);
  useEffect(() => () => files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), [files]);

  const reset = () => {
    setTitle("");
    setDescription("");
    setPriority("MEDIUM");
    setAssigneeId(null);
    setReviewerId(forum.settings.defaultReviewerId);
    setTagIds([]);
    setFiles([]);
  };

  const create = useRpcMutation("item.create", {
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: qk.forums(view.project.id) });
      if (files.length) void uploads.uploadFiles(itemUploadTarget(item), files.map((f) => f.file), "item");
      toast.success(`${item.key} reported.`);
      reset();
      onOpenChange(false);
      onCreated(item);
    },
  });

  const addFiles = (picked: File[]) => {
    const media = itemMediaFiles(picked);
    if (!media.length) {
      toast.error("Pictures (PNG, JPEG, WebP, GIF) and clips (MP4, WebM, MOV) only.");
      return;
    }
    setFiles((list) => [...list, ...media.map((file) => ({ id: crypto.randomUUID(), file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null }))]);
  };

  const submit = () => {
    if (!title.trim()) return;
    create.mutate({ forumId: forum.id, title: title.trim(), description: description.trim() || undefined, priority, milestoneId, assigneeId, reviewerId, tagIds });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title={`${verb} ${withArticle(noun)}`}
        description={`One line that says what's wrong, then whatever helps someone reproduce it. It goes to ${forum.icon} ${forum.name}.`}
        onPaste={pastedItemMedia(addFiles)}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <Label htmlFor="item-title">What&apos;s wrong</Label>
            <Input id="item-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Non-upgraded lamps float above the ground in the lobby" maxLength={200} required />
          </div>
          <div>
            <Label htmlFor="item-description">Details</Label>
            <Textarea
              id="item-description"
              autoGrow
              maxRows={12}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
              }}
              placeholder="Steps to reproduce, what you expected, a link to the Discord report…"
              className="min-h-20"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Priority</Label>
              <Select<ItemPriority> aria-label="Priority" value={priority} onValueChange={setPriority} options={ITEM_PRIORITY_ORDER.map((p) => ({ value: p, label: priorityLabel(forum.kind, p), icon: <ItemPriorityIcon kind={forum.kind} priority={p} /> }))} />
              <p className="mt-1 text-[11.5px] text-fg-subtle">{ITEM_PRIORITY_META[priority].description}</p>
            </div>
            <div>
              <Label>Update</Label>
              <Select<string>
                aria-label="Update"
                value={milestoneId ?? "none"}
                onValueChange={(v) => setMilestoneId(v === "none" ? null : v)}
                options={[{ value: "none", label: "No update" }, ...view.milestones.filter((m) => !m.archived).map((m) => ({ value: m.id, label: m.name }))]}
              />
            </div>
            <div>
              <Label>Assign to</Label>
              <div className="rounded-md border border-border-strong/70 bg-surface-3/60 px-2.5 py-1 text-[13px]">
                <PersonPicker label="Assignee" value={assigneeId} members={canAssign ? members : members.filter((m) => m.id === viewerId)} canEdit emptyLabel={canAssign ? "Nobody yet" : "Nobody yet (or me)"} onChange={setAssigneeId} recentKey={recentPeopleKey(view.project.id, `forum:${forum.id}:assignee`)} />
              </div>
            </div>
            <div>
              <Label>Verified by</Label>
              <div className="rounded-md border border-border-strong/70 bg-surface-3/60 px-2.5 py-1 text-[13px]">
                <PersonPicker label="Reviewer" value={reviewerId} members={members} canEdit={canAssign} emptyLabel="Any manager" onChange={setReviewerId} />
              </div>
            </div>
          </div>
          <div>
            <Label>Tags</Label>
            <TagPicker selected={tagIds} tags={view.tags} forumId={forum.id} projectId={view.project.id} canEdit canManage={can("forum.manage")} onChange={setTagIds} />
          </div>
          <div>
            <Label>Pictures &amp; clips</Label>
            <div className="flex flex-wrap gap-2">
              {files.map((f) => (
                <div key={f.id} className="relative flex h-16 w-24 items-center justify-center overflow-hidden rounded-md border border-border-strong bg-surface-4">
                  {f.preview ? <img src={f.preview} alt="" className="size-full object-cover" /> : <Film className="size-5 text-fg-subtle" />}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-[10px] text-white" title={f.file.name}>
                    {formatBytes(f.file.size)}
                  </span>
                  <button type="button" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))} className="touch-target absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white hover:bg-black/80">
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => input.current?.click()} className="flex h-16 w-24 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-border-strong text-[11px] text-fg-subtle hover:border-fg-subtle hover:text-fg-muted">
                <ImagePlus className="size-4" /> Add
              </button>
            </div>
            <p className="mt-1 text-[11.5px] text-fg-subtle [@media(pointer:coarse)]:hidden">Drop files anywhere here, or paste a screenshot (Ctrl+V).</p>
            <input
              ref={input}
              type="file"
              hidden
              multiple
              accept={ITEM_MEDIA_ACCEPT}
              aria-label="Add pictures or clips"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()} loading={create.isPending}>
              {verb} {noun}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
