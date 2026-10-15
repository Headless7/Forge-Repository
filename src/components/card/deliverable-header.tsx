"use client";

import { format } from "date-fns";
import { Archive, ArrowLeft, ChevronLeft, ChevronRight, Ellipsis, Link2, Lock, Pencil, Plus, Users } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { CARD_STATE_META } from "@/lib/card-meta";
import { roleHas } from "@/lib/permissions";
import { useCardMutation } from "@/lib/queries";
import type { DeliverableDTO, MemberDTO } from "@/lib/types";
import { cn, toLocalInput } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { PeopleMenu, PersonPicker } from "../domain/people-menu";
import { recentPeopleKey } from "@/lib/recent-people";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { RichText } from "../comments/rich-text";
import { Input } from "../ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/menu";
import { DeliverableCoverControl } from "./cover-control";
import { SharedWithChips } from "./card-links";
import { DeliverableColorPicker } from "./deliverable-color";
import { DescriptionTextarea, releaseUnusedImages, useCoverFromDescription, useDescriptionImageUploads, useImageRenderer } from "./description-images";
import { AddDeliverableDialog, useDeliverableTypes } from "./deliverables-panel";
import { useScope, useWorkspace } from "./workspace-context";

/** Where you are: card › deliverable, with the way back to the card overview. */
export function DeliverableBreadcrumb() {
  const { card, scope, deliverables, openDeliverable } = useScope();
  const index = deliverables.findIndex((d) => d.id === scope.deliverable.id);
  const prev = deliverables[index - 1];
  const next = deliverables[index + 1];
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
      <Button size="xs" variant="ghost" onClick={() => openDeliverable(null)}>
        <ArrowLeft /> All deliverables
      </Button>
      <span className="text-fg-subtle">/</span>
      <button type="button" onClick={() => openDeliverable(null)} className="min-h-6 max-w-48 truncate text-fg-muted hover:text-fg">
        {card.title}
      </button>
      <span className="text-fg-subtle">/</span>
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="rounded bg-surface-4 px-1 font-mono text-[10.5px] text-fg-muted">D{scope.deliverable.number}</span>
        {scope.deliverable.name}
      </span>
      <span className="flex-1" />
      <span className="text-[11.5px] text-fg-subtle">
        {index + 1} of {deliverables.length}
      </span>
      <Tooltip content={prev ? `Previous: ${prev.name}` : "First deliverable"}>
        <Button size="icon-xs" variant="ghost" aria-label="Previous deliverable" disabled={!prev} onClick={() => prev && openDeliverable(prev.id)}>
          <ChevronLeft />
        </Button>
      </Tooltip>
      <Tooltip content={next ? `Next: ${next.name}` : "Last deliverable"}>
        <Button size="icon-xs" variant="ghost" aria-label="Next deliverable" disabled={!next} onClick={() => next && openDeliverable(next.id)}>
          <ChevronRight />
        </Button>
      </Tooltip>
    </nav>
  );
}

function formatDue(iso: string) {
  return format(new Date(iso), "EEE d MMM, HH:mm");
}

/**
 * People working on a deliverable alongside its responsible person. Managers pick anyone who can
 * work in the project; others can only add or remove themselves.
 */
