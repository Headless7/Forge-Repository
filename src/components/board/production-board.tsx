"use client";

import { DndContext, DragOverlay, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CircleAlert, Info, Plus } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { resolveDisplayMode } from "@/lib/card-meta";
import { PRODUCTION_META } from "@/lib/deliverables";
import type { CardSummaryDTO, ColumnDTO, ProductionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ColumnIcon } from "../domain/column-icon";
import { PRODUCTION_COLOR, PRODUCTION_ICONS, PRODUCTION_ORDER } from "../domain/production";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Tooltip } from "../ui/menu";
import { useBoard } from "./board-context";
import { CardTile, SortableCard } from "./card-tile";
import { QuickAdd } from "./quick-add";
import { useBoardDnd, type ItemsByColumn } from "./use-board-dnd";

const LAST_CATEGORY_KEY = "forge:last-quick-add-category";

export interface NotReadyInfo {
  cardKey: string;
  title: string;
  target: ProductionStatus;
  message: string;
  blockers: Array<{ deliverableId: string; name: string; reason: string }>;
}

const EMPTY_TEXT: Record<ProductionStatus, string> = {
  TODO: "Nothing in production right now.",
  COMPLETED: "Drag work here once every required deliverable is approved.",
  PUBLISHED: "Mark released work as Published. This only tracks status — nothing is deployed to Roblox.",
};

function StageColumn({
  stage,
  cardIds,
  total,
  filtered,
  onCreate,
  categories,
  defaultCategoryId,
}: {
  stage: ProductionStatus;
  cardIds: string[];
  total: number;
  filtered: boolean;
  onCreate: (columnId: string, title: string, open: boolean) => void;
  categories: ColumnDTO[];
  defaultCategoryId: string | null;
}) {
  const { board, cardsById, columnsById, can } = useBoard();
  const { setNodeRef, isOver } = useDroppable({ id: stage, data: { type: "stage" } });
  const [adding, setAdding] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(defaultCategoryId);
  useEffect(() => setCategoryId(defaultCategoryId), [defaultCategoryId]);
  const Icon = PRODUCTION_ICONS[stage];
  const canCreate = stage === "TODO" && can("card.create") && !board.project.archived && categories.length > 0;
  const count = filtered ? `${cardIds.length} / ${total}` : String(total);

  return (
    <section
      ref={setNodeRef}
      aria-label={`${PRODUCTION_META[stage].label} stage`}
      style={{ borderTopColor: PRODUCTION_COLOR[stage] }}
      className={cn(
        "flex max-h-full w-[300px] shrink-0 flex-col rounded-xl border border-border border-t-2 bg-surface/85 backdrop-blur-[2px] transition-colors",
        isOver && "bg-accent-soft/40",
      )}
    >
      <header className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2">
        <Icon className="size-4" style={{ color: PRODUCTION_COLOR[stage] }} />
        <h2 className="text-[13px] font-semibold">{PRODUCTION_META[stage].label}</h2>
        <span className={cn("rounded-full px-1.5 text-[11px] font-medium tabular-nums", filtered ? "bg-accent-soft text-accent" : "bg-surface-4 text-fg-muted")}>{count}</span>
        <Tooltip content={PRODUCTION_META[stage].description}>
          <Info className="size-3.5 text-fg-subtle" aria-label={PRODUCTION_META[stage].description} />
        </Tooltip>
        <span className="flex-1" />
        {canCreate ? (
          <Tooltip content="Add card">
            <Button variant="ghost" size="icon-xs" aria-label="Add card to To-do" onClick={() => setAdding(true)}>
              <Plus />
            </Button>
          </Tooltip>
        ) : null}
      </header>
      <div className="scrollbar-thin flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-2 pb-2">
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cardIds.map((id) => {
            const card = cardsById.get(id);
            if (!card) return null;
            return <SortableCard key={id} card={card} mode={resolveDisplayMode(card, columnsById.get(card.columnId), board.project)} />;
          })}
        </SortableContext>
        {cardIds.length === 0 && !adding ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong/70 px-3 py-6 text-center">
            <p className="text-[12.5px] text-fg-muted">{filtered && total > 0 ? "No cards match the filters" : EMPTY_TEXT[stage]}</p>
          </div>
        ) : null}
        {adding ? (
          <div className="grid gap-1.5">
            <div className="rounded-lg border border-border-strong bg-surface-2 p-2">
              <p className="mb-1 text-[11px] font-medium text-fg-muted">Category</p>
              <Select
                aria-label="Category for the new card"
                value={categoryId ?? undefined}
                onValueChange={(v) => {
                  setCategoryId(v);
                  try {
                    localStorage.setItem(LAST_CATEGORY_KEY, v);
                  } catch {
                    // storage unavailable — the choice just isn't remembered
                  }
                }}
                options={categories.map((c) => ({ value: c.id, label: c.name }))}
              />
            </div>
            <QuickAdd onCreate={(title, open) => categoryId && onCreate(categoryId, title, open)} onClose={() => setAdding(false)} />
          </div>
        ) : null}
      </div>
      {canCreate && !adding && cardIds.length > 0 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mx-2 mb-2 flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg"
        >
          <Plus className="size-4" /> Add card
        </button>
      ) : null}
    </section>
  );
}

