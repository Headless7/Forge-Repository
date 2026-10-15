"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Ban, Check, ChevronDown, ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, Palette } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { FOLDER_COLLAPSED, FOLDER_HEADER, folderContains, folderDepth, folderPath, folderSummary } from "@/lib/canvas-folders";
import { availablePoints, parsePoint, pointFraction, pointLabel, type Side } from "@/lib/canvas-points";
import { CARD_STATE_META } from "@/lib/card-meta";
import { ACCENT_COLORS } from "@/lib/column-icons";
import type { CardState, DeliverableDTO, DeliverableGroupDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Checkbox, Select } from "../ui/controls";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { colorName } from "./deliverable-color";

export const folderNodeId = (id: string) => `folder:${id}`;
export const isFolderNode = (nodeId: string) => nodeId.startsWith("folder:");
export const folderIdOf = (nodeId: string) => nodeId.slice("folder:".length);
/** The value a folder select uses for "no folder". */
export const TOP_LEVEL = "__top__";
export const NEW_FOLDER = "__new__";

const SIDE_POSITION: Record<Side, Position> = { t: Position.Top, r: Position.Right, b: Position.Bottom, l: Position.Left };
/** Arrows to a collapsed folder attach to its compact node. */
export const FOLDER_POINTS = availablePoints(FOLDER_COLLAPSED);

export type FolderNodeData = {
  folder: DeliverableGroupDTO;
  collapsed: boolean;
  /** Active deliverables inside, at any depth. */
  count: number;
  states: CardState[];
  selected: boolean;
  canEdit: boolean;
  /** Something being dragged would land in here. */
  dropping: boolean;
  onToggle: (id: string) => void;
};
export type FolderNode = Node<FolderNodeData, "folder">;

function pointStyle(id: string) {
  const p = parsePoint(id)!;
  const at = `${pointFraction(p.pct) * 100}%`;
  return p.side === "t" || p.side === "b" ? { left: at } : { top: at };
}

function frameStyle(color: string | null, strength: number) {
  return color ? { borderColor: color, backgroundColor: `color-mix(in oklab, ${color} ${strength}%, transparent)` } : undefined;
}

/**
 * A folder on the canvas: open, a dashed frame drawn around what's inside (the contents are their
 * own nodes above it); collapsed, one compact card standing in for everything inside.
 */
export const FolderNodeView = memo(function FolderNodeView({ data }: NodeProps<FolderNode>) {
  const { folder: f, collapsed, count, states, selected, dropping, onToggle } = data;
  const Toggle = (
    <button
      type="button"
      className="nodrag nopan touch-target flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-4 hover:text-fg"
      aria-label={collapsed ? `Expand ${f.name}` : `Collapse ${f.name}`}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand" : "Collapse"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(f.id);
      }}
    >
      {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
    </button>
  );
  if (collapsed) {
    return (
      <div
        onDoubleClick={() => onToggle(f.id)}
        className={cn(
          "relative flex h-full w-full items-center gap-2 rounded-lg border-2 border-dashed border-border-strong bg-surface-2 px-2.5 text-left shadow-md",
          selected && "outline outline-2 outline-accent",
          dropping && "border-solid !border-accent ring-4 ring-accent/25",
        )}
        style={frameStyle(f.color, 16)}
      >
        <Folder className="size-5 shrink-0" style={{ color: f.color ?? "var(--fg-muted)" }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold leading-tight" title={f.name}>
            {f.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">{folderSummary(count, states)}</p>
        </div>
        {/* A flag of each state inside, so a collapsed folder still shows where work stands. */}
        <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
          {[...new Set(states)].slice(0, 5).map((s) => (
            <span key={s} className="inline-block size-2 rounded-full" style={{ backgroundColor: CARD_STATE_META[s].color }} />
          ))}
        </span>
        {Toggle}
        {FOLDER_POINTS.map((id) => (
          <Handle key={id} id={id} type="source" position={SIDE_POSITION[parsePoint(id)!.side]} style={pointStyle(id)} isConnectable={false} aria-label={`${f.name}: ${pointLabel(id)}`} className="canvas-point !size-2 !border-2 !border-surface-2 !bg-fg-subtle" />
        ))}
        {dropping ? <DropBadge icon={<FolderInput />}>Drop to move into {f.name}</DropBadge> : null}
      </div>
    );
  }
  return (
    <div
      onDoubleClick={(e) => {
        // Only the frame itself (the contents are separate nodes above it).
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-folder-header]")) onToggle(f.id);
      }}
      className={cn(
        "relative h-full w-full rounded-xl border-2 border-dashed border-border-strong bg-surface-3/25 text-left",
        selected && "outline outline-2 outline-accent",
        dropping && "border-solid !border-accent ring-4 ring-accent/25",
      )}
      style={frameStyle(f.color, 7)}
      aria-label={`Folder ${f.name}`}
    >
      <div data-folder-header className="flex items-center gap-1.5 px-2.5 text-[12px] font-semibold" style={{ height: FOLDER_HEADER }}>
        <FolderOpen className="size-4 shrink-0" style={{ color: f.color ?? "var(--fg-muted)" }} aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={f.name}>
          {f.name}
        </span>
        <span className="shrink-0 rounded-full bg-surface-4 px-1.5 text-[10.5px] font-medium text-fg-muted" title={folderSummary(count, states)}>
          {count}
        </span>
        {Toggle}
      </div>
      {dropping ? <DropBadge icon={<FolderInput />}>Drop to move into {f.name}</DropBadge> : null}
    </div>
  );
});

