"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Copy, Eye, History, Link2, Pencil, Play, RotateCcw, Trash2, Undo2, X, XCircle } from "lucide-react";
import { Dialog as D, VisuallyHidden } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FORUM_KIND_META, ITEM_PRIORITY_ORDER, ITEM_RESOLUTION_META, ITEM_RESOLUTION_ORDER, priorityLabel, statusLabel } from "@/lib/forum-meta";
import { qk, useItemMutation, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { ForumDTO, ForumItemDetailDTO, ForumViewDTO, ItemPriority, ItemResolution, MemberDTO } from "@/lib/types";
import { cn, formatDateTime, timeAgo } from "@/lib/utils";
import { RichText } from "../comments/rich-text";
import { describeActivity } from "../domain/activity-text";
import { UserAvatar } from "../domain/avatar";
import { MemberPopover } from "../domain/member-popover";
import { TipAnchor, useTipOnOpen } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Select, Skeleton } from "../ui/controls";
import { ConfirmDialog, keepOpenForToasts } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/menu";
import { useUploads } from "../upload/upload-manager";
import { ItemPriorityIcon, ItemStatusPill } from "./item-badges";
import { ItemComments } from "./item-comments";
import { ItemMedia, itemMediaFiles, itemUploadTarget, pastedItemMedia } from "./item-media";
import { PersonPicker, TagPicker } from "./pickers";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-2 py-1.5">
      <span className="pt-1 text-[12px] text-fg-subtle">{label}</span>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  );
}

