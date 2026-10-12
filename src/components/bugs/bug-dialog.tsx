"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Copy, Eye, History, Link2, Pencil, Play, RotateCcw, Trash2, Undo2, X, XCircle } from "lucide-react";
import { Dialog as D, VisuallyHidden } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BUG_PRIORITY_META, BUG_PRIORITY_ORDER, BUG_RESOLUTION_META, BUG_RESOLUTION_ORDER, BUG_STATUS_META } from "@/lib/bug-meta";
import { qk, useBugMutation, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { BugDetailDTO, BugListDTO, BugPriority, BugResolution, MemberDTO } from "@/lib/types";
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
import { BugPriorityIcon, BugStatusPill } from "./bug-badges";
import { BugComments } from "./bug-comments";
import { BugMedia, bugMediaFiles, bugUploadTarget, pastedBugMedia } from "./bug-media";
import { PersonPicker, TagPicker } from "./pickers";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-2 py-1.5">
      <span className="pt-1 text-[12px] text-fg-subtle">{label}</span>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  );
}

/** One bug, full screen on phones and a large panel on desktop: media, discussion, fields and the fix workflow. */
export function BugDialog({
  bugId,
  list,
  members,
  studioSlug,
  projectSlug,
  onClose,
}: {
  bugId: string;
  list: BugListDTO;
  members: MemberDTO[];
  studioSlug: string;
  projectSlug: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const { data: bug, isError } = useQuery({ queryKey: qk.bug(bugId), queryFn: () => rpc("bug.get", { bugId }), staleTime: 5_000 });
  const projectId = list.project.id;
  const update = useBugMutation("bug.update", bugId, projectId);
  const setStatus = useBugMutation("bug.setStatus", bugId, projectId);
  const remove = useRpcMutation("bug.delete", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.bugs(projectId) });
      toast.success("Bug deleted.");
      onClose();
    },
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(false);
  const viewerId = list.viewer.userId;
  const perms = bug?.permissions;
  const canAssignOthers = Boolean(perms?.canAssign);
  const milestone = bug?.milestoneId ? list.milestones.find((m) => m.id === bug.milestoneId) : null;
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  useTipOnOpen("bugs.workflow", Boolean(bug));

  const copyLink = () => {
    if (!bug) return;
    const url = `${window.location.origin}/${studioSlug}/${projectSlug}/bugs?bug=${bug.number}`;
    void navigator.clipboard.writeText(url).then(() => toast.success("Link copied"));
  };

  const onPaste = bug && perms?.canUpload ? pastedBugMedia((files) => void uploads.uploadFiles(bugUploadTarget(bug), files, "bug")) : undefined;

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
            if (!bug || !perms?.canUpload || !e.dataTransfer.files.length || e.defaultPrevented) return;
            e.preventDefault();
            const files = bugMediaFiles(e.dataTransfer.files);
            if (files.length) void uploads.uploadFiles(bugUploadTarget(bug), files, "bug");
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={keepOpenForToasts}
          aria-describedby={undefined}
          className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg shadow-lg outline-none data-[state=open]:animate-pop-in md:inset-4 md:rounded-xl md:border md:border-border-strong lg:inset-x-[max(24px,calc((100vw-1280px)/2))] lg:inset-y-6"
        >
          <VisuallyHidden.Root>
            <D.Title>{bug?.title ?? "Bug"}</D.Title>
          </VisuallyHidden.Root>

          <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2 md:px-5">
            <Tooltip content="Copy link to this bug">
              <button type="button" onClick={copyLink} className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 px-2 font-mono text-[11.5px] text-fg-muted hover:text-fg">
                {bug?.key ?? "…"} <Copy className="size-3" />
              </button>
            </Tooltip>
            {milestone ? <span className="hidden text-[12.5px] text-fg-muted sm:inline">{milestone.name}</span> : null}
            <span className="flex-1" />
            {bug ? <BugStatusPill status={bug.status} resolution={bug.resolution} size="md" short className="sm:hidden" /> : null}
            {bug ? <BugStatusPill status={bug.status} resolution={bug.resolution} size="md" className="hidden sm:inline-flex" /> : null}
            <Tooltip content="Copy link">
              <Button size="icon-sm" variant="ghost" aria-label="Copy link" onClick={copyLink} className="hidden sm:inline-flex">
                <Link2 />
              </Button>
            </Tooltip>
            <Tooltip content="Close" shortcut="Esc">
              <D.Close asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Close bug">
                  <X />
                </Button>
              </D.Close>
            </Tooltip>
          </header>

          {isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[15px] font-semibold">This bug doesn&apos;t exist or you no longer have access to it.</p>
              <Button variant="secondary" className="mt-3" onClick={onClose}>
                Back to the list
              </Button>
            </div>
          ) : !bug || !perms ? (
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
                    <TitleEditor bug={bug} canEdit={perms.canEdit} onSave={(title) => update.mutate({ bugId, title })} />
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-muted">
                      <BugPriorityIcon priority={bug.priority} withLabel />
                      <span>
                        · reported by <Person id={bug.reportedById} membersById={membersById} /> <time title={formatDateTime(bug.createdAt)}>{timeAgo(bug.createdAt)}</time>
                      </span>
                      {bug.fixedAt ? (
                        <span>
                          · fixed by <Person id={bug.fixedById} membersById={membersById} /> <time title={formatDateTime(bug.fixedAt)}>{timeAgo(bug.fixedAt)}</time>
                        </span>
                      ) : null}
                      {bug.verifiedAt ? (
                        <span>
                          · verified by <Person id={bug.verifiedById} membersById={membersById} /> <time title={formatDateTime(bug.verifiedAt)}>{timeAgo(bug.verifiedAt)}</time>
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <DescriptionEditor bug={bug} canEdit={perms.canEdit} members={members} onSave={(description) => update.mutate({ bugId, description })} saving={update.isPending} />
                  <BugMedia bug={bug} canUpload={perms.canUpload} />
                  <BugComments bug={bug} members={members} viewerId={viewerId} viewerRole={list.viewer.role} />
                  <section aria-label="History">
                    <button type="button" onClick={() => setHistory((v) => !v)} className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted hover:text-fg" aria-expanded={history}>
                      <History className="size-3.5" /> {history ? "Hide history" : "Show history"}
                    </button>
                    {history ? <BugHistory bugId={bugId} membersById={membersById} /> : null}
                  </section>
                </div>

                <aside className="grid content-start gap-3 lg:sticky lg:top-0">
                  <TipAnchor tip="bugs.workflow" facts={{ canFix: perms.canEdit || (perms.canSelfAssign && !bug.assigneeId), canVerify: perms.canVerify }}>
                    <section className="rounded-xl border border-border bg-surface-2 p-3" aria-label="Fix workflow">
                      <p className="mb-2 text-[12px] text-fg-muted">{BUG_STATUS_META[bug.status].description}</p>
                      <StatusActions bug={bug} pending={setStatus.isPending} onStatus={(status, resolution) => setStatus.mutate({ bugId, status, resolution })} />
                    </section>
                  </TipAnchor>
                  <section className="rounded-xl border border-border bg-surface-2 px-3 py-1.5" aria-label="Details">
                    <Row label="Status">
                      <BugStatusPill status={bug.status} resolution={bug.resolution} size="sm" />
                    </Row>
                    <Row label="Priority">
                      <Select<BugPriority>
                        aria-label="Priority"
                        value={bug.priority}
                        disabled={!perms.canEdit}
                        onValueChange={(priority) => update.mutate({ bugId, priority })}
                        options={BUG_PRIORITY_ORDER.map((p) => ({ value: p, label: BUG_PRIORITY_META[p].label, icon: <BugPriorityIcon priority={p} /> }))}
                        className="h-7"
                      />
                    </Row>
                    <Row label="Update">
                      <Select<string>
                        aria-label="Update"
                        value={bug.milestoneId ?? "none"}
                        disabled={!perms.canEdit}
                        onValueChange={(v) => update.mutate({ bugId, milestoneId: v === "none" ? null : v })}
                        options={[{ value: "none", label: "No update" }, ...list.milestones.filter((m) => !m.archived || m.id === bug.milestoneId).map((m) => ({ value: m.id, label: m.name }))]}
                        className="h-7"
                      />
                    </Row>
                    <Row label="Assignee">
                      <PersonPicker
                        label="Assignee"
                        value={bug.assigneeId}
                        members={canAssignOthers ? members : members.filter((m) => m.id === viewerId)}
                        canEdit={canAssignOthers || (perms.canSelfAssign && !bug.assigneeId) || (perms.canEdit && bug.assigneeId === viewerId)}
                        emptyLabel="Nobody yet"
                        onChange={(assigneeId) => update.mutate({ bugId, assigneeId })}
                      />
                    </Row>
                    <Row label="Reviewer">
                      <PersonPicker label="Reviewer" value={bug.reviewerId} members={members} canEdit={canAssignOthers} emptyLabel="Any manager" onChange={(reviewerId) => update.mutate({ bugId, reviewerId })} />
                    </Row>
                    <Row label="Tags">
                      <TagPicker selected={bug.tagIds} tags={list.tags} projectId={projectId} canEdit={perms.canEdit} canManage={perms.canManageTags} onChange={(tagIds) => update.mutate({ bugId, tagIds })} />
                    </Row>
                    <Row label="Reporter">
                      <Person id={bug.reportedById} membersById={membersById} withAvatar />
                    </Row>
                  </section>
                  {perms.canDelete ? (
                    <Button size="sm" variant="danger-ghost" className="justify-self-start" onClick={() => setConfirmDelete(true)}>
                      <Trash2 /> Delete bug
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
        title="Delete this bug?"
        description="Its comments, pictures and clips go with it. Closing a bug keeps the record; deleting is for mistakes and duplicates."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ bugId })}
      />
    </D.Root>
  );
}

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

