"use client";

import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Copy,
  CopyPlus,
  Ellipsis,
  GripVertical,
  LayoutGrid,
  Palette,
  Pencil,
  Plus,
  Rows3,
  Trash2,
} from "lucide-react";
import { memo, useState, type CSSProperties } from "react";
import { ACCENT_COLORS, COLUMN_ICONS, type ColumnIconName } from "@/lib/column-icons";
import { useMenuPopover } from "@/hooks/use-menu-popover";
import { resolveDisplayMode } from "@/lib/card-meta";
import type { CardDisplayMode, ColumnDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { COLUMN_ICON_COMPONENTS, ColumnIcon } from "../domain/column-icon";
import { IconGrid } from "../domain/icon-grid";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Tooltip,
} from "../ui/menu";
import { useBoard } from "./board-context";
import { SortableCard } from "./card-tile";
import { QuickAdd } from "./quick-add";

export interface ColumnPatch {
  icon?: ColumnIconName | null;
  color?: string | null;
  defaultCardMode?: CardDisplayMode | null;
}

export interface ColumnActions {
  rename: (column: ColumnDTO, name: string) => void;
  update: (column: ColumnDTO, patch: ColumnPatch) => void;
  archive: (column: ColumnDTO) => void;
  remove: (column: ColumnDTO) => void;
  duplicate: (column: ColumnDTO, withCards: boolean) => void;
  toggleCollapsed: (column: ColumnDTO) => void;
  createCard: (column: ColumnDTO, title: string, open: boolean) => void;
  /** Reorder without dragging (touch screens, keyboard). */
  move: (column: ColumnDTO, direction: -1 | 1) => void;
}

