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
import { ArrowLeftRight, ArrowRight, Link2, Lock, MessageSquareWarning, Minus, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import type { DeliverableDTO, DeliverableLinkDTO, DeliverableLinkType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { KIND_ICONS } from "../domain/production";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Textarea } from "../ui/input";
import { DeliverableWork } from "./deliverable-work";
import { useWorkspace } from "./workspace-context";

/** Canvas viewport per card, so returning from a deliverable lands where you left. */
const savedViewports = new Map<string, Viewport>();
const SIZE_STEP = 40;
const CORNERS: ControlPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const SIDE_POSITION: Record<Side, Position> = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left };

type Size = { w: number; h: number };
type DeliverableNodeData = {
  deliverable: DeliverableDTO;
  blockedNames: string[];
  selected: boolean;
  canEdit: boolean;
  /** Explicit size: the node is drawn at it; otherwise it's as tall as its content. */
  fixedHeight: boolean;
  points: string[];
  onOpen: (id: string) => void;
  onResize: (id: string, params: ResizeParams) => void;
  onResizeEnd: (id: string, params: ResizeParams) => void;
};
type DeliverableNode = Node<DeliverableNodeData, "deliverable">;
type LinkEdgeData = { link: DeliverableLinkDTO; satisfied: boolean; onSelect: (id: string) => void; selected: boolean };
type LinkEdge = Edge<LinkEdgeData, "link">;

/** Where a connection point sits on the node's edge. */
function pointStyle(id: string) {
  const p = parsePoint(id)!;
  const at = `${pointFraction(p.pct) * 100}%`;
  return p.side === "t" || p.side === "b" ? { left: at } : { top: at };
}

