"use client";

import { format } from "date-fns";
import { Archive, ArchiveRestore, Bell, BellOff, Check, Copy, ExternalLink, Link2, Plus, Trash2, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { LABEL_COLORS } from "@/lib/column-icons";
import { PRIORITY_META, PRIORITY_ORDER } from "@/lib/card-meta";
import { qk, useCardMutation, useRpcMutation } from "@/lib/queries";
import type { CardLink, MemberDTO, Priority } from "@/lib/types";
import { cn, dueStatus, formatDateTime, timeAgo, toLocalInput } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useBoard } from "../board/board-context";
import { AvatarStack, UserAvatar } from "../domain/avatar";
import { DueChip, LabelChip, PriorityIcon, StatePill } from "../domain/state";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { CoverControl } from "./cover-control";
import { ProductionPanel } from "./production-panel";
import { ReviewActions } from "./review-panel";
import { useWorkspace } from "./workspace-context";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-2 py-1.5">
      <span className="pt-1 text-[12px] text-fg-subtle">{label}</span>
      <div className="min-w-0 text-[13px]">{children}</div>
    </div>
  );
}

function PeoplePicker({
  selected,
  members,
  canEdit,
  onToggle,
  emptyLabel,
  filter,
  onClosed,
}: {
  selected: string[];
  members: MemberDTO[];
  canEdit: boolean;
  onToggle: (userId: string, add: boolean) => void;
  emptyLabel: string;
  filter?: (m: MemberDTO) => boolean;
  /** The picker closed; `changed` says whether anyone was added or removed. */
  onClosed?: (changed: boolean) => void;
}) {
  const { membersById } = useWorkspace();
  const changed = useRef(false);
  const people = selected.map((id) => membersById.get(id)).filter((m): m is MemberDTO => Boolean(m));
  const content =
    people.length === 0 ? (
      <span className="text-fg-subtle">{emptyLabel}</span>
    ) : (
      <span className="flex flex-col gap-1">
        {people.map((m) => (
          <span key={m.id} className="flex items-center gap-2">
            <UserAvatar user={m} size="xs" online={m.online} />
            <span className="truncate">{m.displayName}</span>
          </span>
        ))}
      </span>
    );
  if (!canEdit) return content;
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) return;
        onClosed?.(changed.current);
        changed.current = false;
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className="-mx-1.5 w-[calc(100%+12px)] rounded-md px-1.5 py-1 text-left hover:bg-surface-3">
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <ul className="scrollbar-thin max-h-72 overflow-y-auto">
          {members.filter((m) => (filter ? filter(m) : true)).map((m) => {
            const on = selected.includes(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    changed.current = true;
                    onToggle(m.id, !on);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-4"
                >
                  <UserAvatar user={m} size="xs" online={m.online} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.displayName}</span>
                    {m.title ? <span className="block truncate text-[11px] text-fg-subtle">{m.title}</span> : null}
                  </span>
                  {on ? <Check className="size-4 text-accent" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function LinksEditor({ links, canEdit, onChange }: { links: CardLink[]; canEdit: boolean; onChange: (links: CardLink[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const add = () => {
    if (!/^https?:\/\//i.test(url.trim())) {
      toast.error("Links must start with http:// or https://");
      return;
    }
    onChange([...links, { id: crypto.randomUUID().slice(0, 8), label: label.trim(), url: url.trim() }]);
    setLabel("");
    setUrl("");
    setAdding(false);
  };
  return (
    <div className="grid gap-1">
      {links.map((l) => (
        <div key={l.id} className="group flex items-center gap-1.5">
          <ExternalLink className="size-3.5 shrink-0 text-fg-subtle" />
          <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 flex-1 truncate text-accent hover:underline">
            {l.label || l.url.replace(/^https?:\/\//, "")}
          </a>
          {canEdit ? (
            <button type="button" aria-label="Remove link" onClick={() => onChange(links.filter((x) => x.id !== l.id))} className="hover-reveal text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100">
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
      {links.length === 0 && !adding ? <span className="text-fg-subtle">None</span> : null}
      {canEdit && adding ? (
        <div className="grid gap-1.5 rounded-md border border-border-strong p-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className="h-7 text-[12.5px]" />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="h-7 text-[12.5px]" onKeyDown={(e) => e.key === "Enter" && add()} />
          <div className="flex gap-1">
            <Button size="xs" variant="primary" onClick={add} disabled={!url.trim()}>
              Add link
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : canEdit ? (
        <button type="button" onClick={() => setAdding(true)} className="flex min-h-6 items-center gap-1 text-[12px] text-fg-subtle hover:text-fg">
          <Link2 className="size-3.5" /> Add link
        </button>
      ) : null}
    </div>
  );
}

export function CardSidebar({ onApprove, onRequestChanges, onSubmit, onUploadVersion, onClose }: { onApprove: () => void; onRequestChanges: () => void; onSubmit: () => void; onUploadVersion: () => void; onClose: () => void }) {
  const { card, members, membersById, viewerId, scope, multi } = useWorkspace();
  const { board, studioSlug, can } = useBoard();
  const queryClient = useQueryClient();
  const perms = card.permissions;
  const tutorial = useTutorial();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmKey, setConfirmKey] = useState("");
  const update = useCardMutation("card.update", card.id, card.projectId);
  const assignees = useCardMutation("card.assignees", card.id, card.projectId);
  const reviewers = useCardMutation("card.reviewers", card.id, card.projectId);
  const labels = useCardMutation("card.labels", card.id, card.projectId);
  const watch = useCardMutation("card.watch", card.id, card.projectId);
  const move = useCardMutation("card.move", card.id, card.projectId);
  const archive = useCardMutation("card.archive", card.id, card.projectId);
  const duplicate = useRpcMutation("card.duplicate", {
    onSuccess: (copy) => {
      void queryClient.invalidateQueries({ queryKey: qk.board(card.projectId) });
      toast.success(`Duplicated as ${copy.key}.`);
    },
  });
  const remove = useRpcMutation("card.delete", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.board(card.projectId) });
      toast.success("Card permanently deleted.");
      onClose();
    },
  });
  const createLabel = useRpcMutation("label.create", {
    onSuccess: (label) => {
      void queryClient.invalidateQueries({ queryKey: qk.board(card.projectId) });
      labels.mutate({ cardId: card.id, labelIds: [...card.labelIds, label.id] });
    },
  });
  const [newLabel, setNewLabel] = useState("");
  const watching = card.watcherIds.includes(viewerId);
  const creator = card.createdById ? membersById.get(card.createdById) : undefined;
  const reviewCapable = (m: MemberDTO) => ["OWNER", "ADMIN", "MANAGER"].includes(m.role);
  const due = dueStatus(card.dueAt, card.state === "APPROVED");

  const copyLink = () => {
    void navigator.clipboard.writeText(`${window.location.origin}/${studioSlug}/${board.project.slug}?card=${card.key}`).then(() => toast.success("Link copied"));
  };

  return (
    <aside aria-label="Card details" className="grid content-start gap-4">
      <section className="rounded-xl border border-border bg-surface-2 p-3">
        <p className="mb-2 truncate text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          {scope && multi ? `Review · ${scope.deliverable.name}` : multi ? "Review · all deliverables" : "Review state"}
        </p>
        <StatePill
          state={scope ? scope.state : card.state}
          size="lg"
          className="w-full justify-center"
          extra={!multi && card.state === "CHANGES_REQUESTED" && card.counts.unresolvedFeedback ? `${card.counts.unresolvedFeedback} unresolved` : null}
        />
        {scope ? (
          <div className="mt-3">
            <ReviewActions onApprove={onApprove} onRequestChanges={onRequestChanges} onSubmit={onSubmit} onUploadVersion={onUploadVersion} />
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-fg-muted">The card shows what needs attention first across its deliverables. Open a deliverable to submit or review it.</p>
        )}
      </section>

      <ProductionPanel />

      <section className="rounded-xl border border-border bg-surface-2 px-3 py-1.5">
        <TipAnchor tip="card.assignment" facts={{ canAssign: perms.canAssign, multi }}>
          <div>
            <Row label="Assignees">
              <PeoplePicker
                selected={card.assigneeIds}
                members={perms.canAssign ? members : members.filter((m) => m.id === viewerId)}
                canEdit={perms.canAssign || perms.canSelfAssign}
                emptyLabel={perms.canSelfAssign ? "Assign yourself" : "Nobody"}
                onToggle={(userId, add) => assignees.mutate({ cardId: card.id, ...(add ? { add: [userId] } : { remove: [userId] }) })}
                // After assigning (picker closed): who's responsible for what.
                onClosed={(changedAny) => changedAny && tutorial.trigger("card.assignment")}
              />
            </Row>
          </div>
        </TipAnchor>
        <Row label="Reviewers">
          <PeoplePicker
            selected={card.reviewerIds}
            members={members}
            filter={reviewCapable}
            canEdit={perms.canAssign}
            emptyLabel="Any manager"
            onToggle={(userId, add) => reviewers.mutate({ cardId: card.id, ...(add ? { add: [userId] } : { remove: [userId] }) })}
          />
        </Row>
        <Row label="Category">
          <Select
            aria-label="Category"
            value={card.columnId}
            disabled={!perms.canMove}
            onValueChange={(columnId) => move.mutate({ cardId: card.id, toColumnId: columnId })}
            options={board.columns.map((c) => ({ value: c.id, label: c.name }))}
            className="h-7"
          />
        </Row>
        <Row label="Priority">
          <Select<Priority>
            aria-label="Priority"
            value={card.priority}
            disabled={!perms.canEdit}
            onValueChange={(priority) => update.mutate({ cardId: card.id, priority })}
            options={PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_META[p].label, icon: <PriorityIcon priority={p} /> }))}
            className="h-7"
          />
        </Row>
        <Row label="Start date">
          {perms.canEdit ? (
            <div className="flex items-center gap-1">
              <input
                type="datetime-local"
                aria-label="Start date"
                value={toLocalInput(card.startAt)}
                onChange={(e) => update.mutate({ cardId: card.id, startAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                className="h-7 min-w-0 flex-1 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none focus:border-accent [color-scheme:dark] light:[color-scheme:light]"
              />
              {card.startAt ? (
                <Button size="icon-xs" variant="ghost" aria-label="Clear start date" onClick={() => update.mutate({ cardId: card.id, startAt: null })}>
                  <X />
                </Button>
              ) : null}
            </div>
          ) : card.startAt ? (
            <span className="text-[12.5px]">{formatDateTime(card.startAt)}</span>
          ) : (
            <span className="text-fg-subtle">None</span>
          )}
        </Row>
        <Row label="Due date">
          {perms.canEdit ? (
            <div className="flex items-center gap-1">
              <input
                type="datetime-local"
                aria-label="Due date"
                value={toLocalInput(card.dueAt)}
                onChange={(e) => update.mutate({ cardId: card.id, dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                className={cn("h-7 min-w-0 flex-1 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none focus:border-accent [color-scheme:dark] light:[color-scheme:light]", due === "overdue" && "text-state-changes", (due === "today" || due === "soon") && "text-state-review")}
              />
              {card.dueAt ? (
                <Button size="icon-xs" variant="ghost" aria-label="Clear due date" onClick={() => update.mutate({ cardId: card.id, dueAt: null })}>
                  <X />
                </Button>
              ) : null}
            </div>
          ) : card.dueAt ? (
            <DueChip dueAt={card.dueAt} done={card.state === "APPROVED"} />
          ) : (
            <span className="text-fg-subtle">None</span>
          )}
        </Row>
        <Row label="Milestone">
          <Select
            aria-label="Milestone"
            value={card.milestoneId ?? "none"}
            disabled={!perms.canEdit}
            onValueChange={(v) => update.mutate({ cardId: card.id, milestoneId: v === "none" ? null : v })}
            options={[{ value: "none", label: "No milestone" }, ...board.milestones.filter((m) => !m.archived || m.id === card.milestoneId).map((m) => ({ value: m.id, label: m.name }))]}
            className="h-7"
          />
        </Row>
        <Row label="Labels">
          <div className="flex flex-wrap items-center gap-1">
            {card.labelIds.map((id) => {
              const label = board.labels.find((l) => l.id === id);
              return label ? <LabelChip key={id} label={label} /> : null;
            })}
            {perms.canEdit ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" aria-label="Edit labels" className="touch-target flex h-[18px] items-center rounded border border-dashed border-border-strong px-1 text-fg-subtle hover:text-fg">
                    <Plus className="size-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-60 p-1">
                  {board.labels.map((l) => {
                    const on = card.labelIds.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => labels.mutate({ cardId: card.id, labelIds: on ? card.labelIds.filter((x) => x !== l.id) : [...card.labelIds, l.id] })}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-4"
                      >
                        <LabelChip label={l} />
                        <span className="flex-1" />
                        {on ? <Check className="size-4 text-accent" /> : null}
                      </button>
                    );
                  })}
                  {can("label.manage") ? (
                    <div className="mt-1 flex gap-1 border-t border-border p-1 pt-2">
                      <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="New label" className="h-7 text-[12.5px]" onKeyDown={(e) => {
                        if (e.key === "Enter" && newLabel.trim()) {
                          createLabel.mutate({ projectId: card.projectId, name: newLabel.trim(), color: LABEL_COLORS[board.labels.length % LABEL_COLORS.length]! });
                          setNewLabel("");
                        }
                      }} />
                    </div>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : card.labelIds.length === 0 ? (
              <span className="text-fg-subtle">None</span>
            ) : null}
          </div>
        </Row>
        <Row label="Layout">
          <Select
            aria-label="Card layout"
            value={card.displayMode ?? "DEFAULT"}
            disabled={!perms.canEdit}
            onValueChange={(v) => update.mutate({ cardId: card.id, displayMode: v === "DEFAULT" ? null : (v as "VISUAL" | "COMPACT") })}
            options={[
              { value: "DEFAULT", label: "Column default" },
              { value: "VISUAL", label: "Visual (media first)" },
              { value: "COMPACT", label: "Compact" },
            ]}
            className="h-7"
          />
        </Row>
        <Row label="Cover">
          <CoverControl />
        </Row>
        <Row label="Estimate">
          {perms.canEdit ? (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                step={0.5}
                aria-label="Estimated hours"
                defaultValue={card.estimateHours ?? ""}
                key={card.estimateHours ?? "none"}
                onBlur={(e) => {
                  const value = e.target.value === "" ? null : Number(e.target.value);
                  if (value !== card.estimateHours) update.mutate({ cardId: card.id, estimateHours: value });
                }}
                className="h-7 w-20 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none focus:border-accent"
              />
              <span className="text-[12px] text-fg-subtle">hours</span>
            </div>
          ) : (
            <span className="text-fg-subtle">{card.estimateHours != null ? `${card.estimateHours} h` : "None"}</span>
          )}
        </Row>
        <Row label="Links">
          <LinksEditor links={card.links} canEdit={perms.canEdit} onChange={(links) => update.mutate({ cardId: card.id, links })} />
        </Row>
        <Row label="Watchers">
          <div className="flex items-center gap-2">
            <AvatarStack users={card.watcherIds.map((id) => membersById.get(id)).filter((m): m is MemberDTO => Boolean(m))} max={5} />
            <Button size="xs" variant="ghost" onClick={() => watch.mutate({ cardId: card.id, watching: !watching })}>
              {watching ? <BellOff /> : <Bell />} {watching ? "Unwatch" : "Watch"}
            </Button>
          </div>
        </Row>
      </section>

      <section className="grid gap-1 px-1 text-[12px] text-fg-subtle">
        <p className="flex items-center gap-1.5">
          Created by {creator ? <UserAvatar user={creator} size="xs" /> : null} {creator?.displayName ?? "someone"} · {formatDateTime(card.createdAt)}
        </p>
        <p>Updated {timeAgo(card.updatedAt)}</p>
      </section>

      <section className="grid gap-1">
        <Button variant="ghost" size="sm" className="justify-start" onClick={copyLink}>
          <Link2 /> Copy link
        </Button>
        {can("card.create") ? (
          <Button variant="ghost" size="sm" className="justify-start" loading={duplicate.isPending} onClick={() => duplicate.mutate({ cardId: card.id, include: { assignees: true, labels: true, checklists: true, attachments: true } })}>
            <Copy /> Duplicate card
          </Button>
        ) : null}
        {perms.canArchive || card.archivedAt ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            disabled={!perms.canArchive && !card.archivedAt}
            loading={archive.isPending}
            onClick={() =>
              archive.mutate(
                { cardId: card.id, archived: !card.archivedAt },
                { onSuccess: () => toast.success(card.archivedAt ? "Card restored to the board." : "Card archived. Restore it any time from Archived items.") },
              )
            }
          >
            {card.archivedAt ? <ArchiveRestore /> : <Archive />} {card.archivedAt ? "Restore card" : "Archive card"}
          </Button>
        ) : null}
        {card.archivedAt && perms.canDelete ? (
          <Button variant="danger-ghost" size="sm" className="justify-start" onClick={() => setDeleteOpen(true)}>
            <Trash2 /> Delete permanently
          </Button>
        ) : null}
      </section>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete card permanently?"
        destructive
        confirmLabel="Delete forever"
        loading={remove.isPending}
        confirmDisabled={confirmKey.trim().toUpperCase() !== card.key.toUpperCase()}
        onConfirm={() => remove.mutate({ cardId: card.id, confirm: confirmKey })}
        description={
          <>
            All versions, media, feedback and history of <strong>{card.title}</strong> will be removed. Type <strong className="font-mono">{card.key}</strong> to confirm.
          </>
        }
      >
        <Input className="mt-3 font-mono" value={confirmKey} onChange={(e) => setConfirmKey(e.target.value)} placeholder={card.key} aria-label="Type the card key to confirm" />
      </ConfirmDialog>
    </aside>
  );
}