function IconColorPicker({ column, onChange }: { column: ColumnDTO; onChange: ColumnActions["update"] }) {
  return (
    <div className="w-64 max-w-full">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Icon</p>
      <IconGrid label={`${column.name} column icon`} icons={COLUMN_ICONS} components={COLUMN_ICON_COMPONENTS} value={column.icon} color={column.color} onSelect={(icon) => onChange(column, { icon })} />
      <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Accent</p>
      <div role="group" aria-label={`${column.name} column accent colour`} className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-label="No accent colour"
          aria-pressed={!column.color}
          onClick={() => onChange(column, { color: null })}
          className={cn("size-6 rounded-full border border-border-strong bg-surface-3", !column.color && "ring-2 ring-accent ring-offset-2 ring-offset-surface-2")}
        />
        {ACCENT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Accent ${color}`}
            aria-pressed={column.color === color}
            onClick={() => onChange(column, { color })}
            className={cn("size-6 rounded-full", column.color === color && "ring-2 ring-accent ring-offset-2 ring-offset-surface-2")}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnMenu({ column, actions, onRename, canManage }: { column: ColumnDTO; actions: ColumnActions; onRename: () => void; canManage: boolean }) {
  const picker = useMenuPopover();
  const { board } = useBoard();
  const order = [...board.columns].sort((a, b) => a.position - b.position).map((c) => c.id);
  const index = order.indexOf(column.id);
  return (
    <Popover open={picker.open} onOpenChange={picker.setOpen}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>
            <Button ref={picker.triggerRef} variant="ghost" size="icon-xs" aria-label={`${column.name} column actions`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={picker.onMenuCloseAutoFocus}>
          <DropdownMenuItem onSelect={() => actions.toggleCollapsed(column)}>
            <ChevronsRightLeft /> Collapse column
          </DropdownMenuItem>
          {canManage ? (
            <>
              <DropdownMenuItem onSelect={onRename}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={picker.request}>
                <Palette /> Icon & colour
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index <= 0} onSelect={() => actions.move(column, -1)}>
                <ArrowLeft /> Move left
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index < 0 || index >= order.length - 1} onSelect={() => actions.move(column, 1)}>
                <ArrowRight /> Move right
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Default card layout</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={column.defaultCardMode ?? "INHERIT"}
                onValueChange={(v) => actions.update(column, { defaultCardMode: v === "INHERIT" ? null : (v as CardDisplayMode) })}
              >
                <DropdownMenuRadioItem value="VISUAL">
                  <LayoutGrid /> Visual (media first)
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="COMPACT">
                  <Rows3 /> Compact
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="INHERIT">Project default</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => actions.duplicate(column, false)}>
                <Copy /> Duplicate column
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.duplicate(column, true)}>
                <CopyPlus /> Duplicate with cards
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.archive(column)}>
                <Archive /> Archive column
              </DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => actions.remove(column)}>
                <Trash2 /> Delete (empty columns only)
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent
        align="end"
        collisionPadding={8}
        aria-label={`${column.name} icon and colour`}
        className="max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain"
        {...picker.contentProps}
      >
        <IconColorPicker column={column} onChange={actions.update} />
      </PopoverContent>
    </Popover>
  );
}

function ColumnTitle({ column, editing, setEditing, onRename }: { column: ColumnDTO; editing: boolean; setEditing: (v: boolean) => void; onRename: (name: string) => void }) {
  const [value, setValue] = useState(column.name);
  if (!editing) {
    return (
      <h2 className="min-w-0 truncate text-[13px] font-semibold" title={column.name} onDoubleClick={() => setEditing(true)}>
        {column.name}
      </h2>
    );
  }
  const commit = () => {
    const name = value.trim();
    if (name && name !== column.name) onRename(name);
    setEditing(false);
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={60}
      aria-label="Column name"
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          setValue(column.name);
          setEditing(false);
        }
      }}
      className="h-6 min-w-0 flex-1 rounded border border-accent bg-surface-3 px-1.5 text-[13px] font-semibold outline-none"
    />
  );
}

export interface BoardColumnProps {
  column: ColumnDTO;
  cardIds: string[];
  total: number;
  filtered: boolean;
  collapsed: boolean;
  actions: ColumnActions;
}

export const BoardColumn = memo(function BoardColumn({ column, cardIds, total, filtered, collapsed, actions }: BoardColumnProps) {
  const { board, cardsById, can, quickAddColumnId, startQuickAdd, stopQuickAdd } = useBoard();
  const canManage = can("column.manage");
  const canCreate = can("card.create") && !board.project.archived;
  const [editing, setEditing] = useState(false);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    data: { type: "column" },
    disabled: !canManage,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const count = filtered ? `${cardIds.length} / ${total}` : String(total);
  const adding = quickAddColumnId === column.id;

  if (collapsed) {
    return (
      <section
        ref={setNodeRef}
        style={style}
        aria-label={`${column.name} (collapsed)`}
        className={cn("flex h-full w-11 shrink-0 flex-col items-center rounded-xl border border-border bg-surface/80 py-2", isDragging && "opacity-40")}
      >
        <Tooltip content="Expand column" side="right">
          <Button variant="ghost" size="icon-xs" onClick={() => actions.toggleCollapsed(column)} aria-label={`Expand ${column.name}`}>
            <ChevronsLeftRight />
          </Button>
        </Tooltip>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onClick={() => actions.toggleCollapsed(column)}
          className="mt-2 flex flex-1 flex-col items-center gap-2 [writing-mode:vertical-rl]"
        >
          <ColumnIcon name={column.icon} color={column.color} className="rotate-90" />
          <span className="text-[13px] font-semibold">{column.name}</span>
          <span className="rounded-full bg-surface-4 px-1 py-1.5 text-[11px] font-medium text-fg-muted">{count}</span>
        </button>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      style={{ ...style, borderTopColor: column.color ?? undefined }}
      aria-label={`${column.name} column`}
      className={cn(
        "flex max-h-full w-[288px] shrink-0 flex-col rounded-xl border border-border border-t-2 bg-surface/85 backdrop-blur-[2px]",
        isDragging && "opacity-40",
      )}
    >
      <header className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2">
        {canManage ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${column.name} column`}
            className="touch-target -ml-1 flex h-6 w-4 cursor-grab items-center justify-center text-fg-subtle opacity-60 hover:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
        ) : null}
        <ColumnIcon name={column.icon} color={column.color} />
        <ColumnTitle column={column} editing={editing} setEditing={setEditing} onRename={(name) => actions.rename(column, name)} />
        <span className={cn("rounded-full px-1.5 text-[11px] font-medium tabular-nums", filtered ? "bg-accent-soft text-accent" : "bg-surface-4 text-fg-muted")} title={filtered ? `${cardIds.length} of ${total} cards match the filters` : `${total} cards`}>
          {count}
        </span>
        <span className="flex-1" />
        {canCreate ? (
          <Tooltip content="Add card" shortcut="C">
            <Button variant="ghost" size="icon-xs" aria-label={`Add card to ${column.name}`} onClick={() => startQuickAdd(column.id)}>
              <Plus />
            </Button>
          </Tooltip>
        ) : null}
        <ColumnMenu column={column} actions={actions} canManage={canManage} onRename={() => setEditing(true)} />
      </header>

      <div className="scrollbar-thin flex min-h-10 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-2 pb-2">
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cardIds.map((id) => {
            const card = cardsById.get(id);
            if (!card) return null;
            return <SortableCard key={id} card={card} mode={resolveDisplayMode(card, column, board.project)} />;
          })}
        </SortableContext>
        {cardIds.length === 0 && !adding ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong/70 px-3 py-6 text-center">
            <p className="text-[12.5px] text-fg-muted">{filtered && total > 0 ? "No cards match the filters" : "No cards yet"}</p>
            {canCreate && !(filtered && total > 0) ? (
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => startQuickAdd(column.id)}>
                <Plus /> Add card
              </Button>
            ) : null}
          </div>
        ) : null}
        {adding ? <QuickAdd onCreate={(title, open) => actions.createCard(column, title, open)} onClose={stopQuickAdd} /> : null}
      </div>

      {canCreate && !adding && cardIds.length > 0 ? (
        <button
          type="button"
          onClick={() => startQuickAdd(column.id)}
          className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
        >
          <Plus className="size-4" /> Add card
        </button>
      ) : null}
    </section>
  );
});

export function AddColumn({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-[288px] shrink-0 items-center gap-2 rounded-xl border border-dashed border-border-strong px-3 text-[13px] font-medium text-fg-muted transition-colors hover:border-fg-subtle hover:bg-surface/60 hover:text-fg"
      >
        <Plus className="size-4" /> Add category
      </button>
    );
  }
  const submit = () => {
    const value = name.trim();
    if (value) onCreate(value);
    setName("");
  };
  return (
    <div className="w-[288px] shrink-0 rounded-xl border border-border-strong bg-surface p-2">
      <input
        autoFocus
        value={name}
        maxLength={60}
        placeholder="Category name, e.g. Sound Design"
        aria-label="New category name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
        className="h-8 w-full rounded-md border border-accent bg-surface-3 px-2 text-[13px] outline-none"
      />
      <div className="mt-2 flex gap-1.5">
        <Button size="xs" variant="primary" onClick={submit} disabled={!name.trim()}>
          Add category
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