function ContributorsPicker({ d, members, viewerId, canAssign, canSelfAssign, onChange, recentKey }: {
  d: DeliverableDTO;
  members: MemberDTO[];
  viewerId: string;
  canAssign: boolean;
  canSelfAssign: boolean;
  onChange: (ids: string[]) => void;
  recentKey?: string;
}) {
  const workers = members.filter((m) => roleHas(m.role, "attachment.upload") && m.id !== d.ownerId);
  const chosen = members.filter((m) => d.contributorIds.includes(m.id));
  const disabled = !(canAssign || canSelfAssign);
  const toggle = (id: string) => onChange(d.contributorIds.includes(id) ? d.contributorIds.filter((x) => x !== id) : [...d.contributorIds, id]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Contributors: ${chosen.length ? chosen.map((m) => m.displayName).join(", ") : "none"}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-left text-[12.5px] hover:border-border-strong disabled:opacity-60"
        >
          {chosen.length ? (
            <>
              <span className="flex -space-x-1.5">
                {chosen.slice(0, 3).map((m) => (
                  <UserAvatar key={m.id} user={m} size="xs" />
                ))}
              </span>
              <span className="truncate">{chosen.length === 1 ? chosen[0]!.displayName : `${chosen.length} people`}</span>
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-fg-subtle">
              <Users className="size-3.5" /> None
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-16px)] flex-col overflow-y-auto p-2" onOpenAutoFocus={(e) => window.matchMedia("(pointer: coarse)").matches && e.preventDefault()}>
        <PeopleMenu people={workers} selectedIds={d.contributorIds} label="Contributors" hint="They can upload, submit and resolve feedback on this deliverable only." canToggle={(m) => canAssign || m.id === viewerId} onToggle={(id) => toggle(id)} recentKey={recentKey} />
      </PopoverContent>
    </Popover>
  );
}

function RelationChip({ d, prefix }: { d: DeliverableDTO; prefix?: string }) {
  const { openDeliverable } = useWorkspace();
  return (
    <button
      type="button"
      onClick={() => openDeliverable(d.id)}
      className="inline-flex h-6 items-center gap-1 rounded-md border border-border-strong bg-surface-2 px-1.5 text-[11.5px] hover:border-accent"
      title={`${prefix ?? ""}${d.name} — ${CARD_STATE_META[d.state].label}`}
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: CARD_STATE_META[d.state].color }} />
      {d.name}
    </button>
  );
}

/**
 * The deliverable's description: what done looks like, with references and images. Read with its
 * images shown (any of them can become the cover); Edit opens the text with image paste and upload.
 */
function DeliverableDescription({ d }: { d: DeliverableDTO }) {
  const { card, mentionSet } = useWorkspace();
  const canEdit = d.permissions.canEdit;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.description);
  const images = useDescriptionImageUploads(useMemo(() => ({ id: card.id, projectId: card.projectId, title: card.title, deliverableId: d.id, label: d.name }), [card.id, card.projectId, card.title, d.id, d.name]), setDraft);
  const update = useCardMutation("deliverable.update", card.id, card.projectId, {
    onSuccess: () => {
      setEditing(false);
      images.uploaded.current.clear();
    },
  });
  const cover = useCoverFromDescription(card.id, card.projectId);
  const renderImage = useImageRenderer({
    attachments: card.attachments,
    coverId: d.coverMode === "MANUAL" ? (d.cover?.attachmentId ?? null) : null,
    canEdit: canEdit && !d.archivedAt,
    onUseAsCover: (id) => cover.forDeliverable(d.id, id),
  });
  const start = () => {
    setDraft(d.description);
    setEditing(true);
  };
  const cancel = () => {
    releaseUnusedImages(images.uploaded.current, d.description);
    setEditing(false);
  };
  const save = () => (draft !== d.description ? update.mutate({ deliverableId: d.id, description: draft }) : setEditing(false));

  if (editing) {
    return (
      <section aria-label="Edit the deliverable's description" className="grid gap-1.5">
        <DescriptionTextarea
          autoFocus
          autoGrow
          maxRows={20}
          value={draft}
          onChange={setDraft}
          onImages={images.start}
          busy={images.busy}
          maxLength={5000}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !images.busy) save();
            if (e.key === "Escape") cancel();
          }}
          placeholder="What does done look like? Paste references, links or screenshots."
          aria-label="Deliverable description"
          className="min-h-24 text-[13px]"
          footer={
            <span className="ml-auto flex items-center gap-1.5">
              <Button size="xs" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button size="xs" variant="primary" disabled={images.busy > 0} loading={update.isPending} onClick={save}>
                Save
              </Button>
            </span>
          }
        />
      </section>
    );
  }
  return (
    <section aria-label="Deliverable description" className="group">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-semibold text-fg-muted">Description</h3>
        {canEdit && d.description.trim() ? (
          <Button size="xs" variant="ghost" onClick={start}>
            <Pencil /> Edit
          </Button>
        ) : null}
      </div>
      {d.description.trim() ? (
        <RichText text={d.description} mentions={mentionSet} className="text-fg" renderImage={renderImage} />
      ) : (
        <button type="button" onClick={start} className="w-full rounded-lg border border-dashed border-border-strong px-3 py-2.5 text-left text-[13px] text-fg-subtle hover:border-fg-subtle hover:text-fg-muted">
          Add a description: what done looks like, references, images…
        </button>
      )}
    </section>
  );
}

