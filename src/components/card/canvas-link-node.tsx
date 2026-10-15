"use client";

import type { Node, NodeProps } from "@xyflow/react";
import { Archive, ArrowRight, ArrowUpRight, FolderOutput, Link2, Share2, Trash2, X } from "lucide-react";
import { memo, type ReactNode } from "react";
import { LINK_NODE } from "@/lib/canvas-links";
import { CARD_STATE_META } from "@/lib/card-meta";
import type { CanvasLinkDTO, DeliverableGroupDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DeliverableProgress, ProductionPill } from "../domain/production";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { FolderBreadcrumb, GroupDropBadge, MoveToFolderSelect, NEW_FOLDER } from "./canvas-folders";
import { LinkFacts, NeededBadge, NeededToggle, whereLabel } from "./card-links";

/**
 * A link on the deliverable canvas: another card, or a deliverable shared from one, drawn as a
 * dashed card (it lives elsewhere) showing how that work stands right now. The ↗ button opens it
 * (double-click works too); selecting it shows its panel.
 */

export type LinkNodeData = {
  link: CanvasLinkDTO;
  boardId: string;
  selected: boolean;
  /** Something being dragged would be grouped with this one. */
  dropping: boolean;
  onOpen: (link: CanvasLinkDTO) => void;
};
export type LinkNode = Node<LinkNodeData, "link">;

export const LinkNodeView = memo(function LinkNodeView({ data }: NodeProps<LinkNode>) {
  const { link, onOpen } = data;
  const d = link.deliverable;
  const state = d ? d.state : link.card.state;
  const cover = d ? d.cover : link.card.cover;
  const archived = link.card.archived || Boolean(d?.archived);
  return (
    <div
      onDoubleClick={() => onOpen(link)}
      className={cn(
        "relative flex w-full flex-col rounded-lg border-2 border-dashed border-border-strong bg-surface-2 text-left shadow-md",
        data.selected && "outline outline-2 outline-accent",
        data.dropping && "ring-4 ring-accent/40",
        archived && "opacity-75",
      )}
      style={{ width: LINK_NODE.w, borderLeft: `3px solid ${CARD_STATE_META[state].color}`, ...(d?.color ? { borderTopColor: d.color } : {}) }}
    >
      <div className="flex items-center gap-1.5 border-b border-dashed border-border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle">
        {d ? <Share2 className="size-3 shrink-0" aria-hidden /> : <Link2 className="size-3 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{d ? `Shared from ${link.card.key}` : `Linked card ${link.card.key}`}</span>
        <button
          type="button"
          className="nodrag nopan touch-target -my-1 flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-4 hover:text-fg"
          aria-label={d ? `Open ${d.name} on ${link.card.key}` : `Open ${link.card.key}`}
          title="Open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(link);
          }}
        >
          <ArrowUpRight className="size-3.5" />
        </button>
      </div>
      <div className="flex gap-2 p-2">
        <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-4">
          {cover?.thumbUrl ? <img src={cover.thumbUrl} alt="" className="h-full w-full object-cover" draggable={false} /> : d ? <Share2 className="size-4 text-fg-subtle" /> : <Link2 className="size-4 text-fg-subtle" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold leading-tight" title={d ? d.name : link.card.title}>
            {d ? d.name : link.card.title}
          </p>
          <LinkFacts link={link} boardId={data.boardId} className="mt-0.5 text-[10.5px]" />
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <StatePill state={state} size="sm" />
            {link.needed ? <NeededBadge /> : null}
            {!d && link.card.productionStatus !== "TODO" ? <ProductionPill status={link.card.productionStatus} /> : null}
          </div>
        </div>
      </div>
      {!d && link.card.progress.total > 1 ? (
        <div className="border-t border-dashed border-border px-2 py-1">
          <DeliverableProgress progress={link.card.progress} />
        </div>
      ) : null}
      {data.dropping ? <GroupDropBadge /> : null}
    </div>
  );
});

const PANEL = "scrollbar-thin absolute bottom-3 right-3 z-10 max-h-[calc(100%-24px)] w-[min(320px,calc(100%-24px))] overflow-y-auto overscroll-contain rounded-lg border border-border-strong bg-surface-2 p-3 shadow-lg";

/**
 * The selected link: what it points at and how that stands, the way to open it, and for editors
 * its folder, "needed" (shared deliverables), sharing one of a linked card's deliverables here,
 * and removing the link.
 */