export const ProductionBoard = memo(function ProductionBoard({
  visibleCards,
  allCards,
  filtered,
  categoryFilter,
  onMove,
  onCreate,
}: {
  visibleCards: CardSummaryDTO[];
  allCards: CardSummaryDTO[];
  filtered: boolean;
  categoryFilter: string[];
  onMove: (cardId: string, stage: ProductionStatus, ordered: string[]) => void;
  onCreate: (columnId: string, title: string, open: boolean) => void;
}) {
  const { board, cardsById, columnsById } = useBoard();
  const categories = useMemo(() => [...board.columns].sort((a, b) => a.position - b.position), [board.columns]);

  const derivedItems = useMemo(() => {
    const items: ItemsByColumn = { TODO: [], COMPLETED: [], PUBLISHED: [] };
    for (const card of [...visibleCards].sort((a, b) => a.productionPosition - b.productionPosition)) items[card.productionStatus]!.push(card.id);
    return items;
  }, [visibleCards]);
  const totals = useMemo(() => {
    const t: Record<ProductionStatus, number> = { TODO: 0, COMPLETED: 0, PUBLISHED: 0 };
    for (const c of allCards) t[c.productionStatus] += 1;
    return t;
  }, [allCards]);

  const { items, activeId, activeType, dndProps } = useBoardDnd({
    columnOrder: PRODUCTION_ORDER,
    derivedItems,
    onMoveCard: (cardId, stage, ordered) => onMove(cardId, stage as ProductionStatus, ordered),
    onMoveColumn: () => {},
  });

  // Default category for quick-add: the filtered category, else the last one used, else the first.
  const [remembered, setRemembered] = useState<string | null>(null);
  useEffect(() => {
    try {
      setRemembered(localStorage.getItem(LAST_CATEGORY_KEY));
    } catch {
      setRemembered(null);
    }
  }, []);
  const defaultCategoryId =
    (categoryFilter.length === 1 && columnsById.has(categoryFilter[0]!) ? categoryFilter[0]! : null) ??
    (remembered && columnsById.has(remembered) ? remembered : null) ??
    categories[0]?.id ??
    null;

  const shown = visibleCards.length;
  const done = totals.COMPLETED + totals.PUBLISHED;
  const all = allCards.length;
  const activeCard = activeType === "card" && activeId ? cardsById.get(activeId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-3 text-[12px] text-fg-muted">
        <span>
          <strong className="text-fg">{done}</strong> of {all} cards completed or published
          {filtered ? <span className="text-fg-subtle"> · showing {shown}</span> : null}
        </span>
        <div className="flex h-1.5 w-48 overflow-hidden rounded-full bg-surface-4" role="img" aria-label={`${totals.PUBLISHED} published, ${totals.COMPLETED} completed, ${totals.TODO} to do`}>
          <span style={{ width: `${all ? (totals.PUBLISHED / all) * 100 : 0}%`, backgroundColor: PRODUCTION_COLOR.PUBLISHED }} />
          <span style={{ width: `${all ? (totals.COMPLETED / all) * 100 : 0}%`, backgroundColor: PRODUCTION_COLOR.COMPLETED }} />
        </div>
        <span className="hidden text-fg-subtle md:inline">Stages are independent of categories and review status. Completing needs every required deliverable approved.</span>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-x-auto overflow-y-hidden max-md:snap-x max-md:snap-mandatory">
        <DndContext id={`production-${board.project.id}`} {...dndProps}>
          <div className="flex h-full items-start gap-3 p-3 md:p-4">
            {PRODUCTION_ORDER.map((stage) => (
              <div key={stage} className="h-full max-md:snap-start">
                <StageColumn
                  stage={stage}
                  cardIds={items[stage] ?? []}
                  total={totals[stage]}
                  filtered={filtered}
                  onCreate={onCreate}
                  categories={categories}
                  defaultCategoryId={defaultCategoryId}
                />
              </div>
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
            {activeCard ? (
              <div className="w-[284px]">
                <CardTile card={activeCard} mode={resolveDisplayMode(activeCard, columnsById.get(activeCard.columnId), board.project)} overlay />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
});

/** Explains exactly what's missing when completing/publishing is refused. */
export function NotReadyDialog({ info, onClose, onOpenCard }: { info: NotReadyInfo | null; onClose: () => void; onOpenCard: (key: string) => void }) {
  return (
    <Dialog open={Boolean(info)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={info ? `${info.title} isn't ready to be ${PRODUCTION_META[info.target].label}` : ""} description="Stages follow the review workflow — approvals are never created by moving a card.">
        {info?.blockers.length ? (
          <ul className="grid gap-1.5">
            {info.blockers.map((b) => (
              <li key={`${b.deliverableId}-${b.reason}`} className="flex items-start gap-2 rounded-md border border-border bg-surface-3/40 px-2.5 py-2 text-[13px]">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-state-review" />
                <span className="min-w-0 flex-1">
                  <strong className="font-medium">{b.name}</strong>
                  <span className="block text-[12px] text-fg-muted">{b.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-fg-muted">{info?.message}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {info ? (
            <Button variant="primary" onClick={() => onOpenCard(info.cardKey)}>
              Open card
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CategoryBadge({ column }: { column: ColumnDTO | undefined }) {
  if (!column) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-fg-muted">
      <ColumnIcon name={column.icon} color={column.color} className="size-3.5" /> {column.name}
    </span>
  );
}
