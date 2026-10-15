"use client";

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Folder, Layers, List, Lock, MessageSquareWarning, Network, Plus, Share2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { folderSummary, folderTree, type FolderTreeNode } from "@/lib/canvas-folders";
import { useCardMutation } from "@/lib/queries";
import { rpc, errorMessage } from "@/lib/rpc-client";
import type { CanvasLinkDTO, DeliverableDTO, DeliverableGroupDTO, DeliverableLinkType } from "@/lib/types";
import { roleHas } from "@/lib/permissions";
import { cn, formatShortDate } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queries";
import { CreatorMark } from "../domain/creator-mark";
import { PersonPicker } from "../domain/people-menu";
import { recentPeopleKey } from "@/lib/recent-people";
import { DeliverableProgress, KIND_ICONS } from "../domain/production";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";
import { TipAnchor, useTutorial } from "../tutorial/tutorial";
import { useUploads } from "../upload/upload-manager";
import { DescriptionTextarea, pendingToken, type ImageSource } from "./description-images";
import { imageToken, PENDING_TOKEN, plainDescription } from "@/lib/description-images";
import { Tooltip } from "../ui/menu";
import { AddLinkButton, LinkedFrom, LinkRow, sharedWith } from "./card-links";
import type { CanvasActions } from "./deliverable-canvas";
import { DeliverableWork } from "./deliverable-work";
import { useCollapsedFolders } from "./folder-view";
import { useWorkspace } from "./workspace-context";

const DeliverableCanvas = dynamic(() => import("./deliverable-canvas"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[13px] text-fg-muted">Loading canvas…</div>,
});

const VIEW_KEY = "forge:deliverable-view";
const TYPE_SUGGESTIONS = ["Model", "Rig", "Animation", "VFX", "Audio", "Texture", "UI", "Map", "Script", "Other"];