/** Name, type, requirement, people, due date, description and relationships of the focused deliverable. */
export function DeliverableHeader() {
  const { card, scope, members, deliverables, viewerId, openDeliverable } = useScope();
  const d = scope.deliverable;
  const perms = d.permissions;
  const creator = d.createdById ? members.find((m) => m.id === d.createdById) : undefined;
  const update = useCardMutation("deliverable.update", card.id, card.projectId);
  const archive = useCardMutation("deliverable.archive", card.id, card.projectId, { onSuccess: () => openDeliverable(null) });
  const [name, setName] = useState(d.name);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [addDependent, setAddDependent] = useState(false);
  const types = useDeliverableTypes();
  const typesListId = useId();
  const saveType = (value: string) => value.trim() !== d.assetType && update.mutate({ deliverableId: d.id, assetType: value.trim() });
  useEffect(() => setName(d.name), [d.name]);

  const byId = new Map(deliverables.map((x) => [x.id, x]));
  const requires = card.deliverableLinks.filter((l) => l.type === "DEPENDENCY" && l.toId === d.id).map((l) => byId.get(l.fromId)).filter((x): x is DeliverableDTO => Boolean(x));
  const requiredBy = card.deliverableLinks.filter((l) => l.type === "DEPENDENCY" && l.fromId === d.id).map((l) => byId.get(l.toId)).filter((x): x is DeliverableDTO => Boolean(x));
  const related = card.deliverableLinks
    .filter((l) => l.type === "ASSOCIATION" && (l.fromId === d.id || l.toId === d.id))
    .map((l) => byId.get(l.fromId === d.id ? l.toId : l.fromId))
    .filter((x): x is DeliverableDTO => Boolean(x));
  const blocking = requires.filter((x) => x.state !== "APPROVED");
  const canAssign = card.permissions.canAssign;
  const inheritsPeople = !d.ownerId && d.contributorIds.length === 0;
  const overdue = (x: Pick<DeliverableDTO, "dueAt" | "state">) => Boolean(x.dueAt && x.state !== "APPROVED" && new Date(x.dueAt).getTime() < Date.now());

  return (
    <section aria-label="Deliverable" className="grid gap-2">
      <div className="flex items-start gap-2">
        {perms.canEdit ? (
          <Input
            value={name}
            maxLength={120}
            aria-label="Deliverable name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== d.name ? update.mutate({ deliverableId: d.id, name: name.trim() }) : setName(d.name)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="h-9 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-lg font-semibold hover:border-border-strong focus:bg-surface-3"
          />
        ) : (
          <h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{d.name}</h2>
        )}
        <StatePill state={d.state} size="md" />
        {perms.canEdit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Deliverable actions">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => setAddDependent(true)}>
                <Plus /> Add a deliverable that requires this
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setConfirmArchive(true)} disabled={deliverables.length <= 1}>
                <Archive /> Archive deliverable
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="grid gap-2 rounded-xl border border-border bg-surface-2 p-2.5 text-[12.5px] sm:grid-cols-2 xl:grid-cols-3">
        <div className="grid content-start gap-0.5">
          <span className="text-[11px] text-fg-subtle">Cover</span>
          <DeliverableCoverControl deliverable={d} />
        </div>
        <div className="grid content-start gap-0.5">
          <span className="text-[11px] text-fg-subtle">Colour</span>
          <DeliverableColorPicker deliverable={d} />
        </div>
        <label className="grid content-start gap-0.5">
          <span className="text-[11px] text-fg-subtle">Type</span>
          <Input
            key={d.assetType}
            defaultValue={d.assetType}
            disabled={!perms.canEdit}
            maxLength={40}
            placeholder="e.g. Animation"
            aria-label="Deliverable type"
            list={typesListId}
            className="h-7 text-[12.5px]"
            onBlur={(e) => saveType(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            // Picking a suggestion (not typing) saves straight away.
            onInput={(e) => {
              const inputType = (e.nativeEvent as InputEvent).inputType;
              if (inputType === undefined || inputType === "insertReplacementText") saveType(e.currentTarget.value);
            }}
          />
          <datalist id={typesListId}>
            {types.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <div className="grid gap-0.5">
          <span className="text-[11px] text-fg-subtle">Responsible</span>
          <PersonPicker
            label="Responsible"
            variant="field"
            value={d.ownerId}
            canEdit={canAssign || card.permissions.canSelfAssign}
            emptyLabel={inheritsPeople ? "Card assignees (inherited)" : "No one"}
            members={members.filter((m) => (roleHas(m.role, "attachment.upload") && (canAssign || m.id === viewerId)) || m.id === d.ownerId)}
            onChange={(ownerId) => update.mutate({ deliverableId: d.id, ownerId })}
            recentKey={recentPeopleKey(card.projectId, `${card.columnId}:assignees`)}
          />
        </div>
        <div className="grid gap-0.5">
          <span className="text-[11px] text-fg-subtle">Contributors</span>
          <ContributorsPicker
            d={d}
            members={members}
            viewerId={viewerId}
            canAssign={canAssign}
            canSelfAssign={card.permissions.canSelfAssign}
            onChange={(ids) => update.mutate({ deliverableId: d.id, contributorIds: ids })}
            recentKey={recentPeopleKey(card.projectId, `${card.columnId}:assignees`)}
          />
        </div>
        <div className="grid gap-0.5">
          <span className="text-[11px] text-fg-subtle">Reviewer</span>
          <PersonPicker
            label="Reviewer"
            variant="field"
            value={d.reviewerId}
            canEdit={canAssign}
            emptyLabel="Card reviewers (inherited)"
            members={members.filter((m) => roleHas(m.role, "card.review") || m.id === d.reviewerId)}
            onChange={(reviewerId) => update.mutate({ deliverableId: d.id, reviewerId })}
            recentKey={recentPeopleKey(card.projectId, `${card.columnId}:reviewers`)}
          />
        </div>
        <div className="grid gap-0.5">
          <label htmlFor={`due-${d.id}`} className="text-[11px] text-fg-subtle">
            Due
          </label>
          <input
            id={`due-${d.id}`}
            type="datetime-local"
            aria-label="Deliverable due date"
            aria-describedby={`due-note-${d.id}`}
            disabled={!perms.canEdit}
            value={toLocalInput(d.dueAt)}
            onChange={(e) => update.mutate({ deliverableId: d.id, dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            className={cn(
              "h-7 min-w-0 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none focus:border-accent disabled:opacity-60 [color-scheme:dark] light:[color-scheme:light]",
              d.dueAt && overdue(d) && "border-danger/60 text-danger",
            )}
          />
          <span id={`due-note-${d.id}`} className="flex flex-wrap items-center gap-1 text-[11px] text-fg-subtle">
            {d.dueAt ? (
              card.dueAt && perms.canEdit ? (
                <button type="button" className="inline-flex min-h-6 items-center text-accent hover:underline" onClick={() => update.mutate({ deliverableId: d.id, dueAt: null })}>
                  Use the card&apos;s deadline instead
                </button>
              ) : (
                "Its own deadline"
              )
            ) : card.dueAt ? (
              <span className={cn(overdue({ ...d, dueAt: card.dueAt }) && "text-danger")}>Inherits the card&apos;s deadline · {formatDue(card.dueAt)}</span>
            ) : (
              "No deadline"
            )}
          </span>
        </div>
        <div className="grid gap-0.5">
          <label htmlFor={`start-${d.id}`} className="text-[11px] text-fg-subtle">
            Start (optional)
          </label>
          <input
            id={`start-${d.id}`}
            type="datetime-local"
            aria-label="Deliverable start date"
            aria-describedby={`start-note-${d.id}`}
            disabled={!perms.canEdit}
            value={toLocalInput(d.startAt)}
            onChange={(e) => update.mutate({ deliverableId: d.id, startAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            className="h-7 min-w-0 rounded-md border border-border-strong/70 bg-surface-3/60 px-2 text-[12.5px] outline-none focus:border-accent disabled:opacity-60 [color-scheme:dark] light:[color-scheme:light]"
          />
          <span id={`start-note-${d.id}`} className="flex flex-wrap items-center gap-1 text-[11px] text-fg-subtle">
            {d.startAt ? (
              card.startAt && perms.canEdit ? (
                <button type="button" className="inline-flex min-h-6 items-center text-accent hover:underline" onClick={() => update.mutate({ deliverableId: d.id, startAt: null })}>
                  Use the card&apos;s start instead
                </button>
              ) : (
                "Its own start"
              )
            ) : card.startAt ? (
              <span>Follows the card&apos;s start · {formatDue(card.startAt)}</span>
            ) : (
              "No start date"
            )}
          </span>
        </div>
        <label className="flex items-center gap-2 sm:col-span-2 xl:col-span-3">
          <Checkbox checked={d.required} disabled={!perms.canEdit} onCheckedChange={(v) => update.mutate({ deliverableId: d.id, required: v === true })} />
          <span>Required to complete the card</span>
          {!d.required ? <span className="text-fg-subtle">— optional work doesn&apos;t block completion</span> : null}
        </label>
        <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-subtle sm:col-span-2 xl:col-span-3">
          Created by {creator ? <UserAvatar user={creator} size="xs" /> : null} <span className="truncate">{creator ? `@${creator.username}` : "Former member"}</span>
        </p>
      </div>

      <SharedWithChips deliverableId={d.id} />

      {perms.canEdit || d.description ? <DeliverableDescription d={d} /> : null}

      {requires.length || requiredBy.length || related.length ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {blocking.length ? (
            <span className="inline-flex items-center gap-1 font-semibold text-state-review">
              <Lock className="size-3.5" /> Waiting on
            </span>
          ) : requires.length ? (
            <span className="text-fg-muted">Requires</span>
          ) : null}
          {requires.map((x) => (
            <RelationChip key={x.id} d={x} prefix="Requires " />
          ))}
          {requiredBy.length ? <span className={cn("text-fg-muted", requires.length && "ml-2")}>Required by</span> : null}
          {requiredBy.map((x) => (
            <RelationChip key={x.id} d={x} prefix="Required by " />
          ))}
          {related.length ? (
            <span className={cn("inline-flex items-center gap-1 text-fg-muted", (requires.length || requiredBy.length) && "ml-2")}>
              <Link2 className="size-3.5" /> Related
            </span>
          ) : null}
          {related.map((x) => (
            <RelationChip key={x.id} d={x} />
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${d.name}?`}
        confirmLabel="Archive"
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ deliverableId: d.id, archived: true })}
        description="It leaves the card's progress and canvas. Its revisions, reviews and comments are kept, and you can restore it from the overview."
      />
      <AddDeliverableDialog open={addDependent} onOpenChange={setAddDependent} linkFrom={{ id: d.id, type: "DEPENDENCY" }} />
    </section>
  );
}