/** The label shown over a drop target while dragging. */
export function DropBadge({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit]">
      <span className="inline-flex max-w-[90%] items-center gap-1.5 truncate rounded-md bg-accent px-2 py-1 text-[11.5px] font-semibold text-accent-fg shadow-md [&_svg]:size-3.5">
        {icon} {children}
      </span>
    </div>
  );
}

export const GroupDropBadge = () => <DropBadge icon={<FolderPlus />}>Drop to group</DropBadge>;

/** "UI › Items" — where something sits. */
export function FolderBreadcrumb({ folders, folderId, className }: { folders: Map<string, DeliverableGroupDTO>; folderId: string | null; className?: string }) {
  const path = folderPath(folders, folderId);
  if (!path.length) return null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-[11.5px] text-fg-muted", className)} title={path.map((id) => folders.get(id)?.name).join(" › ")}>
      <Folder className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{path.map((id) => folders.get(id)?.name ?? "?").join(" › ")}</span>
    </span>
  );
}

/** Folders a node may move to, indented by depth; never a folder's own self or anything inside it. */
export function folderChoices(folders: readonly DeliverableGroupDTO[], byId: Map<string, DeliverableGroupDTO>, exceptFolderId?: string | null): Array<{ value: string; label: string; depth: number }> {
  const out: Array<{ value: string; label: string; depth: number }> = [];
  const walk = (parentId: string | null) => {
    for (const f of folders) {
      if (f.parentId !== parentId) continue;
      if (exceptFolderId && folderContains(byId, exceptFolderId, f.id)) continue;
      const depth = folderDepth(byId, f.parentId);
      out.push({ value: f.id, label: `${"— ".repeat(depth)}${f.name}`, depth });
      walk(f.id);
    }
  };
  walk(null);
  return out;
}

/**
 * A "Folder" field: the folder something is in, every folder it could move to, the top level, and
 * (for a deliverable) a new folder around it. Works without dragging — the keyboard and touch path.
 */