export function LinkPanel({
  link,
  boardId,
  canEdit,
  folders,
  folderMap,
  sharedIds,
  onOpen,
  onClose,
  onMove,
  onNewFolder,
  onShare,
  onRemove,
}: {
  link: CanvasLinkDTO;
  boardId: string;
  canEdit: boolean;
  folders: DeliverableGroupDTO[];
  folderMap: Map<string, DeliverableGroupDTO>;
  /** Deliverables already shared here (not offered again). */
  sharedIds: ReadonlySet<string>;
  onOpen: () => void;
  onClose: () => void;
  onMove: (target: string | null) => void;
  onNewFolder: () => void;
  onShare: (deliverable: CanvasLinkDTO["card"]["deliverables"][number]) => void;
  onRemove: () => void;
}) {
  const d = link.deliverable;
  const where = whereLabel(link, boardId);
  const shareable = d ? [] : link.card.deliverables.filter((x) => !sharedIds.has(x.id));
  const row = (children: ReactNode) => <div className="mt-2">{children}</div>;
  return (
    <div className={PANEL} role="dialog" aria-label={d ? "Shared deliverable" : "Linked card"}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle">
            {d ? <Share2 className="size-3" aria-hidden /> : <Link2 className="size-3" aria-hidden />}
            {d ? `Shared from ${link.card.key}` : `Linked card ${link.card.key}`}
          </p>
          <p className="break-words text-[13px] font-semibold">{d ? d.name : link.card.title}</p>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="touch-target -m-1 flex size-7 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg">
          <X className="size-4" />
        </button>
      </div>
      <p className="mt-0.5 text-[12px] text-fg-muted">
        {d ? (
          <>
            On <strong className="font-medium text-fg">{link.card.key}</strong> {link.card.title}
            {where ? ` · ${where}` : ""}
          </>
        ) : (
          where || "Another card in this project"
        )}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <StatePill state={d ? d.state : link.card.state} size="sm" />
        {!d ? <ProductionPill status={link.card.productionStatus} /> : null}
        {d ? (
          <span className="text-[11.5px] text-fg-muted">
            {d.versionCount ? `V${d.versionCount}` : "No files yet"}
            {d.approvedVersionNumber ? ` · V${d.approvedVersionNumber} approved` : ""}
            {d.openFeedback ? ` · ${d.openFeedback} open feedback` : ""}
          </span>
        ) : null}
      </div>
      {!d && link.card.progress.total ? row(<DeliverableProgress progress={link.card.progress} detailed />) : null}
      {link.card.archived || d?.archived ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[11.5px] text-warning">
          <Archive className="mt-0.5 size-3.5 shrink-0" />
          {d?.archived ? `${d.name} is archived on ${link.card.key}.` : `${link.card.key} is archived.`} The link stays{link.needed ? ", but it doesn't hold this card back while archived" : ""}.
        </p>
      ) : null}
      {d ? <p className="mt-2 text-[11.5px] text-fg-subtle">Its files, reviews and feedback stay on {link.card.key}, and it never counts toward this card&apos;s progress.</p> : null}
      {d ? row(<NeededToggle link={link} compact />) : null}
      {canEdit && shareable.length ? (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-fg-subtle">Share one of its deliverables here</p>
          <ul className="mt-1 grid gap-1">
            {shareable.map((x) => (
              <li key={x.id} className="flex items-center gap-1.5 text-[12px]">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: CARD_STATE_META[x.state].color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{x.name}</span>
                <Button size="xs" variant="ghost" onClick={() => onShare(x)} aria-label={`Share ${x.name} here`}>
                  <Share2 /> Share
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canEdit ? (
        <label className="mt-2 grid gap-0.5 text-[11px] text-fg-subtle">
          Folder
          <MoveToFolderSelect folders={folders} byId={folderMap} value={link.groupId} allowNew label={`Folder of the link to ${d ? d.name : link.card.key}`} onChange={(target) => (target === NEW_FOLDER ? onNewFolder() : onMove(target))} />
        </label>
      ) : link.groupId ? (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-fg-muted">
          In <FolderBreadcrumb folders={folderMap} folderId={link.groupId} className="text-[12px]" />
        </p>
      ) : null}
      {canEdit && link.groupId ? (
        <Button size="xs" variant="ghost" className="mt-1 justify-start" onClick={() => onMove(folderMap.get(link.groupId!)?.parentId ?? null)}>
          <FolderOutput /> Move out of “{folderMap.get(link.groupId)?.name ?? "folder"}”
        </Button>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="xs" variant="primary" onClick={onOpen}>
          Open {d ? `on ${link.card.key}` : link.card.key} <ArrowRight />
        </Button>
        {canEdit ? (
          <Button size="xs" variant="ghost" onClick={onRemove}>
            <Trash2 /> {d ? "Stop sharing here" : "Remove link"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