/** The buttons that move a bug along, for what the viewer may do right now. */
function StatusActions({ bug, pending, onStatus }: { bug: BugDetailDTO; pending: boolean; onStatus: (status: BugDetailDTO["status"], resolution?: BugResolution | null) => void }) {
  const p = bug.permissions;
  const canStart = p.canEdit || (p.canSelfAssign && !bug.assigneeId);
  const canSendBack = p.canVerify || p.canEdit;
  const buttons: React.ReactNode[] = [];
  const closeButton = p.canClose && bug.status !== "CLOSED" && bug.status !== "VERIFIED" ? <CloseMenu key="close" pending={pending} onClose={(r) => onStatus("CLOSED", r)} /> : null;
  switch (bug.status) {
    case "OPEN":
      if (canStart)
        buttons.push(
          <Button key="start" variant="primary" size="sm" loading={pending} onClick={() => onStatus("IN_PROGRESS")}>
            <Play /> {bug.assigneeId ? "Start work" : "Take it & start"}
          </Button>,
        );
      if (p.canEdit)
        buttons.push(
          <Button key="fixed" variant="secondary" size="sm" loading={pending} onClick={() => onStatus("FIXED")}>
            <CircleCheck /> Mark fixed
          </Button>,
        );
      break;
    case "IN_PROGRESS":
      if (p.canEdit)
        buttons.push(
          <Button key="fixed" variant="primary" size="sm" loading={pending} onClick={() => onStatus("FIXED")}>
            <CircleCheck /> Mark fixed
          </Button>,
        );
      break;
    case "FIXED":
      if (p.canVerify)
        buttons.push(
          <Button key="verify" variant="success" size="sm" loading={pending} onClick={() => onStatus("VERIFIED")}>
            <Eye /> Verify fix
          </Button>,
        );
      if (canSendBack)
        buttons.push(
          <Button key="back" variant="secondary" size="sm" loading={pending} onClick={() => onStatus("IN_PROGRESS")}>
            <Undo2 /> Not fixed
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
  if (!buttons.length) return <p className="text-[12.5px] text-fg-subtle">{bug.status === "FIXED" ? "Waiting for the reviewer to verify the fix." : "Nothing for you to do here."}</p>;
  return <div className="flex flex-wrap gap-1.5">{buttons}</div>;
}

function CloseMenu({ pending, onClose }: { pending: boolean; onClose: (resolution: BugResolution) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" loading={pending}>
          <XCircle /> Close…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Close without a fix</p>
        {BUG_RESOLUTION_ORDER.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => {
              setOpen(false);
              onClose(r);
            }}
            className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-4"
          >
            <span className="block text-[13px] font-medium">{BUG_RESOLUTION_META[r].label}</span>
            <span className="block text-[11.5px] text-fg-muted">{BUG_RESOLUTION_META[r].description}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function TitleEditor({ bug, canEdit, onSave }: { bug: BugDetailDTO; canEdit: boolean; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(bug.title);
  useEffect(() => setValue(bug.title), [bug.title]);
  if (!canEdit) return <h2 className="text-lg font-semibold leading-snug tracking-tight md:text-xl">{bug.title}</h2>;
  if (!editing)
    return (
      <button type="button" onClick={() => setEditing(true)} className="-mx-1.5 rounded-md px-1.5 text-left text-lg font-semibold leading-snug tracking-tight hover:bg-surface-3 md:text-xl" title="Click to rename">
        {bug.title}
      </button>
    );
  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next && next !== bug.title) onSave(next);
    else setValue(bug.title);
  };
  return (
    <Textarea
      autoFocus
      autoGrow
      maxRows={4}
      value={value}
      data-inline-edit
      aria-label="Bug title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          setValue(bug.title);
          setEditing(false);
        }
      }}
      className="min-h-0 w-full resize-none rounded-md border border-accent bg-surface-3 px-1.5 py-0.5 text-lg font-semibold leading-snug md:text-xl"
    />
  );
}

function DescriptionEditor({ bug, canEdit, members, onSave, saving }: { bug: BugDetailDTO; canEdit: boolean; members: MemberDTO[]; onSave: (description: string) => void; saving: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bug.description);
  const mentionSet = useMemo(() => new Set(members.map((m) => m.username)), [members]);
  const start = () => {
    setDraft(bug.description);
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
        {bug.description.trim() ? (
          <RichText text={bug.description} mentions={mentionSet} className="text-fg" />
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

function BugHistory({ bugId, membersById }: { bugId: string; membersById: Map<string, MemberDTO> }) {
  const { data, isLoading } = useQuery({ queryKey: qk.bugActivity(bugId), queryFn: () => rpc("bug.activity", { bugId }) });
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