/** Types to suggest for a deliverable: the ones this card already uses, then common ones. */
export function useDeliverableTypes() {
  const { deliverables } = useWorkspace();
  return useMemo(() => [...new Set([...deliverables.map((d) => d.assetType).filter(Boolean), ...TYPE_SUGGESTIONS])], [deliverables]);
}

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
  // Prerequisites (each must be approved before the new one is unblocked); a "requires this" opener starts with it ticked.
  const [requires, setRequires] = useState<string[]>([]);
  const startWith = linkFrom?.type === "DEPENDENCY" ? linkFrom.id : null;
  useEffect(() => {
    if (open) setRequires(startWith ? [startWith] : []);
  }, [open, startWith]);
  const [description, setDescription] = useState("");
  // Images added before the deliverable exists are stored right after it's created.
  const [pendingImages, setPendingImages] = useState<ImageSource[]>([]);
  const uploads = useUploads();
  const queryClient = useQueryClient();
  const create = useCardMutation("deliverable.create", card.id, card.projectId);
  const types = useDeliverableTypes();
  const canAssign = card.permissions.canAssign;
  const reset = () => {
    setName("");
    setAssetType("");
    setRequired(true);
    setOwnerId("none");
    setReviewerId("none");
    setDueAt("");
    setDescription("");
    setPendingImages([]);
  };
  /** Stores the images added while writing, then puts them in the new deliverable's description where they were. */
  const attachImages = (deliverableId: string, text: string, sources: ImageSource[]) => {
    const target = { id: card.id, projectId: card.projectId, title: card.title, deliverableId, label: name.trim() };
    void Promise.all(
      sources.map((s) =>
        (s.file ? uploads.uploadOne(target, s.file, "description") : rpc("upload.importUrl", { cardId: card.id, url: s.url!, purpose: "description", deliverableId }))
          .then((a) => ({ s, token: imageToken(a.filename || s.name, a.id) }))
          .catch((error) => {
            toast.error(`Couldn't add ${s.name}: ${errorMessage(error)}`);
            return { s, token: s.url ?? "" };
          }),
      ),
    ).then(async (done) => {
      let final = text;
      for (const { s, token } of done) final = final.replace(pendingToken(s), token);
      await rpc("deliverable.update", { deliverableId, description: final.trim() }).catch((error) => toast.error(errorMessage(error)));
      void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
    });
  };
  const submit = async (openAfter: boolean) => {
    if (!name.trim()) return;
    const last = deliverables.at(-1);
    const images = pendingImages.filter((s) => description.includes(pendingToken(s)));
    try {
      const detail = await create.mutateAsync({
        cardId: card.id,
        name: name.trim(),
        assetType: assetType.trim() || undefined,
        required,
        description: description.replace(PENDING_TOKEN, "").trim() || undefined,
        ownerId: ownerId === "none" ? null : ownerId,
        reviewerId: reviewerId === "none" ? null : reviewerId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        canvasX: last ? last.canvasX + 300 : 0,
        canvasY: last ? last.canvasY : 0,
        requires,
        linkFrom: linkFrom && linkFrom.type !== "DEPENDENCY" ? linkFrom : null,
      });
      const created = detail.deliverables.find((d) => d.name === name.trim() && !deliverables.some((x) => x.id === d.id));
      if (created && images.length) attachImages(created.id, description, images);
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
              <PersonPicker
                label="Responsible"
                variant="field"
                className="h-8"
                canEdit
                value={ownerId === "none" ? null : ownerId}
                emptyLabel="Card assignees (inherited)"
                members={members.filter((m) => roleHas(m.role, "attachment.upload") && (canAssign || m.id === viewerId))}
                onChange={(id) => setOwnerId(id ?? "none")}
                recentKey={recentPeopleKey(card.projectId, `${card.columnId}:assignees`)}
              />
            </div>
            {canAssign ? (
              <div className="grid gap-1 text-[12px] font-medium text-fg-muted">
                Reviewer
                <PersonPicker
                  label="Reviewer"
                  variant="field"
                  className="h-8"
                  canEdit
                  value={reviewerId === "none" ? null : reviewerId}
                  emptyLabel="Card reviewers (inherited)"
                  members={members.filter((m) => roleHas(m.role, "card.review"))}
                  onChange={(id) => setReviewerId(id ?? "none")}
                  recentKey={recentPeopleKey(card.projectId, `${card.columnId}:reviewers`)}
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
              <span id="add-deliverable-requires">Requires (optional)</span>
              <div role="group" aria-labelledby="add-deliverable-requires" className="scrollbar-thin grid max-h-44 gap-0.5 overflow-y-auto rounded-lg border border-border-strong p-1">
                {deliverables.map((d) => (
                  <label key={d.id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] font-normal text-fg hover:bg-surface-3">
                    <Checkbox
                      checked={requires.includes(d.id)}
                      onCheckedChange={(checked) => setRequires((ids) => (checked === true ? [...ids, d.id] : ids.filter((id) => id !== d.id)))}
                    />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <StatePill state={d.state} size="sm" />
                  </label>
                ))}
              </div>
              <span className="text-[11px] font-normal text-fg-subtle">
                {requires.length ? `Blocked until ${requires.length === 1 ? "it's" : `all ${requires.length} are`} approved.` : "Nothing ticked: it can start right away."}
              </span>
            </div>
          ) : null}
          <DescriptionTextarea
            value={description}
            onChange={setDescription}
            onImages={(sources) => setPendingImages((list) => [...list, ...sources])}
            busy={0}
            placeholder="What does done look like? (optional — paste references or screenshots)"
            aria-label="Description"
            maxLength={5000}
          />
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

function DeliverableRow({ d, first, last, canEdit, onMove }: { d: DeliverableDTO; first: boolean; last: boolean; canEdit: boolean; onMove: (d: DeliverableDTO, dir: -1 | 1) => void }) {
  const { openDeliverable, deliverables, membersById, card } = useWorkspace();
  const shares = sharedWith(card.linkedFrom, d.id);
  const creator = d.createdById ? membersById.get(d.createdById) : undefined;
  const kind = d.kinds.find((k) => k !== "FILE") ?? d.kinds[0];
  const KindIcon = kind ? KIND_ICONS[kind] : Layers;
  const blockedNames = d.blockedBy.map((id) => deliverables.find((x) => x.id === id)?.name ?? "?");
  return (
    <li
      className="group flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-2.5 py-2 hover:border-border-strong"
      style={d.color ? { boxShadow: `inset 3px 0 0 ${d.color}` } : undefined}
    >
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
            {shares.length ? (
              <span className="inline-flex items-center gap-0.5" title={`Shared with ${shares.map((s) => s.card.key).join(", ")}`}>
                <Share2 className="size-3" /> shared with {shares.length === 1 ? shares[0]!.card.key : `${shares.length} cards`}
              </span>
            ) : null}
            <CreatorMark person={creator} />
          </span>
          {d.description.trim() ? <span className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11.5px] text-fg-muted">{plainDescription(d.description)}</span> : null}
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
          <button type="button" aria-label={`Move ${d.name} up`} disabled={first} onClick={() => onMove(d, -1)} className="flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-4 hover:text-fg disabled:opacity-30">
            <ArrowUp className="size-3.5" />
          </button>
          <button type="button" aria-label={`Move ${d.name} down`} disabled={last} onClick={() => onMove(d, 1)} className="flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-4 hover:text-fg disabled:opacity-30">
            <ArrowDown className="size-3.5" />
          </button>
        </span>
      ) : null}
    </li>
  );
}