export function MoveToFolderSelect({
  folders,
  byId,
  value,
  exceptFolderId,
  allowNew,
  onChange,
  label,
  className,
}: {
  folders: readonly DeliverableGroupDTO[];
  byId: Map<string, DeliverableGroupDTO>;
  value: string | null;
  exceptFolderId?: string | null;
  allowNew?: boolean;
  onChange: (target: string | null | typeof NEW_FOLDER) => void;
  label: string;
  className?: string;
}) {
  const options = useMemo(() => {
    const list: Array<{ value: string; label: ReactNode }> = [{ value: TOP_LEVEL, label: "No folder (top level)" }];
    for (const c of folderChoices(folders, byId, exceptFolderId)) list.push({ value: c.value, label: c.label });
    if (allowNew) list.push({ value: NEW_FOLDER, label: "New folder…" });
    return list;
  }, [folders, byId, exceptFolderId, allowNew]);
  return (
    <Select<string>
      aria-label={label}
      value={value && byId.has(value) ? value : TOP_LEVEL}
      onValueChange={(v) => onChange(v === TOP_LEVEL ? null : v === NEW_FOLDER ? NEW_FOLDER : v)}
      options={options}
      className={cn("h-7", className)}
    />
  );
}

/** Pick deliverables to put in a folder, without dragging. */
export function AddToFolderPopover({ folder, deliverables, byId, onAdd }: { folder: DeliverableGroupDTO; deliverables: DeliverableDTO[]; byId: Map<string, DeliverableGroupDTO>; onAdd: (ids: string[]) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => deliverables.filter((d) => d.groupId !== folder.id).sort((a, b) => a.name.localeCompare(b.name)), [deliverables, folder.id]);
  if (!candidates.length) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPicked(new Set());
      }}
    >
      <PopoverTrigger asChild>
        <Button size="xs" variant="secondary">
          <FolderInput /> Add deliverables
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-24px)] p-2" aria-label={`Add deliverables to ${folder.name}`}>
        <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Put in {folder.name}</p>
        <div className="scrollbar-thin grid max-h-56 gap-0.5 overflow-y-auto">
          {candidates.map((d) => (
            <label key={d.id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-surface-3">
              <Checkbox
                checked={picked.has(d.id)}
                onCheckedChange={(checked) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (checked === true) next.add(d.id);
                    else next.delete(d.id);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{d.name}</span>
                {d.groupId && byId.has(d.groupId) ? <FolderBreadcrumb folders={byId} folderId={d.groupId} className="text-[10.5px]" /> : null}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-2 flex justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant="primary"
            disabled={!picked.size}
            loading={busy}
            onClick={() => {
              setBusy(true);
              onAdd([...picked])
                .then(() => setOpen(false))
                .catch(() => {})
                .finally(() => setBusy(false));
            }}
          >
            Add {picked.size || ""}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The folder's frame colour: a palette, or none. */
export function FolderColorPicker({ folder, canEdit, onChange }: { folder: DeliverableGroupDTO; canEdit: boolean; onChange: (color: string | null) => void }) {
  const swatch = <span className={cn("inline-block size-4 shrink-0 rounded-full border", folder.color ? "border-transparent" : "border-dashed border-border-strong")} style={folder.color ? { backgroundColor: folder.color } : undefined} aria-hidden />;
  if (!canEdit) {
    return (
      <span className="inline-flex min-h-7 items-center gap-1.5 text-[12.5px] text-fg-muted">
        {swatch} {colorName(folder.color)}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" aria-label={`Colour of ${folder.name}: ${colorName(folder.color)}`} className="justify-start">
          {swatch}
          <Palette />
          <span>Colour</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2" aria-label={`Colour of ${folder.name}`}>
        <div className="grid grid-cols-6 gap-1.5">
          {ACCENT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={colorName(color)}
              aria-pressed={folder.color === color}
              title={colorName(color)}
              onClick={() => color !== folder.color && onChange(color)}
              className="touch-target flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface-2 hover:ring-2 hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: color }}
            >
              {folder.color === color ? <Check className="size-4 text-black/70" strokeWidth={3} /> : null}
            </button>
          ))}
          <button
            type="button"
            aria-label="No colour"
            aria-pressed={folder.color === null}
            title="No colour"
            onClick={() => folder.color !== null && onChange(null)}
            className="touch-target flex size-7 items-center justify-center rounded-full border border-dashed border-border-strong text-fg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            {folder.color === null ? <Check className="size-4" strokeWidth={3} /> : <Ban className="size-3.5" />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