/** One item, full screen on phones and a large panel on desktop: media, discussion, fields and the workflow. */
export function ItemDialog({
  itemId,
  view,
  members,
  studioSlug,
  projectSlug,
  onClose,
}: {
  itemId: string;
  view: ForumViewDTO;
  members: MemberDTO[];
  studioSlug: string;
  projectSlug: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const { forum } = view;
  const noun = forum.itemLabel;
  const wording = FORUM_KIND_META[forum.kind];
  const { data: item, isError } = useQuery({ queryKey: qk.item(itemId), queryFn: () => rpc("item.get", { itemId }), staleTime: 5_000 });
  const projectId = view.project.id;
  const update = useItemMutation("item.update", itemId, projectId);
  const setStatus = useItemMutation("item.setStatus", itemId, projectId);
  const remove = useRpcMutation("item.delete", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.forums(projectId) });
      toast.success(`${capitalize(noun)} deleted.`);
      onClose();
    },
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(false);
  const viewerId = view.viewer.userId;
  const perms = item?.permissions;
  const canAssignOthers = Boolean(perms?.canAssign);
  const milestone = item?.milestoneId ? view.milestones.find((m) => m.id === item.milestoneId) : null;
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useTipOnOpen("forums.workflow", Boolean(item));

  const copyLink = () => {
    if (!item) return;
    const url = `${window.location.origin}/${studioSlug}/${projectSlug}/f/${forum.slug}?item=${item.number}`;
    void navigator.clipboard.writeText(url).then(() => toast.success("Link copied"));
  };

  const onPaste = item && perms?.canUpload ? pastedItemMedia((files) => void uploads.uploadFiles(itemUploadTarget(item), files, "item")) : undefined;

  return (
    <D.Root open onOpenChange={(open) => !open && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content
          onPaste={onPaste}
          onDragOver={(e) => {
            if (perms?.canUpload && e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!item || !perms?.canUpload || !e.dataTransfer.files.length || e.defaultPrevented) return;
            e.preventDefault();
            const files = itemMediaFiles(e.dataTransfer.files);
            if (files.length) void uploads.uploadFiles(itemUploadTarget(item), files, "item");
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={keepOpenForToasts}
          aria-describedby={undefined}
          className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg shadow-lg outline-none data-[state=open]:animate-pop-in md:inset-4 md:rounded-xl md:border md:border-border-strong lg:inset-x-[max(24px,calc((100vw-1280px)/2))] lg:inset-y-6"
        >
          <VisuallyHidden.Root>
            <D.Title>{item?.title ?? capitalize(noun)}</D.Title>
          </VisuallyHidden.Root>

          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2 md:px-5">
            <Tooltip content={`Copy link to this ${noun}`}>
              <button type="button" onClick={copyLink} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 px-2 font-mono text-[11.5px] text-fg-muted hover:text-fg">
                {item?.key ?? "…"} <Copy className="size-3" />
              </button>
            </Tooltip>
            <span className="hidden text-[12.5px] text-fg-muted sm:inline">
              {forum.icon} {forum.name}
              {milestone ? <span className="text-fg-subtle"> · {milestone.name}</span> : null}
            </span>
            <span className="flex-1" />
            {item ? <ItemStatusPill kind={forum.kind} status={item.status} resolution={item.resolution} size="md" short className="sm:hidden" /> : null}
            {item ? <ItemStatusPill kind={forum.kind} status={item.status} resolution={item.resolution} size="md" className="hidden sm:inline-flex" /> : null}
            <Tooltip content="Copy link">
              <Button size="icon-sm" variant="ghost" aria-label="Copy link" onClick={copyLink} className="hidden sm:inline-flex">
                <Link2 />
              </Button>
            </Tooltip>
            <Tooltip content="Close" shortcut="Esc">
              <D.Close asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Close">
                  <X />
                </Button>
              </D.Close>
            </Tooltip>
          </header>

          {isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[15px] font-semibold">This {noun} doesn&apos;t exist or you no longer have access to it.</p>
              <Button variant="secondary" className="mt-3" onClick={onClose}>
                Back to the list
              </Button>
            </div>
          ) : !item || !perms ? (
            <div className="grid gap-4 p-4 md:p-6">
              <Skeleton className="h-7 w-2/3" />
              <Skeleton className="h-24" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              <div className="grid gap-6 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="grid min-w-0 content-start gap-5 [&>*]:min-w-0">
                  <div>
                    <TitleEditor item={item} canEdit={perms.canEdit} onSave={(title) => update.mutate({ itemId, title })} />
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-muted">
                      <ItemPriorityIcon kind={forum.kind} priority={item.priority} withLabel />
                      <span>
                        · reported by <Person id={item.reportedById} membersById={membersById} /> <time title={formatDateTime(item.createdAt)}>{timeAgo(item.createdAt)}</time>
                      </span>
                      {item.fixedAt ? (
                        <span>
                          · {forum.kind === "BUGS" ? "fixed" : "done"} by <Person id={item.fixedById} membersById={membersById} /> <time title={formatDateTime(item.fixedAt)}>{timeAgo(item.fixedAt)}</time>
                        </span>
                      ) : null}
                      {item.verifiedAt ? (
                        <span>
                          · verified by <Person id={item.verifiedById} membersById={membersById} /> <time title={formatDateTime(item.verifiedAt)}>{timeAgo(item.verifiedAt)}</time>
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <DescriptionEditor item={item} canEdit={perms.canEdit} members={members} onSave={(description) => update.mutate({ itemId, description })} saving={update.isPending} />
                  <ItemMedia item={item} noun={noun} canUpload={perms.canUpload} />
                  <ItemComments item={item} members={members} viewerId={viewerId} viewerRole={view.viewer.role} />
                  <section aria-label="History">
                    <button type="button" onClick={() => setHistory((v) => !v)} className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted hover:text-fg" aria-expanded={history}>
                      <History className="size-3.5" /> {history ? "Hide history" : "Show history"}
                    </button>
                    {history ? <ItemHistory itemId={itemId} membersById={membersById} /> : null}
                  </section>
                </div>

                <aside className="grid content-start gap-3 lg:sticky lg:top-0">
                  <TipAnchor tip="forums.workflow" facts={{ canFix: perms.canEdit || (perms.canSelfAssign && !item.assigneeId), canVerify: perms.canVerify, noun }}>
                    <section className="rounded-xl border border-border bg-surface-2 p-3" aria-label="Workflow">
                      <p className="mb-2 text-[12px] text-fg-muted">{statusLabel(forum.kind, item.status).description}</p>
                      <StatusActions item={item} forum={forum} pending={setStatus.isPending} onStatus={(status, resolution) => setStatus.mutate({ itemId, status, resolution })} />
                    </section>
                  </TipAnchor>
                  <section className="rounded-xl border border-border bg-surface-2 px-3 py-1.5" aria-label="Details">
                    <Row label="Status">
                      <ItemStatusPill kind={forum.kind} status={item.status} resolution={item.resolution} size="sm" />
                    </Row>
                    <Row label="Priority">
                      <Select<ItemPriority>
                        aria-label="Priority"
                        value={item.priority}
                        disabled={!perms.canEdit}
                        onValueChange={(priority) => update.mutate({ itemId, priority })}
                        options={ITEM_PRIORITY_ORDER.map((p) => ({ value: p, label: priorityLabel(forum.kind, p), icon: <ItemPriorityIcon kind={forum.kind} priority={p} /> }))}
                        className="h-7"
                      />
                    </Row>
                    <Row label="Update">
                      <Select<string>
                        aria-label="Update"
                        value={item.milestoneId ?? "none"}
                        disabled={!perms.canEdit}
                        onValueChange={(v) => update.mutate({ itemId, milestoneId: v === "none" ? null : v })}
                        options={[{ value: "none", label: "No update" }, ...view.milestones.filter((m) => !m.archived || m.id === item.milestoneId).map((m) => ({ value: m.id, label: m.name }))]}
                        className="h-7"
                      />
                    </Row>
                    <Row label="Assignee">
                      <PersonPicker
                        label="Assignee"
                        value={item.assigneeId}
                        members={canAssignOthers ? members : members.filter((m) => m.id === viewerId)}
                        canEdit={canAssignOthers || (perms.canSelfAssign && !item.assigneeId) || (perms.canEdit && item.assigneeId === viewerId)}
                        emptyLabel="Nobody yet"
                        onChange={(assigneeId) => update.mutate({ itemId, assigneeId })}
                      />
                    </Row>
                    <Row label="Reviewer">
                      <PersonPicker label="Reviewer" value={item.reviewerId} members={members} canEdit={canAssignOthers} emptyLabel="Any manager" onChange={(reviewerId) => update.mutate({ itemId, reviewerId })} />
                    </Row>
                    <Row label="Tags">
                      <TagPicker selected={item.tagIds} tags={view.tags} forumId={forum.id} projectId={projectId} canEdit={perms.canEdit} canManage={perms.canManageTags} onChange={(tagIds) => update.mutate({ itemId, tagIds })} />
                    </Row>
                    <Row label="Reporter">
                      <Person id={item.reportedById} membersById={membersById} withAvatar />
                    </Row>
                  </section>
                  {perms.canDelete ? (
                    <Button size="sm" variant="danger-ghost" className="justify-self-start" onClick={() => setConfirmDelete(true)}>
                      <Trash2 /> Delete {noun}
                    </Button>
                  ) : null}
                </aside>
              </div>
            </div>
          )}
        </D.Content>
      </D.Portal>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete this ${noun}?`}
        description={`Its comments, pictures and clips go with it. Closing a ${noun} keeps the record; deleting is for mistakes and duplicates.`}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ itemId })}
      />
    </D.Root>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Person({ id, membersById, withAvatar }: { id: string | null; membersById: Map<string, MemberDTO>; withAvatar?: boolean }) {
  const m = id ? membersById.get(id) : undefined;
  if (!m) return <span className="text-fg-subtle">{id ? "a former member" : "nobody"}</span>;
  return (
    <MemberPopover user={m} member={m} className={cn("touch-target max-w-full gap-1.5 font-medium text-fg", withAvatar && "gap-2")}>
      {withAvatar ? <UserAvatar user={m} size="xs" online={m.online} /> : null}
      <span className="truncate">{m.displayName}</span>
    </MemberPopover>
  );
}

/** The buttons that move an item along, for what the viewer may do right now. */
function StatusActions({ item, forum, pending, onStatus }: { item: ForumItemDetailDTO; forum: ForumDTO; pending: boolean; onStatus: (status: ForumItemDetailDTO["status"], resolution?: ItemResolution | null) => void }) {
  const p = item.permissions;
  const words = FORUM_KIND_META[forum.kind].actions;
  const canStart = p.canEdit || (p.canSelfAssign && !item.assigneeId);
  const canSendBack = p.canVerify || p.canEdit;
  const buttons: React.ReactNode[] = [];
  const closeButton = p.canClose && item.status !== "CLOSED" && item.status !== "VERIFIED" ? <CloseMenu key="close" pending={pending} onClose={(r) => onStatus("CLOSED", r)} /> : null;
  switch (item.status) {
    case "OPEN":
      if (canStart)
        buttons.push(
          <Button key="start" variant="primary" size="sm" loading={pending} onClick={() => onStatus("IN_PROGRESS")}>
            <Play /> {item.assigneeId ? "Start work" : "Take it & start"}
          </Button>,
        );
      if (p.canEdit)
        buttons.push(
          <Button key="done" variant="secondary" size="sm" loading={pending} onClick={() => onStatus("FIXED")}>
            <CircleCheck /> {words.done}
          </Button>,
        );
      break;
    case "IN_PROGRESS":
      if (p.canEdit)
        buttons.push(
          <Button key="done" variant="primary" size="sm" loading={pending} onClick={() => onStatus("FIXED")}>
            <CircleCheck /> {words.done}
          </Button>,
        );
      break;
    case "FIXED":
      if (p.canVerify)
        buttons.push(
          <Button key="verify" variant="success" size="sm" loading={pending} onClick={() => onStatus("VERIFIED")}>
            <Eye /> {words.verify}
          </Button>,
        );
      if (canSendBack)
        buttons.push(
          <Button key="back" variant="secondary" size="sm" loading={pending} onClick={() => onStatus("IN_PROGRESS")}>
            <Undo2 /> {words.sendBack}
          </Button>,
        );
      break;
    case "VERIFIED":
    case "CLOSED":
      if (p.canEdit || p.canVerify)
        buttons.push(
          <Button key="reopen" variant="secondary" size="sm" loading={pending} onClick={() => onStatus("OPEN")}>
            <RotateCcw /> Reopen
          </Button>,
        );
      break;
  }
  if (closeButton) buttons.push(closeButton);
  if (!buttons.length) return <p className="text-[12.5px] text-fg-subtle">{item.status === "FIXED" ? "Waiting for the reviewer to verify it." : "Nothing for you to do here."}</p>;
  return <div className="flex flex-wrap gap-1.5">{buttons}</div>;
}

function CloseMenu({ pending, onClose }: { pending: boolean; onClose: (resolution: ItemResolution) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" loading={pending}>
          <XCircle /> Close…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Close without doing it</p>
        {ITEM_RESOLUTION_ORDER.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => {
              setOpen(false);
              onClose(r);
            }}
            className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-4"
          >
            <span className="block text-[13px] font-medium">{ITEM_RESOLUTION_META[r].label}</span>
            <span className="block text-[11.5px] text-fg-muted">{ITEM_RESOLUTION_META[r].description}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function TitleEditor({ item, canEdit, onSave }: { item: ForumItemDetailDTO; canEdit: boolean; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.title);
  useEffect(() => setValue(item.title), [item.title]);
  if (!canEdit) return <h2 className="text-lg font-semibold leading-snug tracking-tight md:text-xl">{item.title}</h2>;
  if (!editing)
    return (
      <button type="button" onClick={() => setEditing(true)} className="-mx-1.5 rounded-md px-1.5 text-left text-lg font-semibold leading-snug tracking-tight hover:bg-surface-3 md:text-xl" title="Click to rename">
        {item.title}
      </button>
    );
  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== item.title) onSave(next);
    else setValue(item.title);
  };
  return (
    <Textarea
      autoFocus
      autoGrow
      maxRows={4}
      value={value}
      data-inline-edit
      aria-label="Title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          setValue(item.title);
          setEditing(false);
        }
      }}
      className="min-h-0 w-full resize-none rounded-md border border-accent bg-surface-3 px-1.5 py-0.5 text-lg font-semibold leading-snug md:text-xl"
    />
  );
}

function DescriptionEditor({ item, canEdit, members, onSave, saving }: { item: ForumItemDetailDTO; canEdit: boolean; members: MemberDTO[]; onSave: (description: string) => void; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.description);
  const mentionSet = useMemo(() => new Set(members.map((m) => m.username)), [members]);
  const start = () => {
    setDraft(item.description);
    setEditing(true);
  };
  if (!editing) {
    return (
      <section aria-label="Description" className="group">
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">What happens</h3>
          {canEdit ? (
            <Button size="xs" variant="ghost" onClick={start} className="opacity-60 group-hover:opacity-100">
              <Pencil /> Edit
            </Button>
          ) : null}
        </div>
        {item.description.trim() ? (
          <RichText text={item.description} mentions={mentionSet} className="text-fg" />
        ) : canEdit ? (
          <button type="button" onClick={start} className="w-full rounded-lg border border-dashed border-border-strong px-3 py-3 text-left text-[13px] text-fg-subtle hover:border-fg-subtle hover:text-fg-muted">
            Describe it — steps to reproduce, what you expected, links to Discord reports…
          </button>
        ) : (
          <p className="text-[13px] text-fg-subtle">No description.</p>
        )}
      </section>
    );
  }
  const save = () => {
    onSave(draft);
    setEditing(false);
  };
  return (
    <section aria-label="Edit description">
      <h3 className="mb-1.5 text-[13px] font-semibold">What happens</h3>
      <Textarea
        autoFocus
        autoGrow
        maxRows={24}
        value={draft}
        data-inline-edit
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="Steps to reproduce, what you expected, where it happens. Supports **bold**, - lists, links and @mentions."
        className="min-h-28"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="primary" loading={saving} onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <span className="ml-auto text-[11px] text-fg-subtle">Ctrl+Enter to save · Esc to cancel</span>
      </div>
    </section>
  );
}

function ItemHistory({ itemId, membersById }: { itemId: string; membersById: Map<string, MemberDTO> }) {
  const { data, isLoading } = useQuery({ queryKey: qk.itemActivity(itemId), queryFn: () => rpc("item.activity", { itemId }) });
  const name = (id: string) => membersById.get(id)?.displayName ?? "someone";
  if (isLoading) return <Skeleton className="mt-2 h-16" />;
  if (!data?.length) return <p className="mt-2 text-[12.5px] text-fg-subtle">No history yet.</p>;
  return (
    <ol className="mt-2 grid gap-1.5">
      {data.map((e) => (
        <li key={e.id} className="flex items-start gap-2 text-[12.5px]">
          <UserAvatar user={e.actor} size="xs" className="mt-0.5" />
          <p className="min-w-0 flex-1 text-fg-muted">
            <strong className="font-medium text-fg">{e.actor?.displayName ?? "Someone"}</strong> {describeActivity(e, name, false)}{" "}
            <time className="text-fg-subtle" title={formatDateTime(e.createdAt)}>
              · {timeAgo(e.createdAt)}
            </time>
          </p>
        </li>
      ))}
    </ol>
  );
}