/** A row of the list: a deliverable, or a link (listed after the deliverables of its folder). */
type ListItem = { id: string; groupId: string | null; position: number } & ({ kind: "deliverable"; deliverable: DeliverableDTO } | { kind: "link"; link: CanvasLinkDTO });
type TreeNode = FolderTreeNode<DeliverableGroupDTO, ListItem>;

/** Deliverables inside a tree node, in list order. */
function flatten(node: TreeNode): DeliverableDTO[] {
  return node.kind === "item" ? (node.item.kind === "deliverable" ? [node.item.deliverable] : []) : node.children.flatMap(flatten);
}

/** The list view's folders: a section per folder (collapsible here, independently of the canvas), nested like the canvas. */
function FolderSection({ node, canEdit, onMove }: { node: Extract<TreeNode, { kind: "folder" }>; canEdit: boolean; onMove: (d: DeliverableDTO, neighbour: TreeNode, dir: -1 | 1) => void }) {
  const { card } = useWorkspace();
  // The same open/closed view as the canvas: this person's own, open when the card opens.
  const [collapsed, setCollapsed] = useCollapsedFolders(card.id);
  const open = !collapsed.has(node.folder.id);
  const setOpen = (next: (open: boolean) => boolean) => setCollapsed(node.folder.id, !next(open));
  const inside = flatten(node);
  const linksInside = (function count(n: TreeNode): number {
    return n.kind === "item" ? Number(n.item.kind === "link") : n.children.reduce((sum, c) => sum + count(c), 0);
  })(node);
  return (
    <li className="rounded-lg border border-dashed border-border-strong/80 p-1.5" style={node.folder.color ? { borderColor: node.folder.color, backgroundColor: `color-mix(in oklab, ${node.folder.color} 6%, transparent)` } : undefined}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-3">
        {open ? <ChevronDown className="size-4 shrink-0 text-fg-subtle" /> : <ChevronRight className="size-4 shrink-0 text-fg-subtle" />}
        <Folder className="size-4 shrink-0" style={{ color: node.folder.color ?? "var(--fg-muted)" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{node.folder.name}</span>
        <span className="shrink-0 text-[11px] text-fg-muted">{folderSummary(inside.length, inside.map((d) => d.state), linksInside)}</span>
      </button>
      {open ? (
        <ul className="mt-1 grid gap-1.5 pl-2 sm:pl-4" aria-label={`Inside ${node.folder.name}`}>
          <ListTree nodes={node.children} canEdit={canEdit} onMove={onMove} />
        </ul>
      ) : null}
    </li>
  );
}

function ListTree({ nodes, canEdit, onMove }: { nodes: TreeNode[]; canEdit: boolean; onMove: (d: DeliverableDTO, neighbour: TreeNode, dir: -1 | 1) => void }) {
  return (
    <>
      {nodes.map((node, i) =>
        node.kind === "item" ? (
          node.item.kind === "link" ? (
            <LinkRow key={node.item.id} link={node.item.link} />
          ) : (
            <DeliverableRow
              key={node.item.id}
              d={node.item.deliverable}
              first={i === 0}
              // Links come after the deliverables: the last deliverable can't move past them.
              last={i === nodes.length - 1 || (nodes[i + 1]?.kind === "item" && (nodes[i + 1] as Extract<TreeNode, { kind: "item" }>).item.kind === "link")}
              canEdit={canEdit}
              onMove={(d, dir) => {
                const neighbour = nodes[i + dir];
                if (neighbour) onMove(d, neighbour, dir);
              }}
            />
          )
        ) : (
          <FolderSection key={node.folder.id} node={node} canEdit={canEdit} onMove={onMove} />
        ),
      )}
    </>
  );
}

/** Overview of a card's deliverables: a connected canvas or the same data as a list. */
export function DeliverablesPanel() {
  const { card, deliverables, openDeliverable } = useWorkspace();
  const queryClient = useQueryClient();
  const tutorial = useTutorial();
  const [view, setViewState] = useDeliverableView();
  const setView = (next: typeof view) => {
    setViewState(next);
    if (next === "canvas") tutorial.trigger("card.canvas");
  };
  const [adding, setAdding] = useState(false);
  const canEdit = card.permissions.canEdit;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
    void queryClient.invalidateQueries({ queryKey: qk.board(card.projectId) });
  };
  const link = useCardMutation("deliverable.link", card.id, card.projectId);
  const unlink = useCardMutation("deliverable.unlink", card.id, card.projectId);
  const updateLink = useCardMutation("deliverable.updateLink", card.id, card.projectId);
  const updateDeliverable = useCardMutation("deliverable.update", card.id, card.projectId);
  const archiveDeliverable = useCardMutation("deliverable.archive", card.id, card.projectId);
  const createGroup = useCardMutation("deliverable.group.create", card.id, card.projectId);
  const updateGroup = useCardMutation("deliverable.group.update", card.id, card.projectId);
  const ungroup = useCardMutation("deliverable.group.ungroup", card.id, card.projectId);
  const moveToGroup = useCardMutation("deliverable.group.move", card.id, card.projectId);
  const archived = card.deliverables.filter((d) => d.archivedAt);
  const folders = card.deliverableGroups;
  const tree = useMemo(() => {
    const last = deliverables.reduce((max, d) => Math.max(max, d.position), 0);
    const items: ListItem[] = [
      ...deliverables.map((d) => ({ kind: "deliverable" as const, id: d.id, groupId: d.groupId, position: d.position, deliverable: d })),
      ...card.canvasLinks.map((l, i) => ({ kind: "link" as const, id: l.id, groupId: l.groupId, position: last + 1 + i, link: l })),
    ];
    return folderTree(folders, items);
  }, [folders, deliverables, card.canvasLinks]);
  // A link added from the header is selected on the canvas once it arrives.
  const [focusLinkId, setFocusLinkId] = useState<string | null>(null);

  const actions: CanvasActions = {
    layout: (changes) =>
      rpc("deliverable.layout", { cardId: card.id, positions: changes })
        // A new size can move arrows whose point no longer exists: pick up those changes.
        .then(() => changes.some((c) => c.w !== undefined || c.h !== undefined) && refresh())
        .catch((error) => {
          toast.error(`Couldn't save the layout — ${errorMessage(error)}`);
          refresh();
        }),
    link: (input) =>
      link
        .mutateAsync({ cardId: card.id, ...input })
        .then(() => tutorial.trigger("card.canvas"))
        .catch(() => {}),
    unlink: (linkId) => unlink.mutate({ linkId }),
    reverse: (linkId) => updateLink.mutate({ linkId, reverse: true }),
    setPoints: (linkId, points) => updateLink.mutate({ linkId, ...points }),
    rename: (deliverableId, name) => updateDeliverable.mutate({ deliverableId, name }),
    archive: (deliverableId, archived) => archiveDeliverable.mutateAsync({ deliverableId, archived }),
    createFolder: (input) =>
      createGroup.mutateAsync({ cardId: card.id, ...input }).then((detail) => {
        tutorial.trigger("card.folders");
        return detail;
      }),
    updateFolder: (groupId, patch) => updateGroup.mutateAsync({ groupId, ...patch }),
    // Collapsing is each person's own view: nothing to save, just the tip on first use.
    toggleFolder: () => tutorial.trigger("card.folders"),
    ungroup: (groupId) => ungroup.mutateAsync({ groupId }),
    moveToFolder: (input) => moveToGroup.mutateAsync({ cardId: card.id, ...input }),
  };

  // List order moves past the neighbour in the list — a whole folder when that's what's next.
  const onMove = (d: DeliverableDTO, neighbour: TreeNode, dir: -1 | 1) => {
    const inside = flatten(neighbour);
    const edge = dir === -1 ? inside[0] : inside.at(-1);
    if (!edge) return;
    rpc("deliverable.move", dir === -1 ? { deliverableId: d.id, beforeId: edge.id } : { deliverableId: d.id, afterId: edge.id })
      .then(refresh)
      .catch((error) => toast.error(errorMessage(error)));
  };

  return (
    <section id="deliverables" aria-label="Deliverables" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <TipAnchor tip="card.deliverables" facts={{ deliverableCount: deliverables.length }}>
          <h3 className="text-[14px] font-semibold">Deliverables</h3>
        </TipAnchor>
        <span className="rounded-full bg-surface-4 px-1.5 text-[11px] font-medium text-fg-muted">{deliverables.length}</span>
        <DeliverableProgress progress={card.progress} className="min-w-40 flex-1" detailed />
        <TipAnchor tip="card.folders" facts={{ canEdit, folderCount: folders.length }}>
        <TipAnchor tip="card.canvas" facts={{ deliverableCount: deliverables.length }}>
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
        </TipAnchor>
        </TipAnchor>
        {canEdit ? (
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <Plus /> Add deliverable
            </Button>
            <AddLinkButton onLinked={(l) => setFocusLinkId(l.id)} />
          </span>
        ) : null}
      </div>

      {view === "canvas" ? (
        <div className="h-[min(62vh,560px)] min-h-[340px] overflow-hidden rounded-xl border border-border bg-surface-2/40">
          <DeliverableCanvas deliverables={deliverables} folders={folders} links={card.deliverableLinks} canvasLinks={card.canvasLinks} canEdit={canEdit} actions={actions} onOpen={openDeliverable} focusLinkId={focusLinkId} />
        </div>
      ) : (
        <ul className="grid gap-1.5" aria-label="Deliverables list">
          <ListTree nodes={tree} canEdit={canEdit} onMove={onMove} />
        </ul>
      )}
      <LinkedFrom />
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
