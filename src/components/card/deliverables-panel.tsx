"use client";

import { ArrowDown, ArrowUp, ChevronRight, Layers, List, Lock, MessageSquareWarning, Network, Plus } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useCardMutation } from "@/lib/queries";
import { rpc, errorMessage } from "@/lib/rpc-client";
import type { DeliverableDTO, DeliverableLinkType } from "@/lib/types";
import { roleHas } from "@/lib/permissions";
import { cn, formatShortDate } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queries";
import { UserAvatar } from "../domain/avatar";
import { DeliverableProgress, KIND_ICONS } from "../domain/production";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Checkbox, Select } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import { Tooltip } from "../ui/menu";
import type { CanvasActions } from "./deliverable-canvas";
import { DeliverableWork } from "./deliverable-work";
import { useWorkspace } from "./workspace-context";

const DeliverableCanvas = dynamic(() => import("./deliverable-canvas"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[13px] text-fg-muted">Loading canvas…</div>,
});

const VIEW_KEY = "forge:deliverable-view";
const TYPE_SUGGESTIONS = ["Model", "Rig", "Animation", "VFX", "Audio", "Texture", "UI", "Map", "Script", "Other"];

/** Where the overview shows deliverables — remembered per browser. */
function useDeliverableView() {
  const [view, setView] = useState<"canvas" | "list">(() => {
    try {
      return (localStorage.getItem(VIEW_KEY) as "canvas" | "list" | null) ?? "canvas";
    } catch {
      return "canvas";
    }
  });
  return [
    view,
    (v: "canvas" | "list") => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        // not persisted
      }
    },
  ] as const;
}