const DeliverableNodeView = memo(function DeliverableNodeView({ data }: NodeProps<DeliverableNode>) {
  const { deliverable: d, blockedNames, onOpen } = data;
  const kind = d.kinds.find((k) => k !== "FILE") ?? d.kinds[0];
  const KindIcon = kind ? KIND_ICONS[kind] : null;
  const attention = d.state === "NEEDS_REVIEW" ? "ring-2 ring-state-review/60" : d.state === "CHANGES_REQUESTED" ? "ring-2 ring-state-changes/60" : "";
  const description = d.description.trim();
  return (
    <div
      onDoubleClick={() => onOpen(d.id)}
      className={cn("flex h-full w-full flex-col rounded-lg border border-border-strong bg-surface-2 text-left shadow-md", attention, data.selected && "outline outline-2 outline-accent")}
      style={{ borderLeft: `3px solid ${CARD_STATE_META[d.state].color}` }}
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

const nodeTypes = { deliverable: DeliverableNodeView };
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

function Canvas({ deliverables, links, canEdit, actions, onOpen }: { deliverables: DeliverableDTO[]; links: DeliverableLinkDTO[]; canEdit: boolean; actions: CanvasActions; onOpen: (id: string) => void }) {
  const { card } = useWorkspace();
  const flow = useReactFlow();
  // Local layout while dragging/resizing (and until the saved values come back).
  const [moving, setMoving] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [sizing, setSizing] = useState<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());
  const [connecting, setConnecting] = useState(false);
  // Sizes xyflow measured. Handing them back keeps nodes (and their handles) measured when we
  // rebuild node objects — otherwise every update hides and re-measures them for a frame.
  const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(new Map());
  const onNodesChange = useCallback((changes: NodeChange<DeliverableNode>[]) => {
    setMeasured((current) => {
      let next: Map<string, { width: number; height: number }> | null = null;
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const known = current.get(change.id);
        if (known && known.width === change.dimensions.width && known.height === change.dimensions.height) continue;
        next ??= new Map(current);
        next.set(change.id, change.dimensions);
      }
      return next ?? current;
    });
  }, []);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ fromId: string; toId: string; fromPoint: string | null; toPoint: string | null } | null>(null);
  const byId = useMemo(() => new Map(deliverables.map((d) => [d.id, d])), [deliverables]);
  const names = useMemo(() => new Map(deliverables.map((d) => [d.id, d.name])), [deliverables]);
  const activeIds = useMemo(() => new Set(deliverables.map((d) => d.id)), [deliverables]);
  const [colorMode] = useState<"light" | "dark">(() => (typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark"));

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

  const onResize = useCallback((id: string, p: ResizeParams) => setSizing((m) => new Map(m).set(id, { x: p.x, y: p.y, w: p.width, h: p.height })), []);
  const onResizeEnd = useCallback(
    (id: string, p: ResizeParams) => {
      const size = clampSize(p.width, p.height);
      setSizing((m) => new Map(m).set(id, { x: p.x, y: p.y, ...size }));
      void actions.layout([{ id, x: p.x, y: p.y, w: size.w, h: size.h }]);
    },
    [actions],
  );

  const nodes: DeliverableNode[] = useMemo(
    () =>
      deliverables.map((d) => {
        const live = sizing.get(d.id);
        const fixed = Boolean(live) || d.canvasH !== null;
        const size = sizeOf(d);
        return {
          id: d.id,
          type: "deliverable",
          position: live ? { x: live.x, y: live.y } : (moving.get(d.id) ?? { x: d.canvasX, y: d.canvasY }),
          width: size.w,
          ...(fixed ? { height: size.h } : {}),
          measured: measured.get(d.id),
          data: {
            deliverable: d,
            blockedNames: d.blockedBy.map((id) => names.get(id) ?? "?"),
            selected: selectedNode === d.id,
            canEdit,
            fixedHeight: fixed,
            points: availablePoints(size),
            onOpen,
            onResize,
            onResizeEnd,
          },
          draggable: canEdit,
          connectable: canEdit,
          ariaLabel: `${d.name}, ${CARD_STATE_META[d.state].label}`,
        };
      }),
    [deliverables, sizing, moving, measured, names, selectedNode, canEdit, onOpen, onResize, onResizeEnd, sizeOf],
  );
  const edges: LinkEdge[] = useMemo(
    () =>
      links
        .filter((l) => activeIds.has(l.fromId) && activeIds.has(l.toId))
        .map((l) => {
          const satisfied = byId.get(l.fromId)?.state === "APPROVED";
          return {
            id: l.id,
            source: l.fromId,
            target: l.toId,
            // Saved points, moved to the nearest remaining point if a node has since shrunk.
            sourceHandle: remapPoint(l.fromPoint, sizeOf(byId.get(l.fromId)!), DEFAULT_FROM_POINT),
            targetHandle: remapPoint(l.toPoint, sizeOf(byId.get(l.toId)!), DEFAULT_TO_POINT),
            type: "link",
            selected: selectedEdge === l.id,
            data: { link: l, satisfied, onSelect: setSelectedEdge, selected: selectedEdge === l.id },
            markerEnd: l.type === "DEPENDENCY" ? { type: MarkerType.ArrowClosed, color: satisfied ? "var(--state-approved)" : "var(--state-review)", width: 18, height: 18 } : undefined,
            ariaLabel: l.type === "DEPENDENCY" ? `${names.get(l.toId)} requires ${names.get(l.fromId)}` : `${names.get(l.fromId)} is related to ${names.get(l.toId)}`,
          };
        }),
    [links, activeIds, byId, selectedEdge, names, sizeOf],
  );

  // The arrow points from where the drag started to where it ended (prerequisite → dependant).
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    setPendingConnection({ fromId: c.source, toId: c.target, fromPoint: c.sourceHandle ?? null, toPoint: c.targetHandle ?? null });
  }, []);

  // Dragging an arrow end to another point of the same deliverable only moves where it attaches.
  const onReconnect = useCallback(
    (old: LinkEdge, next: Connection) => {
      if (next.source !== old.source || next.target !== old.target) {
        toast("Arrow ends can move to another point on the same deliverable. To connect different deliverables, draw a new arrow.");
        return;
      }
      if (next.sourceHandle === old.sourceHandle && next.targetHandle === old.targetHandle) return;
      actions.setPoints(old.id, { fromPoint: next.sourceHandle ?? undefined, toPoint: next.targetHandle ?? undefined });
    },
    [actions],
  );

  const selected = selectedEdge ? links.find((l) => l.id === selectedEdge) : null;
  const selectedDeliverable = selectedNode ? byId.get(selectedNode) : null;
  const initialViewport = savedViewports.get(card.id);
  const fitted = useRef(Boolean(initialViewport));

  useEffect(() => {
    if (fitted.current || !deliverables.length) return;
    fitted.current = true;
    requestAnimationFrame(() => void flow.fitView({ padding: 0.25, maxZoom: 1.1 }));
  }, [deliverables.length, flow]);

  // Bring newly added deliverables into view if they landed outside the visible area.
  const wrapper = useRef<HTMLDivElement>(null);
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
    setSizing((m) => new Map(m).set(d.id, { x: d.canvasX, y: d.canvasY, ...size }));
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

  return (
    <div ref={wrapper} className={cn("relative h-full w-full", connecting && "canvas-connecting")}>
      <ReactFlow<DeliverableNode, LinkEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={initialViewport ?? { x: 40, y: 40, zoom: 0.9 }}
        minZoom={0.2}
        maxZoom={2}
        onlyRenderVisibleElements={deliverables.length > 60}
        nodesDraggable={canEdit}
        nodesConnectable={canEdit}
        // Any point can start or end an arrow; the direction is the way it was drawn.
        connectionMode={ConnectionMode.Loose}
        edgesReconnectable={canEdit}
        onReconnect={onReconnect}
        elementsSelectable
        deleteKeyCode={null}
        colorMode={colorMode}
        attributionPosition="top-right"
        onNodesChange={onNodesChange}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onMoveEnd={(_, viewport) => savedViewports.set(card.id, viewport)}
        onNodeClick={(_, node) => {
          setSelectedNode(node.id);
          setSelectedEdge(null);
        }}
        onNodeDoubleClick={(_, node) => onOpen(node.id)}
        onEdgeClick={(_, edge) => {
          setSelectedEdge(edge.id);
          setSelectedNode(null);
        }}
        onPaneClick={() => {
          setSelectedNode(null);
          setSelectedEdge(null);
        }}
        onNodeDrag={(_, node) => setMoving((m) => new Map(m).set(node.id, node.position))}
        onNodeDragStop={(_, node, moved) => {
          const all = (moved?.length ? moved : [node]).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }));
          setMoving((m) => {
            const next = new Map(m);
            for (const n of all) next.set(n.id, { x: n.x, y: n.y });
            return next;
          });
          void actions.layout(all);
        }}
        onConnect={onConnect}
        isValidConnection={(c) => c.source !== c.target}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable className="!hidden md:!block" nodeColor={(n) => CARD_STATE_META[(n.data as DeliverableNodeData).deliverable.state].color} />
        <Panel position="top-left" className="!m-2 rounded-md border border-border bg-surface-2/90 px-2 py-1 text-[11px] text-fg-muted backdrop-blur">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-5 bg-state-review" /> requires (arrow → dependant)
          </span>
          <span className="ml-3 inline-flex items-center gap-1">
            <span className="inline-block w-5 border-t-2 border-dashed border-fg-subtle" /> related
          </span>
          {canEdit ? <span className="ml-3 hidden sm:inline">Drag from any dot on a deliverable to another to connect. Select a deliverable to resize it.</span> : null}
        </Panel>
      </ReactFlow>

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
            <button type="button" aria-label="Close" onClick={() => setSelectedEdge(null)} className="touch-target -m-1 flex size-7 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg">
              <X className="size-4" />
            </button>
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
      ) : selectedDeliverable ? (
        <div className="absolute bottom-3 right-3 z-10 w-[min(320px,calc(100%-24px))] rounded-lg border border-border-strong bg-surface-2 p-3 shadow-lg" role="dialog" aria-label="Deliverable summary">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-[13px] font-semibold">{selectedDeliverable.name}</p>
            <button type="button" aria-label="Close" onClick={() => setSelectedNode(null)} className="touch-target -m-1 flex size-7 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg">
              <X className="size-4" />
            </button>
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            {selectedDeliverable.versionCount ? `${selectedDeliverable.versionCount} revision${selectedDeliverable.versionCount === 1 ? "" : "s"}` : "No revisions yet"}
            {selectedDeliverable.blockedBy.length ? ` · waiting on ${selectedDeliverable.blockedBy.map((id) => names.get(id)).join(", ")}` : ""}
          </p>
          {selectedDeliverable.description.trim() ? (
            <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-[12px] text-fg-muted">{selectedDeliverable.description}</p>
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
          <div className="mt-2 flex gap-1.5">
            <Button size="xs" variant="primary" onClick={() => onOpen(selectedDeliverable.id)}>
              Open deliverable <ArrowRight />
            </Button>
          </div>
        </div>
      ) : null}

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

export default function DeliverableCanvas(props: { deliverables: DeliverableDTO[]; links: DeliverableLinkDTO[]; canEdit: boolean; actions: CanvasActions; onOpen: (id: string) => void }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
