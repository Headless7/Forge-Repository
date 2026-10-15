"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizeControl,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type ControlPosition,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ResizeParams,
  type Viewport,
} from "@xyflow/react";
import {
  Archive,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  FolderInput,
  FolderOpen,
  FolderOutput,
  FolderPlus,
  LayoutGrid,
  Link2,
  Lock,
  MessageSquareWarning,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Ungroup,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  defaultFolderName,
  dropTargetAt,
  FOLDER_COLLAPSED,
  folderDepth,
  folderContains,
  folderDescendants,
  folderFrames,
  folderSummary,
  boundsOf,
  FOLDER_HEADER,
  FOLDER_PAD,
  folderAncestors,
  foldersById,
  freeSpot,
  LAYOUT_GAP,
  packBlocks,
  uniqueFolderName,
  visibleFolderOf,
  type Rect,
} from "@/lib/canvas-folders";
import {
  availablePoints,
  clampSize,
  DEFAULT_FROM_POINT,
  DEFAULT_TO_POINT,
  NODE_DEFAULT,
  NODE_MAX,
  NODE_MIN,
  parsePoint,
  pointFraction,
  pointLabel,
  remapPoint,
  type Side,
} from "@/lib/canvas-points";
import { CARD_STATE_META } from "@/lib/card-meta";
import type { CardDetailDTO, CardState, DeliverableDTO, DeliverableGroupDTO, DeliverableLinkDTO, DeliverableLinkType, MemberDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CreatorMark } from "../domain/creator-mark";
import { KIND_ICONS } from "../domain/production";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuNested, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/menu";
import {
  AddToFolderPopover,
  FolderBreadcrumb,
  FolderColorPicker,
  folderChoices,
  folderIdOf,
  folderNodeId,
  FolderNodeView,
  GroupDropBadge,
  isFolderNode,
  MoveToFolderSelect,
  NEW_FOLDER,
  type FolderNode,
  type FolderNodeData,
} from "./canvas-folders";
import { DeliverableCoverControl } from "./cover-control";
import { DeliverableColorPicker } from "./deliverable-color";
import { DeliverableWork } from "./deliverable-work";
import { useWorkspace } from "./workspace-context";

/** Canvas viewport per card, so returning from a deliverable lands where you left. */
const savedViewports = new Map<string, Viewport>();
const SIZE_STEP = 40;
const CORNERS: ControlPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const SIDE_POSITION: Record<Side, Position> = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left };

type Size = { w: number; h: number };
type Point = { x: number; y: number };
type DeliverableNodeData = {
  deliverable: DeliverableDTO;
  blockedNames: string[];
  /** Who made it (null: unknown or left the studio, shown as nothing). */
  creator: MemberDTO | null;
  selected: boolean;
  canEdit: boolean;
  /** Explicit size: the node is drawn at it; otherwise it's as tall as its content. */
  fixedHeight: boolean;
  points: string[];
  /** Something being dragged would be grouped with this one. */
  dropping: boolean;
  onOpen: (id: string) => void;
  onResize: (id: string, params: ResizeParams) => void;
  onResizeEnd: (id: string, params: ResizeParams) => void;
};
type DeliverableNode = Node<DeliverableNodeData, "deliverable">;
type CanvasNode = DeliverableNode | FolderNode;
type LinkEdgeData = { link: DeliverableLinkDTO; satisfied: boolean; onSelect: (id: string) => void; selected: boolean };
type LinkEdge = Edge<LinkEdgeData, "link">;
type DropTarget = { id: string; kind: "deliverable" | "folder" } | null;

/** What a drag started with, frozen until it ends so frames don't chase the nodes they contain. */
interface DragSession {
  frames: Map<string, Rect>;
  candidates: Array<{ id: string; kind: "deliverable" | "folder"; rect: Rect; depth: number }>;
  /** The dragged nodes and everything inside them (never a drop target). */
  excluded: Set<string>;
  /** Where every affected node started: deliverables by id, folders by node id (their frame origin). */
  start: Map<string, Point>;
  /** Deliverables inside each dragged folder, at any depth. */
  descendantItems: Map<string, string[]>;
}
/** A node at the top of a drag (its contents travel with it). */
interface Dragged {
  kind: "deliverable" | "folder";
  id: string;
  /** The folder it was in. */
  parent: string | null;
  abs: Point;
}
/** Enough to put things back: where they were, and in which folder. */
interface Snapshot {
  parents: Array<{ kind: "deliverable" | "folder"; id: string; parent: string | null }>;
  positions: Map<string, Point>;
}

/** Where a connection point sits on the node's edge. */
function pointStyle(id: string) {
  const p = parsePoint(id)!;
  const at = `${pointFraction(p.pct) * 100}%`;
  return p.side === "t" || p.side === "b" ? { left: at } : { top: at };
}

/** The pointer, in canvas coordinates, from a mouse or touch event. */
function pointerOf(event: unknown, toFlow: (p: Point) => Point): Point | null {
  const e = event as { clientX?: number; clientY?: number; changedTouches?: TouchList; touches?: TouchList } | null;
  if (!e) return null;
  if (typeof e.clientX === "number" && typeof e.clientY === "number") return toFlow({ x: e.clientX, y: e.clientY });
  const t = e.changedTouches?.[0] ?? e.touches?.[0];
  return t ? toFlow({ x: t.clientX, y: t.clientY }) : null;
}

const quote = (name: string) => `“${name}”`;
const describe = (names: string[]) => (names.length === 1 ? quote(names[0]!) : `${names.length} items`);