export function AddDeliverableDialog({ open, onOpenChange, linkFrom }: { open: boolean; onOpenChange: (open: boolean) => void; linkFrom?: { id: string; type: DeliverableLinkType } | null }) {
  const { card, members, deliverables, viewerId, openDeliverable } = useWorkspace();
  const [name, setName] = useState("");
  const [assetType, setAssetType] = useState("");
  const [required, setRequired] = useState(true);
  const [ownerId, setOwnerId] = useState<string>("none");
  const [reviewerId, setReviewerId] = useState<string>("none");
  const [dueAt, setDueAt] = useState("");
  const [dependsOn, setDependsOn] = useState<string>(linkFrom?.id ?? "none");
  const [description, setDescription] = useState("");
  const create = useCardMutation("deliverable.create", card.id, card.projectId);
  const types = useMemo(() => [...new Set([...deliverables.map((d) => d.assetType).filter(Boolean), ...TYPE_SUGGESTIONS])], [deliverables]);
  const canAssign = card.permissions.canAssign;
  const reset = () => {
    setName("");
    setAssetType("");
    setRequired(true);
    setOwnerId("none");
    setReviewerId("none");
    setDueAt("");
    setDescription("");
  };
  const submit = async (openAfter: boolean) => {
    if (!name.trim()) return;
    const last = deliverables.at(-1);
    try {
      const detail = await create.mutateAsync({
        cardId: card.id,
        name: name.trim(),
        assetType: assetType.trim() || undefined,
        required,
        description: description.trim() || undefined,
        ownerId: ownerId === "none" ? null : ownerId,
        reviewerId: reviewerId === "none" ? null : reviewerId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        canvasX: last ? last.canvasX + 300 : 0,
        canvasY: last ? last.canvasY : 0,
        linkFrom: dependsOn !== "none" ? { id: dependsOn, type: linkFrom?.type ?? "DEPENDENCY" } : null,
      });
      const created = detail.deliverables.find((d) => d.name === name.trim() && !deliverables.some((x) => x.id === d.id));
      onOpenChange(false);
      reset();
      toast.success(`Added ${name.trim()}.`);
      if (openAfter && created) openDeliverable(created.id);
      // A simple card just became a multi-deliverable one: show the overview with both.
      else if (deliverables.length === 1) openDeliverable(null);
    } catch {
      // toast shown by the mutation
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a deliverable" description="A piece of work with its own files, revisions and review — no fixed template.">
        <div className="grid gap-3">
          <label className="grid gap-1 text-[12px] font-medium text-fg-muted">
            Name
            <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ultimate animation, Impact SFX, Weapon model" onKeyDown={(e) => e.key === "Enter" && void submit(false)} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[12px] font-medium text-fg-muted">
              Type
              <Input list="deliverable-types" value={assetType} maxLength={40} onChange={(e) => setAssetType(e.target.value)} placeholder="Any label" />
              <datalist id="deliverable-types">
                {types.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <div className="grid gap-1 text-[12px] font-medium text-fg-muted">
              Responsible
              <Select
                aria-label="Responsible"
                value={ownerId}
                onValueChange={setOwnerId}
                options={[
                  { value: "none", label: "Card assignees (inherited)" },
                  ...members.filter((m) => roleHas(m.role, "attachment.upload") && (canAssign || m.id === viewerId)).map((m) => ({ value: m.id, label: m.displayName })),
                ]}
              />
            </div>
            {canAssign ? (
              <div className="grid gap-1 text-[12px] font-medium text-fg-muted">
                Reviewer
                <Select
                  aria-label="Reviewer"
                  value={reviewerId}
                  onValueChange={setReviewerId}
                  options={[{ value: "none", label: "Card reviewers (inherited)" }, ...members.filter((m) => roleHas(m.role, "card.review")).map((m) => ({ value: m.id, label: m.displayName }))]}
                />
              </div>
            ) : null}
            {card.permissions.canEdit ? (
              <label className="grid gap-1 text-[12px] font-medium text-fg-muted">
                Due (optional)
                <input
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="h-8 min-w-0 rounded-md border border-border-strong/70 bg-surface-3/60 px-2.5 text-sm text-fg outline-none focus:border-accent [color-scheme:dark] light:[color-scheme:light]"
                />
                <span className="text-[11px] font-normal text-fg-subtle">Empty: it follows the card&apos;s deadline.</span>
              </label>
            ) : null}
          </div>
          {deliverables.length ? (
            <div className="grid gap-1 text-[12px] font-medium text-fg-muted">
              Requires (optional)
              <Select
                aria-label="Requires"
                value={dependsOn}
                onValueChange={setDependsOn}
                options={[{ value: "none", label: "Nothing" }, ...deliverables.map((d) => ({ value: d.id, label: d.name }))]}
              />
            </div>
          ) : null}
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does done look like? (optional)" maxLength={5000} />
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={required} onCheckedChange={(v) => setRequired(v === true)} /> Required to complete the card
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={!name.trim()} loading={create.isPending} onClick={() => void submit(false)}>
            Add
          </Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => void submit(true)}>
            Add & open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliverableRow({ d, index, total, canEdit, onMove }: { d: DeliverableDTO; index: number; total: number; canEdit: boolean; onMove: (d: DeliverableDTO, dir: -1 | 1) => void }) {
  const { openDeliverable, deliverables } = useWorkspace();
  const kind = d.kinds.find((k) => k !== "FILE") ?? d.kinds[0];
  const KindIcon = kind ? KIND_ICONS[kind] : Layers;
  const blockedNames = d.blockedBy.map((id) => deliverables.find((x) => x.id === id)?.name ?? "?");
  return (
    <li className="group flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-2.5 py-2 hover:border-border-strong">
      <button type="button" onClick={() => openDeliverable(d.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-label={`Open ${d.name}`}>
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-4">
          {d.cover?.thumbUrl ? <img src={d.cover.thumbUrl} alt="" className="h-full w-full object-cover" /> : <KindIcon className="size-4 text-fg-subtle" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{d.name}</span>
            {!d.required ? <span className="rounded bg-surface-4 px-1 text-[10px] text-fg-muted">optional</span> : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-fg-muted">
            <span>{d.assetType || "Deliverable"}</span>
            <span>{d.versionCount ? `V${d.versionCount}` : "no files"}</span>
            {blockedNames.length ? (
              <span className="inline-flex items-center gap-0.5 text-state-review">
                <Lock className="size-3" /> waiting on {blockedNames.join(", ")}
              </span>
            ) : null}
          </span>
          {d.description.trim() ? <span className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11.5px] text-fg-muted">{d.description}</span> : null}
          <DeliverableWork d={d} className="mt-0.5" />
        </span>
        {d.openFeedback ? (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-state-changes" title={`${d.openFeedback} open feedback`}>
            <MessageSquareWarning className="size-3.5" /> {d.openFeedback}
          </span>
        ) : null}
        <StatePill state={d.state} size="sm" />
        <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
      </button>
      {canEdit ? (
        // Always visible (no hover on touch screens); dragging isn't needed to reorder.
        <span className="flex flex-col">
          <button type="button" aria-label={`Move ${d.name} up`} disabled={index === 0} onClick={() => onMove(d, -1)} className="flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-4 hover:text-fg disabled:opacity-30">
            <ArrowUp className="size-3.5" />
          </button>
          <button type="button" aria-label={`Move ${d.name} down`} disabled={index === total - 1} onClick={() => onMove(d, 1)} className="flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-4 hover:text-fg disabled:opacity-30">
            <ArrowDown className="size-3.5" />
          </button>
        </span>
      ) : null}
    </li>
  );
}

/** Overview of a card's deliverables: a connected canvas or the same data as a list. */
export function DeliverablesPanel() {
  const { card, deliverables, openDeliverable } = useWorkspace();
  const queryClient = useQueryClient();
  const [view, setView] = useDeliverableView();
  const [adding, setAdding] = useState(false);
  const canEdit = card.permissions.canEdit;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
    void queryClient.invalidateQueries({ queryKey: qk.board(card.projectId) });
  };
  const link = useCardMutation("deliverable.link", card.id, card.projectId);
  const unlink = useCardMutation("deliverable.unlink", card.id, card.projectId);
  const updateLink = useCardMutation("deliverable.updateLink", card.id, card.projectId);
  const archived = card.deliverables.filter((d) => d.archivedAt);

  const actions: CanvasActions = {
    layout: (changes) =>
      rpc("deliverable.layout", { cardId: card.id, positions: changes })
        // A new size can move arrows whose point no longer exists: pick up those changes.
        .then(() => changes.some((c) => c.w !== undefined || c.h !== undefined) && refresh())
        .catch((error) => {
          toast.error(`Couldn't save the layout — ${errorMessage(error)}`);
          refresh();
        }),
    link: (input) => link.mutateAsync({ cardId: card.id, ...input }).catch(() => {}),
    unlink: (linkId) => unlink.mutate({ linkId }),
    reverse: (linkId) => updateLink.mutate({ linkId, reverse: true }),
    setPoints: (linkId, points) => updateLink.mutate({ linkId, ...points }),
  };

  const onMove = (d: DeliverableDTO, dir: -1 | 1) => {
    const i = deliverables.findIndex((x) => x.id === d.id);
    const neighbour = deliverables[i + dir];
    if (!neighbour) return;
    rpc("deliverable.move", dir === -1 ? { deliverableId: d.id, beforeId: neighbour.id } : { deliverableId: d.id, afterId: neighbour.id })
      .then(refresh)
      .catch((error) => toast.error(errorMessage(error)));
  };

  return (
    <section id="deliverables" aria-label="Deliverables" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">Deliverables</h3>
        <span className="rounded-full bg-surface-4 px-1.5 text-[11px] font-medium text-fg-muted">{deliverables.length}</span>
        <DeliverableProgress progress={card.progress} className="min-w-40 flex-1" detailed />
        <div role="radiogroup" aria-label="Deliverable view" className="flex h-7 items-center rounded-md border border-border-strong bg-surface-3/60 p-0.5">
          {(
            [
              ["canvas", "Canvas", <Network key="c" />],
              ["list", "List", <List key="l" />],
            ] as const
          ).map(([v, label, icon]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => setView(v)}
              className={cn("inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] font-medium [&_svg]:size-3.5", view === v ? "bg-surface-4 text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
            >
              {icon} {label}
            </button>
          ))}
        </div>
        {canEdit ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus /> Add deliverable
          </Button>
        ) : null}
      </div>

      {view === "canvas" ? (
        <div className="h-[min(62vh,560px)] min-h-[340px] overflow-hidden rounded-xl border border-border bg-surface-2/40">
          <DeliverableCanvas deliverables={deliverables} links={card.deliverableLinks} canEdit={canEdit} actions={actions} onOpen={openDeliverable} />
        </div>
      ) : (
        <ul className="grid gap-1.5" aria-label="Deliverables list">
          {deliverables.map((d, i) => (
            <DeliverableRow key={d.id} d={d} index={i} total={deliverables.length} canEdit={canEdit} onMove={onMove} />
          ))}
        </ul>
      )}
      {archived.length ? (
        <details className="text-[12px] text-fg-muted">
          <summary className="cursor-pointer">Archived deliverables ({archived.length}) — history is kept</summary>
          <ul className="mt-1 grid gap-1">
            {archived.map((d) => (
              <ArchivedRow key={d.id} d={d} />
            ))}
          </ul>
        </details>
      ) : null}
      <AddDeliverableDialog open={adding} onOpenChange={setAdding} />
    </section>
  );
}

function ArchivedRow({ d }: { d: DeliverableDTO }) {
  const { card } = useWorkspace();
  const restore = useCardMutation("deliverable.archive", card.id, card.projectId);
  return (
    <li className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-2 py-1">
      <span className="flex-1 truncate">
        {d.name} · {d.versionCount} revision{d.versionCount === 1 ? "" : "s"}
      </span>
      {card.permissions.canEdit ? (
        <Tooltip content="Put it back on the card">
          <Button size="xs" variant="ghost" loading={restore.isPending} onClick={() => restore.mutate({ deliverableId: d.id, archived: false })}>
            Restore
          </Button>
        </Tooltip>
      ) : null}
    </li>
  );
}
