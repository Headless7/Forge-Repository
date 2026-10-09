"use client";

import { format } from "date-fns";
import { Archive, ArrowLeft, ChevronLeft, ChevronRight, Ellipsis, Link2, Lock, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { CARD_STATE_META } from "@/lib/card-meta";
import { roleHas } from "@/lib/permissions";
import { useCardMutation } from "@/lib/queries";
import type { DeliverableDTO, MemberDTO } from "@/lib/types";
import { cn, toLocalInput } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Checkbox, Select } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../ui/menu";
import { AddDeliverableDialog } from "./deliverables-panel";
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
function ContributorsPicker({ d, members, viewerId, canAssign, canSelfAssign, onChange }: {
  d: DeliverableDTO;
  members: MemberDTO[];
  viewerId: string;
  canAssign: boolean;
  canSelfAssign: boolean;
  onChange: (ids: string[]) => void;
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
      <PopoverContent align="start" className="w-64 max-h-[min(20rem,var(--radix-popover-content-available-height))] p-1">
        <p className="px-2 py-1.5 text-[11px] text-fg-subtle">They can upload, submit and resolve feedback on this deliverable only.</p>
        <ul>
          {workers.map((m) => {
            const mayToggle = canAssign || m.id === viewerId;
            return (
              <li key={m.id}>
                <label className={cn("flex min-h-9 items-center gap-2 rounded-md px-2 text-[13px]", mayToggle ? "cursor-pointer hover:bg-surface-4" : "opacity-50")}>
                  <Checkbox checked={d.contributorIds.includes(m.id)} disabled={!mayToggle} onCheckedChange={() => toggle(m.id)} aria-label={m.displayName} />
                  <UserAvatar user={m} size="xs" />
                  <span className="truncate">{m.displayName}</span>
                </label>
              </li>
            );
          })}
        </ul>
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

/** Name, type, requirement, people, due date, description and relationships of the focused deliverable. */
export function DeliverableHeader() {
  const { card, scope, members, deliverables, viewerId, openDeliverable } = useScope();
  const d = scope.deliverable;
  const perms = d.permissions;
  const update = useCardMutation("deliverable.update", card.id, card.projectId);
  const archive = useCardMutation("deliverable.archive", card.id, card.projectId, { onSuccess: () => openDeliverable(null) });
  const [name, setName] = useState(d.name);
  const [description, setDescription] = useState(d.description);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [addDependent, setAddDependent] = useState(false);
  useEffect(() => setName(d.name), [d.name]);
  useEffect(() => setDescription(d.description), [d.description]);

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
        <label className="grid gap-0.5">
          <span className="text-[11px] text-fg-subtle">Type</span>
          <Input
            key={d.assetType}
            defaultValue={d.assetType}
            disabled={!perms.canEdit}
            maxLength={40}
            placeholder="e.g. Animation"
            aria-label="Deliverable type"
            className="h-7 text-[12.5px]"
            onBlur={(e) => e.target.value.trim() !== d.assetType && update.mutate({ deliverableId: d.id, assetType: e.target.value.trim() })}
          />
        </label>
        <div className="grid gap-0.5">
          <span className="text-[11px] text-fg-subtle">Responsible</span>
          <Select
            aria-label="Responsible"
            value={d.ownerId ?? "none"}
            disabled={!(canAssign || card.permissions.canSelfAssign)}
            onValueChange={(v) => update.mutate({ deliverableId: d.id, ownerId: v === "none" ? null : v })}
            options={[
              { value: "none", label: inheritsPeople ? "Card assignees (inherited)" : "No one" },
              ...members
                .filter((m) => (roleHas(m.role, "attachment.upload") && (canAssign || m.id === viewerId)) || m.id === d.ownerId)
                .map((m) => ({ value: m.id, label: m.displayName, icon: <UserAvatar user={m} size="xs" /> })),
            ]}
            className="h-7"
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
          />
        </div>
        <div className="grid gap-0.5">
          <span className="text-[11px] text-fg-subtle">Reviewer</span>
          <Select
            aria-label="Reviewer"
            value={d.reviewerId ?? "none"}
            disabled={!canAssign}
            onValueChange={(v) => update.mutate({ deliverableId: d.id, reviewerId: v === "none" ? null : v })}
            options={[
              { value: "none", label: "Card reviewers (inherited)" },
              ...members.filter((m) => roleHas(m.role, "card.review") || m.id === d.reviewerId).map((m) => ({ value: m.id, label: m.displayName, icon: <UserAvatar user={m} size="xs" /> })),
            ]}
            className="h-7"
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
      </div>

      {perms.canEdit || d.description ? (
        <Textarea
          value={description}
          disabled={!perms.canEdit}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== d.description && update.mutate({ deliverableId: d.id, description })}
          placeholder="What does done look like for this deliverable?"
          aria-label="Deliverable description"
          className="min-h-14 text-[13px]"
        />
      ) : null}

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