const DeliverableNodeView = memo(function DeliverableNodeView({ data }: NodeProps<DeliverableNode>) {
  const { deliverable: d, blockedNames, creator, onOpen } = data;
  const kind = d.kinds.find((k) => k !== "FILE") ?? d.kinds[0];
  const KindIcon = kind ? KIND_ICONS[kind] : null;
  const attention = d.state === "NEEDS_REVIEW" ? "ring-2 ring-state-review/60" : d.state === "CHANGES_REQUESTED" ? "ring-2 ring-state-changes/60" : "";
  const description = d.description.trim();
  return (
    <div
      onDoubleClick={() => onOpen(d.id)}
      className={cn(
        "relative flex h-full w-full flex-col rounded-lg border border-border-strong bg-surface-2 text-left shadow-md",
        attention,
        data.selected && "outline outline-2 outline-accent",
        data.dropping && "ring-4 ring-accent/40",
      )}
      style={{
        borderLeft: `3px solid ${CARD_STATE_META[d.state].color}`,
        // Its own colour: a soft tint and a coloured top edge (the left edge stays the review state).
        ...(d.color ? { borderTop: `3px solid ${d.color}`, backgroundColor: `color-mix(in oklab, ${d.color} 14%, var(--surface-2))` } : {}),
      }}
    >
      {data.canEdit && data.selected
        ? CORNERS.map((position) => (
            <NodeResizeControl
              key={position}
              position={position}
              minWidth={NODE_MIN.w}
              minHeight={NODE_MIN.h}
              maxWidth={NODE_MAX.w}
              maxHeight={NODE_MAX.h}
              onResize={(_, params) => data.onResize(d.id, params)}
              onResizeEnd={(_, params) => data.onResizeEnd(d.id, params)}
              className="canvas-resize"
              aria-label={`Resize ${d.name} (${position})`}
            />
          ))
        : null}
      <div className="flex shrink-0 gap-2 p-2">
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-4">
          {d.cover?.thumbUrl ? <img src={d.cover.thumbUrl} alt="" className="h-full w-full object-cover" draggable={false} /> : KindIcon ? <KindIcon className="size-5 text-fg-subtle" /> : <span className="font-mono text-[11px] text-fg-subtle">D{d.number}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold leading-tight" title={d.name}>
            {d.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">
            {d.assetType || "Deliverable"}
            {!d.required ? " · optional" : ""}
            {d.versionCount ? ` · V${d.versionCount}` : ""}
          </p>
          <div className="mt-1 flex items-center gap-1">
            <StatePill state={d.state} size="sm" />
            {d.openFeedback ? (
              <span className="inline-flex h-5 items-center gap-0.5 rounded bg-state-changes/15 px-1 text-[10px] font-semibold text-state-changes" title={`${d.openFeedback} open feedback`}>
                <MessageSquareWarning className="size-3" /> {d.openFeedback}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {description ? (
        // Plain text (React escapes it). A larger node shows more; the rest fades out above the footer.
        <p
          className={cn(
            "mx-2 mb-1.5 min-h-0 overflow-hidden whitespace-pre-wrap break-words text-[11.5px] leading-snug text-fg-muted",
            data.fixedHeight ? "flex-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-14px),transparent)]" : "line-clamp-2",
          )}
          title={description.length > 140 ? undefined : description}
        >
          {description}
        </p>
      ) : data.fixedHeight ? (
        <span className="flex-1" />
      ) : null}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border px-2 py-1 text-[10.5px] text-fg-muted">
        <DeliverableWork d={d} className="min-w-0 flex-1 text-[10.5px]" />
        {!d.hasFiles ? <span className="shrink-0 text-fg-subtle">no files</span> : null}
        <CreatorMark person={creator} avatarOnly />
        {blockedNames.length ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-state-review" title={`Waiting on ${blockedNames.join(", ")}`}>
            <Lock className="size-3" /> blocked
          </span>
        ) : null}
      </div>
      {data.points.map((id) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={SIDE_POSITION[parsePoint(id)!.side]}
          style={pointStyle(id)}
          isConnectable={data.canEdit}
          aria-label={`${d.name}: ${pointLabel(id)}`}
          className="canvas-point !size-3 !border-2 !border-surface-2 !bg-accent"
        />
      ))}
      {data.dropping ? <GroupDropBadge /> : null}
    </div>
  );
});

function LinkEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<LinkEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const dependency = data?.link.type === "DEPENDENCY";
  const color = dependency ? (data?.satisfied ? "var(--state-approved)" : "var(--state-review)") : "var(--fg-subtle)";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: color, strokeWidth: data?.selected ? 3 : 2, strokeDasharray: dependency ? undefined : "6 5" }}
        interactionWidth={18}
      />
      {data?.link.note || data?.selected ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={() => data.onSelect(data.link.id)}
            className="nodrag nopan absolute max-w-44 truncate rounded border border-border-strong bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-fg-muted shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
            title={data.link.note}
          >
            {data.link.note || (dependency ? "requires" : "related")}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes = { deliverable: DeliverableNodeView, folder: FolderNodeView };
const edgeTypes = { link: LinkEdgeView };

export interface NodeLayoutChange {
  id: string;
  x?: number;
  y?: number;
  w?: number | null;
  h?: number | null;
}

export interface CanvasActions {
  layout: (changes: NodeLayoutChange[]) => Promise<unknown>;
  link: (input: { fromId: string; toId: string; type: DeliverableLinkType; note?: string; fromPoint?: string | null; toPoint?: string | null }) => Promise<unknown>;
  unlink: (linkId: string) => void;
  reverse: (linkId: string) => void;
  /** Re-attach an arrow's ends to other points of the same two deliverables. */
  setPoints: (linkId: string, points: { fromPoint?: string; toPoint?: string }) => void;
  rename: (deliverableId: string, name: string) => void;
  /** Archive (or restore) a deliverable; settles once saved and rejects if it couldn't be. */
  archive: (deliverableId: string, archived: boolean) => Promise<unknown>;
  /** Make a folder around deliverables and folders (positions sent are saved with it). Resolves with the card. */
  createFolder: (input: { name?: string; parentId: string | null; deliverableIds: string[]; groupIds?: string[]; positions?: NodeLayoutChange[] }) => Promise<CardDetailDTO>;
  updateFolder: (groupId: string, patch: { name?: string; color?: string | null }) => Promise<unknown>;
  /** Collapse or expand a folder: saved for people who can edit; a local view for everyone else. */
  toggleFolder: (groupId: string, collapsed: boolean) => void;
  /** Dissolve a folder: what's inside moves up a level. */
  ungroup: (groupId: string) => Promise<unknown>;
  /** Move deliverables and folders into a folder (null = the top level). Resolves with the card. */
  moveToFolder: (input: { deliverableIds?: string[]; groupIds?: string[]; targetGroupId: string | null; positions?: NodeLayoutChange[] }) => Promise<CardDetailDTO>;
}

function ConnectDialog({
  pending,
  names,
  onCancel,
  onConfirm,
}: {
  pending: { fromId: string; toId: string } | null;
  names: Map<string, string>;
  onCancel: () => void;
  onConfirm: (type: DeliverableLinkType, note: string) => void;
}) {
  const [type, setType] = useState<DeliverableLinkType>("DEPENDENCY");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (pending) {
      setType("DEPENDENCY");
      setNote("");
    }
  }, [pending]);
  const from = pending ? names.get(pending.fromId) : "";
  const to = pending ? names.get(pending.toId) : "";
  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent title="Connect deliverables" description={`${from} → ${to}`}>
        <div className="grid gap-2" role="radiogroup" aria-label="Connection type">
          {(
            [
              ["DEPENDENCY", "Dependency", `${to} requires ${from}. ${to} shows as blocked until ${from} is approved.`],
              ["ASSOCIATION", "Association", "Related work that doesn't block anything — for context and navigation."],
            ] as const
          ).map(([value, label, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={type === value}
              onClick={() => setType(value)}
              className={cn("rounded-lg border p-3 text-left", type === value ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                {value === "DEPENDENCY" ? <ArrowRight className="size-4" /> : <Link2 className="size-4" />} {label}
              </span>
              <span className="mt-0.5 block text-[12px] text-fg-muted">{text}</span>
            </button>
          ))}
        </div>
        <Textarea className="mt-3" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (e.g. “the burst is timed to the Hit marker”)" maxLength={500} />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(type, note)}>
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A summary panel's title: a click (or tap) turns it into a field — Enter, ✓ or leaving it saves,
 * Esc cancels. A new `editKey` opens the field straight away (the context menu's Rename).
 */
function SummaryName({ name, label, maxLength, canEdit, editKey, onRename }: { name: string; label: string; maxLength: number; canEdit: boolean; editKey?: number; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  // Each edit ends once: saved or cancelled (a blur while the field goes away mustn't save again).
  const ended = useRef(false);
  useEffect(() => {
    if (!editing) setValue(name);
  }, [name, editing]);
  useEffect(() => {
    if (editKey && canEdit) {
      ended.current = false;
      setEditing(true);
    }
  }, [editKey, canEdit]);
  if (!canEdit) return <p className="min-w-0 flex-1 break-words text-[13px] font-semibold">{name}</p>;
  if (editing) {
    const commit = () => {
      if (ended.current) return;
      ended.current = true;
      setEditing(false);
      const next = value.trim();
      if (next && next !== name) onRename(next);
      else setValue(name);
    };
    return (
      <div className="-my-0.5 flex min-w-0 flex-1 items-center gap-1">
        <input
          autoFocus
          value={value}
          maxLength={maxLength}
          aria-label={label}
          // Esc cancels the rename here instead of closing the card.
          data-inline-edit
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              ended.current = true;
              setValue(name);
              setEditing(false);
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-accent bg-surface-3 px-1.5 text-[13px] font-semibold outline-none"
        />
        {/* Phones don't always leave a field when you tap elsewhere: an explicit save. Pressing it
            keeps focus in the field, so the save happens once (here, not on blur). */}
        <Button size="icon-sm" variant="ghost" aria-label="Save name" onPointerDown={(e) => e.preventDefault()} onClick={commit}>
          <Check />
        </Button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        ended.current = false;
        setEditing(true);
      }}
      aria-label={`Rename ${name}`}
      title="Rename"
      className="group/name -mx-1 -my-0.5 flex min-h-7 min-w-0 flex-1 items-start gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px] font-semibold hover:bg-surface-3"
    >
      <span className="min-w-0 break-words">{name}</span>
      <Pencil className="hover-reveal mt-0.5 size-3.5 shrink-0 text-fg-subtle opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100" aria-hidden />
    </button>
  );
}

function PanelClose({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Close" onClick={onClick} className="touch-target -m-1 flex size-7 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg">
      <X className="size-4" />
    </button>
  );
}

const PANEL = "scrollbar-thin absolute bottom-3 right-3 z-10 max-h-[calc(100%-24px)] w-[min(320px,calc(100%-24px))] overflow-y-auto overscroll-contain rounded-lg border border-border-strong bg-surface-2 p-3 shadow-lg";

function Canvas({
  deliverables,
  folders,
  links,
  canEdit,
  actions,
  onOpen,
}: {
  deliverables: DeliverableDTO[];
  folders: DeliverableGroupDTO[];
  links: DeliverableLinkDTO[];
  canEdit: boolean;
  actions: CanvasActions;
  onOpen: (id: string) => void;
}) {
  const { card, membersById } = useWorkspace();
  const flow = useReactFlow();
  // Local layout while dragging/resizing (and until the saved values come back). Positions are
  // absolute canvas coordinates whatever folder a node is in.
  const [moving, setMoving] = useState<Map<string, Point>>(new Map());
  const [sizing, setSizing] = useState<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());
  /** Frame origins of folders being dragged (their contents travel with them). */
  const [movingFolders, setMovingFolders] = useState<Map<string, Point>>(new Map());
  const [connecting, setConnecting] = useState(false);
  // Sizes xyflow measured. Handing them back keeps nodes (and their handles) measured when we
  // rebuild node objects — otherwise every update hides and re-measures them for a frame.
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setMeasured((current) => {
      let next: Map<string, { width: number; height: number }> | null = null;
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions || isFolderNode(change.id)) continue;
        const known = current.get(change.id);
        if (known && known.width === change.dimensions.width && known.height === change.dimensions.height) continue;
        next ??= new Map(current);
        next.set(change.id, change.dimensions);
      }
      return next ?? current;
    });
    // Selection (click, shift-click, box selection) is xyflow's; we keep the set it reports.
    setSelectedIds((current) => {
      let next: Set<string> | null = null;
      for (const change of changes) {
        if (change.type !== "select") continue;
        if (change.selected === current.has(change.id)) continue;
        next ??= new Set(current);
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      return next ?? current;
    });
  }, []);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ fromId: string; toId: string; fromPoint: string | null; toPoint: string | null } | null>(null);
  const byId = useMemo(() => new Map(deliverables.map((d) => [d.id, d])), [deliverables]);
  const names = useMemo(() => new Map(deliverables.map((d) => [d.id, d.name])), [deliverables]);
  const activeIds = useMemo(() => new Set(deliverables.map((d) => d.id)), [deliverables]);
  const [colorMode] = useState<"light" | "dark">(() => (typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark"));

  // Folders, with collapse state overridden locally until it's saved (or for good, for people who can't edit).
  const [collapsedLocal, setCollapsedLocal] = useState<Map<string, boolean>>(new Map());
  const folderMap = useMemo(() => {
    const m = new Map<string, DeliverableGroupDTO>();
    for (const f of folders) m.set(f.id, collapsedLocal.has(f.id) ? { ...f, collapsed: collapsedLocal.get(f.id)! } : f);
    return m;
  }, [folders, collapsedLocal]);
  const folderList = useMemo(() => [...folderMap.values()], [folderMap]);
  const foldersRef = useRef(folderMap);
  foldersRef.current = folderMap;
  useEffect(() => {
    setCollapsedLocal((m) => {
      if (!m.size) return m;
      const next = new Map(m);
      for (const [id, collapsed] of m) {
        const f = folders.find((x) => x.id === id);
        if (!f || (canEdit && f.collapsed === collapsed)) next.delete(id);
      }
      return next.size === m.size ? m : next;
    });
  }, [folders, canEdit]);

  // Drop local overrides once the saved layout comes back (or someone else changed the node).
  useEffect(() => {
    setMoving((m) => {
      if (!m.size) return m;
      const next = new Map(m);
      for (const [id, p] of m) {
        const d = byId.get(id);
        if (!d || (Math.abs(d.canvasX - p.x) < 1 && Math.abs(d.canvasY - p.y) < 1)) next.delete(id);
      }
      return next.size === m.size ? m : next;
    });
    setSizing((m) => {
      if (!m.size) return m;
      const next = new Map(m);
      for (const [id, s] of m) {
        const d = byId.get(id);
        if (!d || (d.canvasW !== null && d.canvasH !== null && Math.abs(d.canvasW - s.w) < 1 && Math.abs(d.canvasH - s.h) < 1)) next.delete(id);
      }
      return next.size === m.size ? m : next;
    });
  }, [byId]);

  /** The size geometry uses: while resizing, the live size; else saved; else as measured (auto height). */
  const sizeOf = useCallback(
    (d: DeliverableDTO): Size => {
      const live = sizing.get(d.id);
      if (live) return { w: live.w, h: live.h };
      const seen = measured.get(d.id);
      return { w: d.canvasW ?? NODE_DEFAULT.w, h: d.canvasH ?? (seen ? Math.round(seen.height) : NODE_DEFAULT.h) };
    },
    [sizing, measured],
  );
  /** Where a deliverable is (absolute): resizing, else dragging, else saved. */
  const posOf = useCallback(
    (d: DeliverableDTO): Point => {
      const live = sizing.get(d.id);
      if (live) return { x: live.x, y: live.y };
      return moving.get(d.id) ?? { x: d.canvasX, y: d.canvasY };
    },
    [sizing, moving],
  );
  const groupOf = useCallback((d: DeliverableDTO) => (d.groupId && folderMap.has(d.groupId) ? d.groupId : null), [folderMap]);

  // Folder frames: the box around what's inside each. Frozen for the length of a drag (otherwise a
  // frame would follow the node being dragged out of it, and there'd be no "out").
  const items = useMemo(() => deliverables.map((d) => ({ id: d.id, groupId: groupOf(d), rect: { ...posOf(d), ...sizeOf(d) } })), [deliverables, groupOf, posOf, sizeOf]);
  const liveFrames = useMemo(() => folderFrames(folderList, items), [folderList, items]);
  const [frozenFrames, setFrozenFrames] = useState<Map<string, Rect> | null>(null);
  const frames = frozenFrames ?? liveFrames;
  const framesRef = useRef(frames);
  framesRef.current = frames;

  /** Active deliverables inside each folder, at any depth, and their states. */
  const contents = useMemo(() => {
    const m = new Map<string, { count: number; states: CardState[] }>();
    for (const f of folderList) m.set(f.id, { count: 0, states: [] });
    for (const d of deliverables) {
      let cursor = groupOf(d);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const entry = m.get(cursor);
        if (entry) {
          entry.count += 1;
          entry.states.push(d.state);
        }
        cursor = folderMap.get(cursor)?.parentId ?? null;
      }
    }
    return m;
  }, [folderList, deliverables, groupOf, folderMap]);

  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const dropRef = useRef<DropTarget>(null);
  const session = useRef<DragSession | null>(null);

  const onResize = useCallback((id: string, p: ResizeParams, parent: string | null) => {
    const base = parent ? framesRef.current.get(parent) : undefined;
    setSizing((m) => new Map(m).set(id, { x: p.x + (base?.x ?? 0), y: p.y + (base?.y ?? 0), w: p.width, h: p.height }));
  }, []);
  const onResizeEnd = useCallback(
    (id: string, p: ResizeParams, parent: string | null) => {
      const base = parent ? framesRef.current.get(parent) : undefined;
      const size = clampSize(p.width, p.height);
      const x = p.x + (base?.x ?? 0);
      const y = p.y + (base?.y ?? 0);
      setSizing((m) => new Map(m).set(id, { x, y, ...size }));
      void actions.layout([{ id, x, y, w: size.w, h: size.h }]);
    },
    [actions],
  );
  const toggleFolder = useCallback(
    (id: string) => {
      const f = foldersRef.current.get(id);
      if (!f) return;
      const collapsed = !f.collapsed;
      setCollapsedLocal((m) => new Map(m).set(id, collapsed));
      actions.toggleFolder(id, collapsed);
    },
    [actions],
  );

  const nodes: CanvasNode[] = useMemo(() => {
    const list: CanvasNode[] = [];
    // xyflow wants a parent before its children.
    const ordered = [...folderList].sort((a, b) => folderDepth(folderMap, a.parentId) - folderDepth(folderMap, b.parentId));
    for (const f of ordered) {
      const frame = frames.get(f.id);
      if (!frame) continue;
      const origin = movingFolders.get(f.id) ?? frame;
      const parentFrame = f.parentId ? frames.get(f.parentId) : undefined;
      const nodeId = folderNodeId(f.id);
      const inside = contents.get(f.id) ?? { count: 0, states: [] };
      list.push({
        id: nodeId,
        type: "folder",
        position: { x: origin.x - (parentFrame?.x ?? 0), y: origin.y - (parentFrame?.y ?? 0) },
        width: frame.w,
        height: frame.h,
        parentId: parentFrame && f.parentId ? folderNodeId(f.parentId) : undefined,
        hidden: visibleFolderOf(folderMap, f.parentId) !== null,
        zIndex: 0,
        selected: selectedIds.has(nodeId),
        draggable: canEdit,
        connectable: false,
        data: {
          folder: f,
          collapsed: f.collapsed,
          count: inside.count,
          states: inside.states,
          selected: selectedIds.has(nodeId),
          canEdit,
          dropping: dropTarget?.kind === "folder" && dropTarget.id === f.id,
          onToggle: toggleFolder,
        } satisfies FolderNodeData,
        ariaLabel: `Folder ${f.name}, ${folderSummary(inside.count, inside.states)}${f.collapsed ? ", collapsed" : ""}`,
      });
    }
    for (const d of deliverables) {
      const live = sizing.get(d.id);
      const fixed = Boolean(live) || d.canvasH !== null;
      const size = sizeOf(d);
      const abs = posOf(d);
      const parent = groupOf(d);
      const parentFrame = parent ? frames.get(parent) : undefined;
      list.push({
        id: d.id,
        type: "deliverable",
        position: { x: abs.x - (parentFrame?.x ?? 0), y: abs.y - (parentFrame?.y ?? 0) },
        width: size.w,
        ...(fixed ? { height: size.h } : {}),
        measured: measured.get(d.id),
        parentId: parentFrame && parent ? folderNodeId(parent) : undefined,
        hidden: visibleFolderOf(folderMap, parent) !== null,
        zIndex: 1,
        selected: selectedIds.has(d.id),
        data: {
          deliverable: d,
          blockedNames: d.blockedBy.map((id) => names.get(id) ?? "?"),
          creator: (d.createdById && membersById.get(d.createdById)) || null,
          selected: selectedIds.has(d.id),
          canEdit,
          fixedHeight: fixed,
          points: availablePoints(size),
          dropping: dropTarget?.kind === "deliverable" && dropTarget.id === d.id,
          onOpen,
          onResize: (id, p) => onResize(id, p, parent),
          onResizeEnd: (id, p) => onResizeEnd(id, p, parent),
        },
        draggable: canEdit,
        connectable: canEdit,
        ariaLabel: `${d.name}, ${CARD_STATE_META[d.state].label}`,
      });
    }
    return list;
  }, [folderList, folderMap, frames, movingFolders, contents, selectedIds, canEdit, dropTarget, toggleFolder, deliverables, sizing, measured, names, membersById, onOpen, onResize, onResizeEnd, sizeOf, posOf, groupOf]);

  /** The node an arrow end attaches to: the deliverable, or the collapsed folder standing in for it. */
  const endpoint = useCallback(
    (id: string): { nodeId: string; size: Size } => {
      const d = byId.get(id)!;
      const folder = visibleFolderOf(folderMap, groupOf(d));
      return folder ? { nodeId: folderNodeId(folder), size: FOLDER_COLLAPSED } : { nodeId: id, size: sizeOf(d) };
    },
    [byId, folderMap, groupOf, sizeOf],
  );
  const edges: LinkEdge[] = useMemo(
    () =>
      links
        .filter((l) => activeIds.has(l.fromId) && activeIds.has(l.toId))
        .flatMap((l) => {
          const from = endpoint(l.fromId);
          const to = endpoint(l.toId);
          // Both ends inside the same collapsed folder: nothing to draw.
          if (from.nodeId === to.nodeId) return [];
          const satisfied = byId.get(l.fromId)?.state === "APPROVED";
          return [
            {
              id: l.id,
              source: from.nodeId,
              target: to.nodeId,
              // Saved points, moved to the nearest remaining point if a node has since shrunk.
              sourceHandle: remapPoint(l.fromPoint, from.size, DEFAULT_FROM_POINT),
              targetHandle: remapPoint(l.toPoint, to.size, DEFAULT_TO_POINT),
              type: "link" as const,
              selected: selectedEdge === l.id,
              data: { link: l, satisfied, onSelect: setSelectedEdge, selected: selectedEdge === l.id },
              markerEnd: l.type === "DEPENDENCY" ? { type: MarkerType.ArrowClosed, color: satisfied ? "var(--state-approved)" : "var(--state-review)", width: 18, height: 18 } : undefined,
              ariaLabel: l.type === "DEPENDENCY" ? `${names.get(l.toId)} requires ${names.get(l.fromId)}` : `${names.get(l.fromId)} is related to ${names.get(l.toId)}`,
            },
          ];
        }),
    [links, activeIds, byId, selectedEdge, names, endpoint],
  );

  // The arrow points from where the drag started to where it ended (prerequisite → dependant).
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target || isFolderNode(c.source) || isFolderNode(c.target)) return;
    setPendingConnection({ fromId: c.source, toId: c.target, fromPoint: c.sourceHandle ?? null, toPoint: c.targetHandle ?? null });
  }, []);

  // Dragging an arrow end to another point of the same deliverable only moves where it attaches.
  const onReconnect = useCallback(
    (old: LinkEdge, next: Connection) => {
      if (next.source !== old.source || next.target !== old.target) {
        toast("Arrow ends can move to another point on the same deliverable. To connect different deliverables, draw a new arrow.");
        return;
      }
      if (isFolderNode(old.source) || isFolderNode(old.target)) {
        toast("Expand the folder to move this arrow's ends.");
        return;
      }
      if (next.sourceHandle === old.sourceHandle && next.targetHandle === old.targetHandle) return;
      actions.setPoints(old.id, { fromPoint: next.sourceHandle ?? undefined, toPoint: next.targetHandle ?? undefined });
    },
    [actions],
  );

  // ── Dragging: moving, and dropping into (or onto) things ───────────────────

  const toFlow = useCallback((p: Point) => flow.screenToFlowPosition(p), [flow]);
  const absOf = useCallback((node: { id: string; position: Point; parentId?: string }, frameMap: Map<string, Rect>): Point => {
    const base = node.parentId ? frameMap.get(folderIdOf(node.parentId)) : undefined;
    return { x: node.position.x + (base?.x ?? 0), y: node.position.y + (base?.y ?? 0) };
  }, []);
  const commitPositions = useCallback((positions: Map<string, Point>) => {
    setMoving((m) => {
      const next = new Map(m);
      for (const [id, p] of positions) next.set(id, p);
      return next;
    });
  }, []);
  const layoutOf = (positions: Map<string, Point>): NodeLayoutChange[] => [...positions].map(([id, p]) => ({ id, x: p.x, y: p.y }));

  // ── Placement: nothing lands on top of anything else ──────────────────────
  //
  // A move is planned on a copy of the canvas: what goes where (folder membership) and where it
  // sits. The moved cards go next to their destination's contents (or stay where they were
  // dropped), nudged to the nearest clear spot; then the destination folder — and each folder
  // around it — is nudged clear of its neighbours if it grew into them.

  type Plan = {
    positions: Map<string, Point>;
    /** New folder of a deliverable. */
    parentOf: Map<string, string | null>;
    /** New parent of a folder. */
    folderParent: Map<string, string | null>;
    /** A folder being made by this move (not saved yet). */
    newFolder?: { parentId: string | null };
  };
  const NEW_FOLDER_ID = "__new__";

  const world = (plan: Plan) => {
    const foldersH: Array<{ id: string; parentId: string | null; collapsed: boolean }> = folderList.map((f) => ({
      id: f.id,
      parentId: plan.folderParent.has(f.id) ? plan.folderParent.get(f.id)! : f.parentId,
      collapsed: f.collapsed,
    }));
    if (plan.newFolder) foldersH.push({ id: NEW_FOLDER_ID, parentId: plan.newFolder.parentId, collapsed: false });
    const byIdH = foldersById(foldersH);
    const itemsH = deliverables.map((d) => {
      const at = plan.positions.get(d.id) ?? posOf(d);
      return { id: d.id, groupId: plan.parentOf.has(d.id) ? plan.parentOf.get(d.id)! : groupOf(d), rect: { ...at, ...sizeOf(d) } };
    });
    return { foldersH, byIdH, itemsH, framesH: folderFrames(foldersH, itemsH) };
  };

  /** Everything visible in the planned canvas except `skipItems`, `skipFolders` and the frames of `around`. */
  const obstaclesIn = (w: ReturnType<typeof world>, skipItems: Set<string>, skipFolders: Set<string>, around: Set<string>): Rect[] => [
    ...w.itemsH.filter((i) => !skipItems.has(i.id) && visibleFolderOf(w.byIdH, i.groupId) === null).map((i) => i.rect),
    ...w.foldersH
      .filter((f) => !skipFolders.has(f.id) && !around.has(f.id) && visibleFolderOf(w.byIdH, f.parentId) === null)
      .flatMap((f) => (w.framesH.has(f.id) ? [w.framesH.get(f.id)!] : [])),
  ];

  const shiftItems = (plan: Plan, ids: Iterable<string>, dx: number, dy: number) => {
    if (!dx && !dy) return;
    for (const id of ids) {
      const d = byId.get(id);
      if (!d) continue;
      const p = plan.positions.get(id) ?? posOf(d);
      plan.positions.set(id, { x: p.x + dx, y: p.y + dy });
    }
  };

  /** Nudges a folder (and then each folder around it) clear of its neighbours. */
  const settle = (plan: Plan, folderId: string | null) => {
    let cursor = folderId;
    for (let guard = 0; cursor && guard < 40; guard++) {
      const w = world(plan);
      const frame = w.framesH.get(cursor);
      if (!frame) break;
      const inside = folderDescendants(w.foldersH, w.itemsH, cursor);
      const obstacles = obstaclesIn(w, new Set(inside.itemIds), new Set([cursor, ...inside.folderIds]), new Set(folderAncestors(w.byIdH, cursor)));
      const spot = freeSpot(frame, obstacles);
      shiftItems(plan, inside.itemIds, spot.x - frame.x, spot.y - frame.y);
      cursor = w.byIdH.get(cursor)?.parentId ?? null;
    }
  };

  /**
   * Plans a move of deliverables and folders into `target` (or into a new folder there with
   * `newFolder`). `place` are the ones to position (default: all of them): packed together when
   * `pack`, then put at `start` — when left out, beside the destination's contents (or where they
   * are, when leaving for the top level); `null` keeps them where they are — or the nearest clear spot. Returns the deliverables that
   * end up somewhere new, and where they were.
   */
  const planMove = (opts: {
    deliverableIds: string[];
    groupIds: string[];
    target: string | null;
    newFolder?: boolean;
    positions?: Map<string, Point>;
    place?: { deliverableIds: string[]; groupIds: string[] };
    start?: Point | null;
    pack?: boolean;
  }): { positions: Map<string, Point>; before: Map<string, Point> } => {
    const dest = opts.newFolder ? NEW_FOLDER_ID : opts.target;
    const plan: Plan = {
      positions: new Map(opts.positions ?? []),
      parentOf: new Map(opts.deliverableIds.map((id) => [id, dest])),
      folderParent: new Map(opts.groupIds.map((id) => [id, dest])),
      newFolder: opts.newFolder ? { parentId: opts.target } : undefined,
    };
    const place = opts.place ?? { deliverableIds: opts.deliverableIds, groupIds: opts.groupIds };
    // Each placed thing is a block: a deliverable, or a folder with everything inside it.
    const blocksOf = () => {
      const w = world(plan);
      return [
        ...place.deliverableIds.flatMap((id) => {
          const r = w.itemsH.find((i) => i.id === id)?.rect;
          return r ? [{ rect: r, itemIds: [id] }] : [];
        }),
        ...place.groupIds.flatMap((id) => {
          const r = w.framesH.get(id);
          return r ? [{ rect: r, itemIds: folderDescendants(w.foldersH, w.itemsH, id).itemIds }] : [];
        }),
      ];
    };
    let blocks = blocksOf();
    if (blocks.length) {
      if (opts.pack && blocks.length > 1) {
        const ordered = [...blocks].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
        const first = boundsOf(ordered.map((b) => b.rect))!;
        const spots = packBlocks(
          ordered.map((b) => b.rect),
          { x: first.x, y: first.y },
        );
        ordered.forEach((b, i) => shiftItems(plan, b.itemIds, spots[i]!.x - b.rect.x, spots[i]!.y - b.rect.y));
        blocks = blocksOf();
      }
      const w = world(plan);
      const bounds = boundsOf(blocks.map((b) => b.rect))!;
      const movingItems = new Set(blocks.flatMap((b) => b.itemIds));
      const movingFolders = new Set(place.groupIds.flatMap((id) => [id, ...folderDescendants(w.foldersH, w.itemsH, id).folderIds]));
      // `start: null` keeps them where they are (dropped there); left out, they go beside the destination's contents.
      let start = opts.start ?? null;
      if (opts.start === undefined && dest && dest !== NEW_FOLDER_ID) {
        // Beside what's already in the destination, aligned with its top.
        const existing = [
          ...w.itemsH.filter((i) => i.groupId === dest && !movingItems.has(i.id)).map((i) => i.rect),
          ...w.foldersH.filter((f) => f.parentId === dest && !movingFolders.has(f.id)).flatMap((f) => (w.framesH.has(f.id) ? [w.framesH.get(f.id)!] : [])),
        ];
        const there = boundsOf(existing);
        if (there) start = { x: there.x + there.w + LAYOUT_GAP, y: there.y };
      }
      start ??= { x: bounds.x, y: bounds.y };
      const around = new Set(dest && dest !== NEW_FOLDER_ID ? [dest, ...folderAncestors(w.byIdH, dest)] : dest === NEW_FOLDER_ID && opts.target ? [opts.target, ...folderAncestors(w.byIdH, opts.target)] : []);
      const spot = freeSpot({ ...start, w: bounds.w, h: bounds.h }, obstaclesIn(w, movingItems, movingFolders, around));
      shiftItems(plan, movingItems, spot.x - bounds.x, spot.y - bounds.y);
    }
    settle(plan, dest);
    const positions = new Map<string, Point>();
    const before = new Map<string, Point>();
    for (const [id, p] of plan.positions) {
      const d = byId.get(id);
      if (!d) continue;
      const was = posOf(d);
      if (Math.abs(was.x - p.x) > 0.5 || Math.abs(was.y - p.y) > 0.5) {
        positions.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
        before.set(id, was);
      }
    }
    return { positions, before };
  };

  /** A new folder's name: from the shared type, and never the same as a folder beside or around it. */
  const nameFor = (members: DeliverableDTO[], parentId: string | null) =>
    uniqueFolderName(defaultFolderName(members), [
      ...folderList.filter((f) => f.parentId === parentId).map((f) => f.name),
      ...(parentId ? [parentId, ...folderAncestors(folderMap, parentId)].map((id) => folderMap.get(id)?.name ?? "") : []),
    ]);

  const onNodeDragStart = useCallback(
    (_: unknown, __: CanvasNode, dragged: CanvasNode[]) => {
      const start = new Map<string, Point>();
      const descendantItems = new Map<string, string[]>();
      const excluded = new Set<string>();
      for (const n of dragged) {
        if (isFolderNode(n.id)) {
          const fid = folderIdOf(n.id);
          const desc = folderDescendants(folderList, items, fid);
          descendantItems.set(fid, desc.itemIds);
          excluded.add(fid);
          for (const id of desc.folderIds) excluded.add(id);
          for (const id of desc.itemIds) {
            excluded.add(id);
            const d = byId.get(id);
            if (d) start.set(id, posOf(d));
          }
          const frame = frames.get(fid);
          if (frame) start.set(n.id, { x: frame.x, y: frame.y });
        } else {
          excluded.add(n.id);
          const d = byId.get(n.id);
          if (d) start.set(n.id, posOf(d));
        }
      }
      const candidates: DragSession["candidates"] = [
        ...items.filter((i) => visibleFolderOf(folderMap, i.groupId) === null).map((i) => ({ id: i.id, kind: "deliverable" as const, rect: i.rect, depth: folderDepth(folderMap, i.groupId) + 1 })),
        ...folderList.filter((f) => visibleFolderOf(folderMap, f.parentId) === null).map((f) => ({ id: f.id, kind: "folder" as const, rect: frames.get(f.id)!, depth: folderDepth(folderMap, f.parentId) + 1 })),
      ];
      session.current = { frames, candidates, excluded, start, descendantItems };
      setFrozenFrames(frames);
    },
    [folderList, items, byId, posOf, frames, folderMap],
  );

  const onNodeDrag = useCallback(
    (event: unknown, _: CanvasNode, dragged: CanvasNode[]) => {
      const s = session.current;
      if (!s) return;
      const nodesMoved = new Map<string, Point>();
      const foldersMoved = new Map<string, Point>();
      for (const n of dragged) {
        const abs = absOf(n, s.frames);
        if (isFolderNode(n.id)) foldersMoved.set(folderIdOf(n.id), abs);
        else nodesMoved.set(n.id, abs);
      }
      if (nodesMoved.size) commitPositions(nodesMoved);
      if (foldersMoved.size)
        setMovingFolders((m) => {
          const next = new Map(m);
          for (const [id, p] of foldersMoved) next.set(id, p);
          return next;
        });
      const p = pointerOf(event, toFlow);
      const target = canEdit && p ? dropTargetAt(p, s.candidates, s.excluded) : null;
      if ((target?.id ?? null) !== (dropRef.current?.id ?? null)) {
        dropRef.current = target;
        setDropTarget(target);
      }
    },
    [absOf, commitPositions, toFlow, canEdit],
  );

  /** Puts dragged nodes back where (and in which folder) they were. */
  const restore = useCallback(
    (snapshot: Snapshot) => {
      commitPositions(snapshot.positions);
      const positions = layoutOf(snapshot.positions);
      // Back to each one's previous folder (a folder removed since then means the top level).
      const byParent = new Map<string | null, { deliverableIds: string[]; groupIds: string[] }>();
      for (const p of snapshot.parents) {
        const parent = p.parent && foldersRef.current.has(p.parent) ? p.parent : null;
        const entry = byParent.get(parent) ?? { deliverableIds: [], groupIds: [] };
        (p.kind === "folder" ? entry.groupIds : entry.deliverableIds).push(p.id);
        byParent.set(parent, entry);
      }
      let chain: Promise<unknown> = Promise.resolve();
      let first = true;
      for (const [parent, entry] of byParent) {
        const sendPositions = first;
        first = false;
        chain = chain.then(() => actions.moveToFolder({ ...entry, targetGroupId: parent, positions: sendPositions ? positions : undefined }));
      }
      if (first) chain = actions.layout(positions);
      return chain.catch(() => {});
    },
    [actions, commitPositions],
  );

  const snapshotOf = (s: DragSession, dragged: Dragged[], ids: Iterable<string>): Snapshot => {
    const positions = new Map<string, Point>();
    for (const id of ids) {
      const p = s.start.get(id);
      if (p) positions.set(id, p);
    }
    return { parents: dragged.map((d) => ({ kind: d.kind, id: d.id, parent: d.parent })), positions };
  };
  const draggedNames = (dragged: Dragged[]) => dragged.map((d) => (d.kind === "folder" ? folderMap.get(d.id)?.name : names.get(d.id)) ?? "?");

  /** Dropped onto a deliverable: a new folder (in that deliverable's folder) around it and what was dragged. */
  const groupOnto = (s: DragSession, targetId: string, dragged: Dragged[], finalPos: Map<string, Point>) => {
    const target = byId.get(targetId);
    if (!target) return;
    const draggedIds = dragged.filter((d) => d.kind === "deliverable").map((d) => d.id);
    const groupIds = dragged.filter((d) => d.kind === "folder").map((d) => d.id);
    const deliverableIds = [targetId, ...draggedIds];
    // Beside the target rather than on top of it, clear of everything else; the new folder then
    // makes room for itself if its frame would cover a neighbour.
    const rect = { ...posOf(target), ...sizeOf(target) };
    const { positions: planned } = planMove({
      deliverableIds,
      groupIds,
      target: groupOf(target),
      newFolder: true,
      positions: finalPos,
      place: { deliverableIds: draggedIds, groupIds },
      start: { x: rect.x + rect.w + LAYOUT_GAP, y: rect.y },
    });
    const nudged = new Map([...finalPos, ...planned]);
    const before = snapshotOf(s, dragged, nudged.keys());
    if (planned.has(targetId)) before.positions.set(targetId, posOf(target));
    commitPositions(nudged);
    const name = nameFor(deliverableIds.map((id) => byId.get(id)).filter((d): d is DeliverableDTO => Boolean(d)), groupOf(target));
    actions
      .createFolder({ name, parentId: groupOf(target), deliverableIds, groupIds, positions: layoutOf(nudged) })
      .then((detail) => {
        const created = detail.deliverableGroups.find((g) => !folderMap.has(g.id));
        if (created) setSelectedIds(new Set([folderNodeId(created.id)]));
        toast.success(`Grouped ${quote(target.name)} and ${describe(draggedNames(dragged))} in ${quote(name)}.`, {
          description: "Select the folder to rename it, change its colour or add more.",
          action: {
            label: "Undo",
            onClick: () => {
              const undo = created && foldersRef.current.has(created.id) ? actions.ungroup(created.id) : Promise.resolve();
              void undo.then(() => restore(before)).catch(() => {});
            },
          },
        });
      })
      .catch(() => commitPositions(before.positions));
  };

  /** Dropped into a folder, or out of one onto the open canvas. */
  const moveDragged = (s: DragSession, target: string | null, dragged: Dragged[], dropped: Map<string, Point>) => {
    const deliverableIds = dragged.filter((d) => d.kind === "deliverable").map((d) => d.id);
    const groupIds = dragged.filter((d) => d.kind === "folder").map((d) => d.id);
    // Where it was dropped, unless that covers something: then the nearest clear spot.
    const { positions: planned } = planMove({ deliverableIds, groupIds, target, positions: dropped, start: null });
    const finalPos = new Map([...dropped, ...planned]);
    const before = snapshotOf(s, dragged, finalPos.keys());
    for (const id of planned.keys()) if (!before.positions.has(id)) before.positions.set(id, posOf(byId.get(id)!));
    commitPositions(finalPos);
    const fromIds = new Set(dragged.map((d) => d.parent));
    const from = fromIds.size === 1 ? [...fromIds][0]! : null;
    const fromName = from ? folderMap.get(from)?.name : null;
    actions
      .moveToFolder({ deliverableIds, groupIds, targetGroupId: target, positions: layoutOf(finalPos) })
      .then((detail) => {
        const removed = from && !detail.deliverableGroups.some((g) => g.id === from) ? fromName : null;
        const what = describe(draggedNames(dragged));
        toast.success(target ? `Moved ${what} into ${quote(folderMap.get(target)?.name ?? "folder")}.` : fromName ? `Moved ${what} out of ${quote(fromName)}.` : `Moved ${what} to the top level.`, {
          description: removed ? `${quote(removed)} was left empty, so it's gone.` : undefined,
          action: { label: "Undo", onClick: () => void restore(before) },
        });
      })
      .catch(() => commitPositions(before.positions));
  };

  const onNodeDragStop = useCallback(
    (event: unknown, node: CanvasNode, dragged: CanvasNode[]) => {
      const s = session.current;
      session.current = null;
      setFrozenFrames(null);
      dropRef.current = null;
      setDropTarget(null);
      setMovingFolders(new Map());
      if (!s) return;
      const finalPos = new Map<string, Point>();
      const top: Dragged[] = [];
      for (const n of dragged) {
        const abs = absOf(n, s.frames);
        if (isFolderNode(n.id)) {
          const fid = folderIdOf(n.id);
          const from = s.start.get(n.id);
          const dx = from ? abs.x - from.x : 0;
          const dy = from ? abs.y - from.y : 0;
          for (const id of s.descendantItems.get(fid) ?? []) {
            const p0 = s.start.get(id);
            if (p0) finalPos.set(id, { x: p0.x + dx, y: p0.y + dy });
          }
          top.push({ kind: "folder", id: fid, parent: folderMap.get(fid)?.parentId ?? null, abs });
        } else {
          finalPos.set(n.id, abs);
          const d = byId.get(n.id);
          top.push({ kind: "deliverable", id: n.id, parent: d ? groupOf(d) : null, abs });
        }
      }
      const moved = [...finalPos].some(([id, p]) => {
        const p0 = s.start.get(id);
        return !p0 || Math.abs(p0.x - p.x) > 0.5 || Math.abs(p0.y - p.y) > 0.5;
      });
      const p = pointerOf(event, toFlow);
      const target = canEdit && p ? dropTargetAt(p, s.candidates, s.excluded) : null;
      if (target?.kind === "deliverable") {
        groupOnto(s, target.id, top, finalPos);
        return;
      }
      if (target?.kind === "folder" && top.some((t) => t.parent !== target.id)) {
        moveDragged(s, target.id, top, finalPos);
        return;
      }
      if (!target && top.some((t) => t.parent !== null)) {
        moveDragged(s, null, top, finalPos);
        return;
      }
      if (!moved) return;
      // Same folder as before: just moved, but never left covering something.
      const parents = new Set(top.map((t) => t.parent));
      if (canEdit && parents.size === 1) {
        const parent = [...parents][0]!;
        const { positions: planned } = planMove({
          deliverableIds: top.filter((t) => t.kind === "deliverable").map((t) => t.id),
          groupIds: top.filter((t) => t.kind === "folder").map((t) => t.id),
          target: parent,
          positions: finalPos,
          start: null,
        });
        for (const [id, at] of planned) finalPos.set(id, at);
      }
      commitPositions(finalPos);
      void actions.layout(layoutOf(finalPos));
    },
    // groupOnto and moveDragged read the latest folders and names; they're rebuilt with this handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [absOf, folderMap, byId, groupOf, toFlow, canEdit, commitPositions, actions, names, posOf, sizeOf, restore],
  );

  // ── Selection, folders without dragging, the context menu ──────────────────

  const selectedFolders = useMemo(() => [...selectedIds].filter(isFolderNode).map(folderIdOf).filter((id) => folderMap.has(id)), [selectedIds, folderMap]);
  const selectedDeliverables = useMemo(() => [...selectedIds].filter((id) => !isFolderNode(id) && byId.has(id)), [selectedIds, byId]);
  const selectedCount = selectedFolders.length + selectedDeliverables.length;

  const [renameKey, setRenameKey] = useState(0);
  const selectFolder = (id: string | undefined, rename = false) => {
    if (!id) return;
    setSelectedIds(new Set([folderNodeId(id)]));
    setSelectedEdge(null);
    if (rename) setRenameKey((k) => k + 1);
  };

  /** A folder around whatever's selected (in their shared folder, else at the top level). */
  const groupSelection = () => {
    if (!canEdit || !selectedCount) return;
    const parents = new Set<string | null>([...selectedDeliverables.map((id) => groupOf(byId.get(id)!)), ...selectedFolders.map((id) => folderMap.get(id)!.parentId)]);
    const parentId = parents.size === 1 ? [...parents][0]! : null;
    // Folders already inside another selected folder travel with it.
    const groupIds = selectedFolders.filter((id) => !selectedFolders.some((other) => other !== id && folderAncestors(folderMap, id).includes(other)));
    const deliverableIds = selectedDeliverables.filter((id) => !groupIds.some((g) => folderDescendants(folderList, items, g).itemIds.includes(id)));
    const name = nameFor(selectedDeliverables.map((id) => byId.get(id)!), parentId);
    const what = describe([...deliverableIds.map((id) => names.get(id) ?? "?"), ...groupIds.map((id) => folderMap.get(id)?.name ?? "?")]);
    // Gathered together where the selection starts, so the folder holds exactly what's in it.
    const { positions, before } = planMove({ deliverableIds, groupIds, target: parentId, newFolder: true, pack: true });
    commitPositions(positions);
    actions
      .createFolder({ name, parentId, deliverableIds, groupIds, positions: layoutOf(positions) })
      .then((detail) => {
        const created = detail.deliverableGroups.find((g) => !folderMap.has(g.id));
        selectFolder(created?.id);
        toast.success(`Put ${what} in ${quote(name)}.`, {
          description: "Select the folder to rename it or change its colour.",
          action: {
            label: "Undo",
            onClick: () => {
              const undo = created && foldersRef.current.has(created.id) ? actions.ungroup(created.id) : Promise.resolve();
              void undo
                .then(() => {
                  commitPositions(before);
                  return before.size ? actions.layout(layoutOf(before)) : undefined;
                })
                .catch(() => {});
            },
          },
        });
      })
      .catch(() => commitPositions(before));
  };
  /** A new folder around one deliverable, where it is. */
  const folderAround = (d: DeliverableDTO) => {
    const name = nameFor([d], groupOf(d));
    const { positions } = planMove({ deliverableIds: [d.id], groupIds: [], target: groupOf(d), newFolder: true, place: { deliverableIds: [], groupIds: [] } });
    commitPositions(positions);
    actions
      .createFolder({ name, parentId: groupOf(d), deliverableIds: [d.id], positions: layoutOf(positions) })
      .then((detail) => {
        const created = detail.deliverableGroups.find((g) => !folderMap.has(g.id));
        selectFolder(created?.id, true);
        toast.success(`Put ${quote(d.name)} in ${quote(name)}.`, { action: { label: "Undo", onClick: () => created && void actions.ungroup(created.id).catch(() => {}) } });
      })
      .catch(() => {});
  };
  const moveOne = (item: { kind: "deliverable" | "folder"; id: string; name: string; parent: string | null }, target: string | null) => {
    if (target === item.parent) return;
    const fromName = item.parent ? folderMap.get(item.parent)?.name : null;
    const ids = { deliverableIds: item.kind === "deliverable" ? [item.id] : [], groupIds: item.kind === "folder" ? [item.id] : [] };
    // Next to what's already in the folder (or just outside the one it leaves), never on top of anything.
    const { positions, before } = planMove({ ...ids, target });
    commitPositions(positions);
    actions
      .moveToFolder({ ...ids, targetGroupId: target, positions: layoutOf(positions) })
      .then((detail) => {
        const removed = item.parent && !detail.deliverableGroups.some((g) => g.id === item.parent) ? fromName : null;
        toast.success(target ? `Moved ${quote(item.name)} into ${quote(folderMap.get(target)?.name ?? "folder")}.` : fromName ? `Moved ${quote(item.name)} out of ${quote(fromName)}.` : `Moved ${quote(item.name)} to the top level.`, {
          description: removed ? `${quote(removed)} was left empty, so it's gone.` : undefined,
          action: {
            label: "Undo",
            onClick: () => {
              const back = item.parent && foldersRef.current.has(item.parent) ? item.parent : null;
              commitPositions(before);
              void actions.moveToFolder({ ...ids, targetGroupId: back, positions: before.size ? layoutOf(before) : undefined }).catch(() => {});
            },
          },
        });
      })
      .catch(() => commitPositions(before));
  };
  /** Several at once into a folder (or the top level), packed together beside what's there. */
  const moveMany = (deliverableIds: string[], groupIds: string[], target: string | null) => {
    const okGroups = groupIds.filter((id) => !target || !folderContains(folderMap, id, target));
    if (!deliverableIds.length && !okGroups.length) return Promise.resolve();
    const { positions, before } = planMove({ deliverableIds, groupIds: okGroups, target, pack: true });
    commitPositions(positions);
    return actions.moveToFolder({ deliverableIds, groupIds: okGroups, targetGroupId: target, positions: layoutOf(positions) }).catch((e) => {
      commitPositions(before);
      throw e;
    });
  };
  /** Lays a folder's contents out in neat rows (sub-folders keep their own layout), then makes room around it. */
  const tidyFolder = (f: DeliverableGroupDTO) => {
    const frame = frames.get(f.id);
    if (!frame || f.collapsed) return;
    const plan: Plan = { positions: new Map(), parentOf: new Map(), folderParent: new Map() };
    const w = world(plan);
    const blocks = [
      ...w.itemsH.filter((i) => i.groupId === f.id).map((i) => ({ rect: i.rect, itemIds: [i.id] })),
      ...w.foldersH.filter((x) => x.parentId === f.id).flatMap((x) => (w.framesH.has(x.id) ? [{ rect: w.framesH.get(x.id)!, itemIds: folderDescendants(w.foldersH, w.itemsH, x.id).itemIds }] : [])),
    ].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const spots = packBlocks(
      blocks.map((b) => b.rect),
      { x: frame.x + FOLDER_PAD, y: frame.y + FOLDER_PAD + FOLDER_HEADER },
    );
    blocks.forEach((b, i) => shiftItems(plan, b.itemIds, spots[i]!.x - b.rect.x, spots[i]!.y - b.rect.y));
    settle(plan, f.id);
    const positions = new Map<string, Point>();
    const before = new Map<string, Point>();
    for (const [id, p] of plan.positions) {
      const d = byId.get(id);
      if (!d) continue;
      const was = posOf(d);
      if (Math.abs(was.x - p.x) > 0.5 || Math.abs(was.y - p.y) > 0.5) {
        positions.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
        before.set(id, was);
      }
    }
    if (!positions.size) {
      toast(`${quote(f.name)} is already tidy.`);
      return;
    }
    commitPositions(positions);
    void actions.layout(layoutOf(positions)).then(() =>
      toast.success(`Tidied ${quote(f.name)}.`, {
        action: {
          label: "Undo",
          onClick: () => {
            commitPositions(before);
            void actions.layout(layoutOf(before));
          },
        },
      }),
    );
  };
  const ungroupFolder = (f: DeliverableGroupDTO) => {
    actions
      .ungroup(f.id)
      .then(() => {
        setSelectedIds((s) => {
          const next = new Set(s);
          next.delete(folderNodeId(f.id));
          return next;
        });
        toast.success(`Ungrouped ${quote(f.name)}.`, { description: "What was inside stays where it is." });
      })
      .catch(() => {});
  };
  /** Ctrl/⌘+Shift+G: folders dissolve; deliverables leave their folder (one level up). */
  const ungroupSelection = () => {
    if (!canEdit) return;
    for (const id of selectedFolders) ungroupFolder(folderMap.get(id)!);
    for (const id of selectedDeliverables) {
      const d = byId.get(id)!;
      const parent = groupOf(d);
      if (parent) moveOne({ kind: "deliverable", id, name: d.name, parent }, folderMap.get(parent)?.parentId ?? null);
    }
  };

  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void }, nodeId: string) => {
    event.preventDefault();
    const rect = wrapper.current?.getBoundingClientRect();
    setMenu({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0), nodeId });
    // The menu acts on the node under the pointer; if it isn't part of the selection, it becomes it.
    setSelectedIds((s) => (s.has(nodeId) ? s : new Set([nodeId])));
    setSelectedEdge(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      if (e.shiftKey) ungroupSelection();
      else groupSelection();
    }
  };

  const selected = selectedEdge ? links.find((l) => l.id === selectedEdge) : null;
  const selectedDeliverable = selectedCount === 1 && selectedDeliverables[0] ? byId.get(selectedDeliverables[0]) : null;
  const selectedFolder = selectedCount === 1 && selectedFolders[0] ? folderMap.get(selectedFolders[0]) : null;
  const [archiving, setArchiving] = useState<DeliverableDTO | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const confirmArchive = () => {
    const d = archiving;
    if (!d) return;
    setArchivePending(true);
    actions
      .archive(d.id, true)
      .then(() => {
        setArchiving(null);
        setSelectedIds(new Set());
        toast.success(`Archived “${byId.get(d.id)?.name ?? d.name}”.`, {
          description: "Its revisions, reviews and comments are kept.",
          action: { label: "Undo", onClick: () => void actions.archive(d.id, false).catch(() => {}) },
        });
      })
      // The error is already shown; the dialog stays open to try again or cancel.
      .catch(() => {})
      .finally(() => setArchivePending(false));
  };
  const initialViewport = savedViewports.get(card.id);
  const fitted = useRef(Boolean(initialViewport));

  useEffect(() => {
    if (fitted.current || !deliverables.length) return;
    fitted.current = true;
    requestAnimationFrame(() => void flow.fitView({ padding: 0.25, maxZoom: 1.1 }));
  }, [deliverables.length, flow]);

  // Bring newly added deliverables into view if they landed outside the visible area.
  const knownIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const previous = knownIds.current;
    knownIds.current = new Set(deliverables.map((d) => d.id));
    if (!previous || !wrapper.current) return;
    const added = deliverables.filter((d) => !previous.has(d.id));
    if (!added.length) return;
    const { x, y, zoom } = flow.getViewport();
    const { width, height } = wrapper.current.getBoundingClientRect();
    const hidden = added.some((d) => {
      const s = sizeOf(d);
      const left = d.canvasX * zoom + x;
      const top = d.canvasY * zoom + y;
      return left < 0 || top < 0 || left + s.w * zoom > width || top + s.h * zoom > height;
    });
    if (hidden) requestAnimationFrame(() => void flow.fitView({ padding: 0.25, maxZoom: 1.1, duration: 300 }));
  }, [deliverables, flow, sizeOf]);

  /** Size controls (no dragging needed): grow/shrink by a step, or back to the default size. */
  const resizeBy = (d: DeliverableDTO, dw: number, dh: number) => {
    const current = sizeOf(d);
    const size = clampSize(current.w + dw, current.h + dh);
    const at = posOf(d);
    setSizing((m) => new Map(m).set(d.id, { ...at, ...size }));
    void actions.layout([{ id: d.id, w: size.w, h: size.h }]);
  };
  const resetSize = (d: DeliverableDTO) => {
    setSizing((m) => {
      const next = new Map(m);
      next.delete(d.id);
      return next;
    });
    void actions.layout([{ id: d.id, w: null, h: null }]);
  };

  const menuNode = menu ? (isFolderNode(menu.nodeId) ? { folder: folderMap.get(folderIdOf(menu.nodeId)) } : { deliverable: byId.get(menu.nodeId) }) : null;
  const menuTargets = (except?: string | null) => folderChoices(folderList, folderMap, except);

  return (
    <div ref={wrapper} className={cn("relative h-full w-full", connecting && "canvas-connecting")} onKeyDown={onKeyDown}>
      <ReactFlow<CanvasNode, LinkEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={initialViewport ?? { x: 40, y: 40, zoom: 0.9 }}
        minZoom={0.2}
        maxZoom={2}
        onlyRenderVisibleElements={deliverables.length > 60}
        nodesDraggable={canEdit}
        // Over something you can drop onto, the view holds still instead of panning away under you.
        autoPanOnNodeDrag={!dropTarget}
        nodesConnectable={canEdit}
        // Any point can start or end an arrow; the direction is the way it was drawn.
        connectionMode={ConnectionMode.Loose}
        edgesReconnectable={canEdit}
        onReconnect={onReconnect}
        elementsSelectable
        // Shift-, Ctrl- or ⌘-click adds to the selection; Shift-drag on the background draws a selection box.
        multiSelectionKeyCode={["Shift", "Control", "Meta"]}
        deleteKeyCode={null}
        colorMode={colorMode}
        attributionPosition="top-right"
        onNodesChange={onNodesChange}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onMoveEnd={(_, viewport) => savedViewports.set(card.id, viewport)}
        onNodeClick={() => setSelectedEdge(null)}
        onNodeDoubleClick={(_, node) => !isFolderNode(node.id) && onOpen(node.id)}
        onNodeContextMenu={(event, node) => openMenu(event, node.id)}
        onEdgeClick={(_, edge) => {
          setSelectedEdge(edge.id);
          setSelectedIds(new Set());
        }}
        onPaneClick={() => {
          setSelectedIds(new Set());
          setSelectedEdge(null);
        }}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={(c) => c.source !== c.target && !isFolderNode(c.source ?? "") && !isFolderNode(c.target ?? "")}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable className="!hidden md:!block [@media(max-height:600px)]:!hidden" nodeColor={(n) => (n.type === "folder" ? ((n.data as FolderNodeData).folder.color ?? "var(--border-strong)") : CARD_STATE_META[(n.data as DeliverableNodeData).deliverable.state].color)} />
        <Panel position="top-left" className="!m-2 rounded-md border border-border bg-surface-2/90 px-2 py-1 text-[11px] text-fg-muted backdrop-blur">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-5 bg-state-review" /> requires (arrow → dependant)
          </span>
          <span className="ml-3 inline-flex items-center gap-1">
            <span className="inline-block w-5 border-t-2 border-dashed border-fg-subtle" /> related
          </span>
          {canEdit ? (
            <span className="ml-3 hidden sm:inline">Drag from any dot on a deliverable to another to connect. Drop a deliverable onto another to group them in a folder; drag it out past the folder&apos;s edge to take it out.</span>
          ) : null}
        </Panel>
      </ReactFlow>

      {/* Right-click (or long-press) menu for the node under the pointer. */}
      {menu ? (
        <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)} modal={false}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="absolute size-px" style={{ left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" sideOffset={2} onCloseAutoFocus={(e) => e.preventDefault()}>
            {canEdit && selectedCount > 1 && selectedIds.has(menu.nodeId) ? (
              <>
                <DropdownMenuItem onSelect={groupSelection} shortcut="Ctrl+G">
                  <FolderPlus /> Group {selectedCount} selected
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {menuNode && "deliverable" in menuNode && menuNode.deliverable ? (
              (() => {
                const d = menuNode.deliverable;
                const parent = groupOf(d);
                return (
                  <>
                    <DropdownMenuItem onSelect={() => onOpen(d.id)}>
                      <ArrowRight /> Open
                    </DropdownMenuItem>
                    {canEdit ? (
                      <>
                        <DropdownMenuItem
                          onSelect={() => {
                            setSelectedIds(new Set([d.id]));
                            setRenameKey((k) => k + 1);
                          }}
                        >
                          <Pencil /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuNested
                          label={
                            <>
                              <FolderInput /> Move to folder
                            </>
                          }
                        >
                          <DropdownMenuItem disabled={!parent} onSelect={() => moveOne({ kind: "deliverable", id: d.id, name: d.name, parent }, null)}>
                            No folder (top level)
                          </DropdownMenuItem>
                          {menuTargets().map((c) => (
                            <DropdownMenuItem key={c.value} disabled={c.value === parent} onSelect={() => moveOne({ kind: "deliverable", id: d.id, name: d.name, parent }, c.value)}>
                              <span style={{ paddingLeft: c.depth * 10 }}>{folderMap.get(c.value)?.name}</span>
                              {c.value === parent ? <Check className="ml-auto !text-accent" /> : null}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => folderAround(d)}>
                            <FolderPlus /> New folder around it
                          </DropdownMenuItem>
                        </DropdownMenuNested>
                        {parent ? (
                          <DropdownMenuItem onSelect={() => moveOne({ kind: "deliverable", id: d.id, name: d.name, parent }, folderMap.get(parent)?.parentId ?? null)}>
                            <FolderOutput /> Move out of {quote(folderMap.get(parent)?.name ?? "folder")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={deliverables.length <= 1} onSelect={() => setArchiving(d)}>
                          <Archive /> Archive
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </>
                );
              })()
            ) : menuNode && "folder" in menuNode && menuNode.folder ? (
              (() => {
                const f = menuNode.folder;
                return (
                  <>
                    <DropdownMenuItem onSelect={() => toggleFolder(f.id)}>
                      {f.collapsed ? <ChevronRight /> : <ChevronDown />} {f.collapsed ? "Expand" : "Collapse"}
                    </DropdownMenuItem>
                    {canEdit ? (
                      <>
                        <DropdownMenuItem onSelect={() => selectFolder(f.id, true)}>
                          <Pencil /> Rename
                        </DropdownMenuItem>
                        {!f.collapsed ? (
                          <DropdownMenuItem onSelect={() => tidyFolder(f)}>
                            <LayoutGrid /> Tidy up
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuNested
                          label={
                            <>
                              <FolderInput /> Move to folder
                            </>
                          }
                        >
                          <DropdownMenuItem disabled={!f.parentId} onSelect={() => moveOne({ kind: "folder", id: f.id, name: f.name, parent: f.parentId }, null)}>
                            No folder (top level)
                          </DropdownMenuItem>
                          {menuTargets(f.id).map((c) => (
                            <DropdownMenuItem key={c.value} disabled={c.value === f.parentId} onSelect={() => moveOne({ kind: "folder", id: f.id, name: f.name, parent: f.parentId }, c.value)}>
                              <span style={{ paddingLeft: c.depth * 10 }}>{folderMap.get(c.value)?.name}</span>
                              {c.value === f.parentId ? <Check className="ml-auto !text-accent" /> : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuNested>
                        {f.parentId ? (
                          <DropdownMenuItem onSelect={() => moveOne({ kind: "folder", id: f.id, name: f.name, parent: f.parentId }, folderMap.get(f.parentId!)?.parentId ?? null)}>
                            <FolderOutput /> Move out of {quote(folderMap.get(f.parentId)?.name ?? "folder")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => ungroupFolder(f)} shortcut="Ctrl+Shift+G">
                          <Ungroup /> Ungroup
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </>
                );
              })()
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {selected ? (
        <div className="absolute bottom-3 right-3 z-10 w-[min(360px,calc(100%-24px))] rounded-lg border border-border-strong bg-surface-2 p-3 shadow-lg" role="dialog" aria-label="Connection details">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-[13px]">
              {selected.type === "DEPENDENCY" ? (
                <>
                  <strong>{names.get(selected.toId)}</strong> requires <strong>{names.get(selected.fromId)}</strong>.{" "}
                  {byId.get(selected.fromId)?.state === "APPROVED" ? (
                    <span className="text-state-approved">The prerequisite is approved.</span>
                  ) : (
                    <span className="text-state-review">
                      Blocked — {names.get(selected.fromId)} is {CARD_STATE_META[byId.get(selected.fromId)!.state].label.toLowerCase()}.
                    </span>
                  )}
                </>
              ) : (
                <>
                  <strong>{names.get(selected.fromId)}</strong> and <strong>{names.get(selected.toId)}</strong> are related (non-blocking).
                </>
              )}
            </p>
            <PanelClose onClick={() => setSelectedEdge(null)} />
          </div>
          {selected.note ? <p className="mt-1 text-[12px] text-fg-muted">“{selected.note}”</p> : null}
          {canEdit && byId.get(selected.fromId) && byId.get(selected.toId) ? (
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {(
                [
                  ["fromPoint", selected.fromId, selected.fromPoint, DEFAULT_FROM_POINT, "Leaves"],
                  ["toPoint", selected.toId, selected.toPoint, DEFAULT_TO_POINT, "Arrives at"],
                ] as const
              ).map(([key, id, point, fallback, label]) => {
                const size = sizeOf(byId.get(id)!);
                return (
                  <label key={key} className="grid gap-0.5 text-[11px] text-fg-subtle">
                    {label} {names.get(id)}
                    <Select<string>
                      aria-label={`${label} ${names.get(id)}: connection point`}
                      value={remapPoint(point, size, fallback)}
                      onValueChange={(v) => actions.setPoints(selected.id, { [key]: v })}
                      options={availablePoints(size).map((p) => ({ value: p, label: pointLabel(p) }))}
                      className="h-7"
                    />
                  </label>
                );
              })}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="xs" variant="secondary" onClick={() => onOpen(selected.fromId)}>
              Open {names.get(selected.fromId)}
            </Button>
            <Button size="xs" variant="secondary" onClick={() => onOpen(selected.toId)}>
              Open {names.get(selected.toId)}
            </Button>
            {canEdit ? (
              <>
                <Button size="xs" variant="ghost" onClick={() => actions.reverse(selected.id)}>
                  <ArrowLeftRight /> Reverse
                </Button>
                <Button
                  size="xs"
                  variant="danger-ghost"
                  onClick={() => {
                    actions.unlink(selected.id);
                    setSelectedEdge(null);
                  }}
                >
                  <Trash2 /> Remove
                </Button>
              </>
            ) : null}
          </div>
          <p className="mt-2 text-[11px] text-fg-subtle">Removing a connection never changes either deliverable&apos;s files, reviews or history.</p>
        </div>
      ) : selectedCount > 1 ? (
        <div className={PANEL} role="dialog" aria-label="Selection">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[13px] font-semibold">{selectedCount} selected</p>
            <PanelClose onClick={() => setSelectedIds(new Set())} />
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {[selectedDeliverables.length ? `${selectedDeliverables.length} deliverable${selectedDeliverables.length === 1 ? "" : "s"}` : null, selectedFolders.length ? `${selectedFolders.length} folder${selectedFolders.length === 1 ? "" : "s"}` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {canEdit ? (
            <div className="mt-2 grid gap-1.5">
              <Button size="xs" variant="primary" onClick={groupSelection} title="Ctrl+G">
                <FolderPlus /> Group in a new folder
              </Button>
              <label className="grid gap-0.5 text-[11px] text-fg-subtle">
                Move all to
                <MoveToFolderSelect
                  folders={folderList}
                  byId={folderMap}
                  value={null}
                  label="Move selection to folder"
                  onChange={(target) => {
                    if (target === NEW_FOLDER) return;
                    moveMany(selectedDeliverables, selectedFolders, target)
                      .then(() => toast.success(target ? `Moved ${selectedCount} items into ${quote(folderMap.get(target)?.name ?? "folder")}.` : `Moved ${selectedCount} items to the top level.`))
                      .catch(() => {});
                  }}
                />
              </label>
              <p className="text-[11px] text-fg-subtle">Shift-click, or Shift-drag a box on the canvas, to select several. Ctrl+Shift+G takes them out of their folders.</p>
            </div>
          ) : null}
        </div>
      ) : selectedFolder ? (
        <div className={PANEL} role="dialog" aria-label="Folder summary">
          <div className="flex items-start gap-2">
            <SummaryName key={selectedFolder.id} name={selectedFolder.name} label="Folder name" maxLength={60} canEdit={canEdit} editKey={renameKey} onRename={(name) => void actions.updateFolder(selectedFolder.id, { name })} />
            <PanelClose onClick={() => setSelectedIds(new Set())} />
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">{folderSummary(contents.get(selectedFolder.id)?.count ?? 0, contents.get(selectedFolder.id)?.states ?? [])}</p>
          {selectedFolder.parentId ? (
            <p className="mt-1 flex items-center gap-1 text-[12px] text-fg-muted">
              Inside <FolderBreadcrumb folders={folderMap} folderId={selectedFolder.parentId} className="text-[12px]" />
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => toggleFolder(selectedFolder.id)} aria-expanded={!selectedFolder.collapsed}>
              {selectedFolder.collapsed ? <ChevronRight /> : <ChevronDown />} {selectedFolder.collapsed ? "Expand" : "Collapse"}
            </Button>
            {canEdit ? <FolderColorPicker folder={selectedFolder} canEdit onChange={(color) => void actions.updateFolder(selectedFolder.id, { color })} /> : null}
            {canEdit && !selectedFolder.collapsed ? (
              <Button size="xs" variant="ghost" onClick={() => tidyFolder(selectedFolder)} title="Lay out what's inside in neat rows">
                <LayoutGrid /> Tidy
              </Button>
            ) : null}
          </div>
          {canEdit ? (
            <>
              <label className="mt-2 grid gap-0.5 text-[11px] text-fg-subtle">
                Folder
                <MoveToFolderSelect
                  folders={folderList}
                  byId={folderMap}
                  value={selectedFolder.parentId}
                  exceptFolderId={selectedFolder.id}
                  label={`Move ${selectedFolder.name} to folder`}
                  onChange={(target) => target !== NEW_FOLDER && moveOne({ kind: "folder", id: selectedFolder.id, name: selectedFolder.name, parent: selectedFolder.parentId }, target)}
                />
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <AddToFolderPopover folder={selectedFolder} deliverables={deliverables} byId={folderMap} onAdd={(ids) => moveMany(ids, [], selectedFolder.id).then(() => toast.success(`Added ${ids.length} to ${quote(selectedFolder.name)}.`))} />
                <Button size="xs" variant="ghost" onClick={() => ungroupFolder(selectedFolder)} title="Ctrl+Shift+G">
                  <Ungroup /> Ungroup
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-fg-subtle">Ungrouping keeps every deliverable where it is; only the folder goes. A folder left empty goes by itself.</p>
            </>
          ) : null}
        </div>
      ) : selectedDeliverable ? (
        <div className={PANEL} role="dialog" aria-label="Deliverable summary">
          <div className="flex items-start gap-2">
            <SummaryName key={selectedDeliverable.id} name={selectedDeliverable.name} label="Deliverable name" maxLength={120} canEdit={canEdit} editKey={renameKey} onRename={(name) => actions.rename(selectedDeliverable.id, name)} />
            <PanelClose onClick={() => setSelectedIds(new Set())} />
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {selectedDeliverable.versionCount ? `${selectedDeliverable.versionCount} revision${selectedDeliverable.versionCount === 1 ? "" : "s"}` : "No revisions yet"}
            {selectedDeliverable.blockedBy.length ? ` · waiting on ${selectedDeliverable.blockedBy.map((id) => names.get(id)).join(", ")}` : ""}
          </p>
          {selectedDeliverable.description.trim() ? (
            <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-[12px] text-fg-muted">{selectedDeliverable.description}</p>
          ) : null}
          {canEdit ? (
            <div className="mt-2">
              <DeliverableCoverControl key={selectedDeliverable.id} deliverable={selectedDeliverable} compact />
              <div className="mt-1">
                <DeliverableColorPicker deliverable={selectedDeliverable} compact />
              </div>
            </div>
          ) : null}
          {canEdit || groupOf(selectedDeliverable) ? (
            <div className="mt-2 grid gap-1">
              {canEdit ? (
                <label className="grid gap-0.5 text-[11px] text-fg-subtle">
                  Folder
                  <MoveToFolderSelect
                    folders={folderList}
                    byId={folderMap}
                    value={groupOf(selectedDeliverable)}
                    allowNew
                    label={`Folder of ${selectedDeliverable.name}`}
                    onChange={(target) => (target === NEW_FOLDER ? folderAround(selectedDeliverable) : moveOne({ kind: "deliverable", id: selectedDeliverable.id, name: selectedDeliverable.name, parent: groupOf(selectedDeliverable) }, target))}
                  />
                </label>
              ) : (
                <p className="flex items-center gap-1 text-[12px] text-fg-muted">
                  In <FolderBreadcrumb folders={folderMap} folderId={groupOf(selectedDeliverable)} className="text-[12px]" />
                </p>
              )}
              {canEdit && groupOf(selectedDeliverable) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="justify-start"
                  onClick={() => {
                    const parent = groupOf(selectedDeliverable)!;
                    moveOne({ kind: "deliverable", id: selectedDeliverable.id, name: selectedDeliverable.name, parent }, folderMap.get(parent)?.parentId ?? null);
                  }}
                >
                  <FolderOutput /> Move out of {quote(folderMap.get(groupOf(selectedDeliverable)!)?.name ?? "folder")}
                </Button>
              ) : null}
              {groupOf(selectedDeliverable) ? (
                // The folder's own panel without having to hit its title bar (tiny on a phone when zoomed out).
                <Button size="xs" variant="ghost" className="justify-start" onClick={() => selectFolder(groupOf(selectedDeliverable)!)}>
                  <FolderOpen /> Open folder {quote(folderMap.get(groupOf(selectedDeliverable)!)?.name ?? "folder")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {canEdit ? (
            <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label={`Size of ${selectedDeliverable.name}`}>
              <span className="mr-1 text-[11px] text-fg-subtle">
                Size {Math.round(sizeOf(selectedDeliverable).w)}×{Math.round(sizeOf(selectedDeliverable).h)}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="Narrower" onClick={() => resizeBy(selectedDeliverable, -SIZE_STEP, 0)}>
                <Minus />
              </Button>
              <span className="text-[11px] text-fg-subtle">W</span>
              <Button size="icon-sm" variant="ghost" aria-label="Wider" onClick={() => resizeBy(selectedDeliverable, SIZE_STEP, 0)}>
                <Plus />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Shorter" onClick={() => resizeBy(selectedDeliverable, 0, -SIZE_STEP)}>
                <Minus />
              </Button>
              <span className="text-[11px] text-fg-subtle">H</span>
              <Button size="icon-sm" variant="ghost" aria-label="Taller" onClick={() => resizeBy(selectedDeliverable, 0, SIZE_STEP)}>
                <Plus />
              </Button>
              {selectedDeliverable.canvasW !== null || sizing.has(selectedDeliverable.id) ? (
                <Button size="icon-sm" variant="ghost" aria-label="Default size" title="Default size" onClick={() => resetSize(selectedDeliverable)}>
                  <RotateCcw />
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="primary" onClick={() => onOpen(selectedDeliverable.id)}>
              Open deliverable <ArrowRight />
            </Button>
            {canEdit ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={deliverables.length <= 1}
                title={deliverables.length <= 1 ? "A card needs at least one deliverable — archive the card instead." : undefined}
                onClick={() => setArchiving(selectedDeliverable)}
              >
                <Archive /> Archive
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && !archivePending && setArchiving(null)}
        title={`Archive ${archiving ? (byId.get(archiving.id)?.name ?? archiving.name) : "deliverable"}?`}
        confirmLabel="Archive"
        loading={archivePending}
        onConfirm={confirmArchive}
        description="It leaves the card's progress and canvas. Its revisions, reviews and comments are kept, and you can restore it under Archived deliverables."
      />

      <ConnectDialog
        pending={pendingConnection}
        names={names}
        onCancel={() => setPendingConnection(null)}
        onConfirm={(type, note) => {
          const c = pendingConnection;
          setPendingConnection(null);
          if (c) void actions.link({ ...c, type, note: note.trim() || undefined });
        }}
      />
    </div>
  );
}

export default function DeliverableCanvas(props: { deliverables: DeliverableDTO[]; folders: DeliverableGroupDTO[]; links: DeliverableLinkDTO[]; canEdit: boolean; actions: CanvasActions; onOpen: (id: string) => void }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
