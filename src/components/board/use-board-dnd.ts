"use client";

import {
  closestCenter,
  getFirstCollision,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useCallback, useEffect, useRef, useState } from "react";

export type ItemsByColumn = Record<string, string[]>;

interface Options {
  columnOrder: string[];
  derivedItems: ItemsByColumn;
  onMoveCard: (cardId: string, toColumnId: string, orderedIds: string[]) => void;
  onMoveColumn: (columnId: string, newOrder: string[]) => void;
}

/**
 * Multi-container drag and drop (cards across columns + sortable columns),
 * following the dnd-kit multiple-containers pattern. While dragging, a local copy
 * of the column→cards mapping moves the placeholder; on drop the move is persisted.
 */
export function useBoardDnd({ columnOrder, derivedItems, onMoveCard, onMoveColumn }: Options) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<"card" | "column" | null>(null);
  const [dragItems, setDragItems] = useState<ItemsByColumn | null>(null);
  const items = dragItems ?? derivedItems;
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedToNewContainer = useRef(false);
  const origin = useRef<{ columnId: string; index: number } | null>(null);
  const columnOrderRef = useRef(columnOrder);
  columnOrderRef.current = columnOrder;
  // Target slot of a keyboard-dragged column. Tracked here (not via `over`) so quick
  // repeated key presses never get lost while dnd-kit re-measures collisions.
  const keyboardColumnIndex = useRef<number | null>(null);

  // Columns step one column at a time with ←/→; cards use the standard sortable behaviour.
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>((event, args) => {
    const { active, droppableRects, collisionRect } = args.context;
    if (active?.data.current?.type === "column" && collisionRect && (event.code === "ArrowLeft" || event.code === "ArrowRight")) {
      event.preventDefault();
      const order = columnOrderRef.current;
      const from = keyboardColumnIndex.current ?? order.indexOf(String(active.id));
      const next = Math.max(0, Math.min(order.length - 1, from + (event.code === "ArrowLeft" ? -1 : 1)));
      keyboardColumnIndex.current = next;
      const rect = droppableRects.get(order[next]!);
      return rect ? { x: rect.left, y: collisionRect.top } : undefined;
    }
    return sortableKeyboardCoordinates(event, args);
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const findContainer = useCallback(
    (id: UniqueIdentifier, source: ItemsByColumn = items): string | undefined => {
      const key = String(id);
      if (key in source) return key;
      return Object.keys(source).find((columnId) => source[columnId]!.includes(key));
    },
    [items],
  );

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      // Read the type from the active item itself: state can lag a frame behind at drag start.
      if (args.active.data.current?.type === "column") {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) => c.data.current?.type === "column"),
        });
      }
      const pointer = pointerWithin(args);
      let overId: UniqueIdentifier | null = getFirstCollision(pointer, "id");
      if (overId == null && args.pointerCoordinates) {
        // Below a short column or in the gap between two. Columns are vertical lanes, so use the
        // lane under the pointer; between lanes keep the current target. (Guessing by overlap here
        // flip-flopped: moving the placeholder changes the overlap ratios, which moved it back…)
        const { x } = args.pointerCoordinates;
        const lane = args.droppableContainers.find((c) => {
          const rect = String(c.id) in items ? args.droppableRects.get(c.id) : undefined;
          return rect !== undefined && x >= rect.left && x <= rect.right;
        });
        if (lane) overId = lane.id;
        else if (lastOverId.current != null) return [{ id: lastOverId.current }];
      }
      // Keyboard drags have no pointer: fall back to overlap.
      if (overId == null && !args.pointerCoordinates) overId = getFirstCollision(rectIntersection(args), "id");
      if (overId != null) {
        const key = String(overId);
        if (key in items) {
          const columnItems = items[key]!;
          if (columnItems.length > 0) {
            // Over a column: target the closest card inside it.
            overId =
              closestCenter({
                ...args,
                droppableContainers: args.droppableContainers.filter((c) => c.id !== overId && columnItems.includes(String(c.id))),
              })[0]?.id ?? overId;
          }
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (movedToNewContainer.current) lastOverId.current = activeId;
      return lastOverId.current ? [{ id: lastOverId.current }] : [];
    },
    [activeId, items],
  );

  useEffect(() => {
    requestAnimationFrame(() => {
      movedToNewContainer.current = false;
    });
  }, [items]);

  const reset = () => {
    setActiveId(null);
    setActiveType(null);
    setDragItems(null);
    origin.current = null;
    keyboardColumnIndex.current = null;
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    const type = active.data.current?.type === "column" ? "column" : "card";
    setActiveId(String(active.id));
    setActiveType(type);
    if (type === "card") {
      const columnId = findContainer(active.id, derivedItems);
      if (columnId) origin.current = { columnId, index: derivedItems[columnId]!.indexOf(String(active.id)) };
      setDragItems(derivedItems);
    }
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (activeType !== "card" || !over) return;
    // At most one column change per frame, so layout shifts can never ping-pong the card
    // between two columns within a single render cascade. A change skipped here is applied on drop.
    if (movedToNewContainer.current) return;
    const activeContainer = findContainer(active.id);
    const overContainer = findContainer(over.id);
    if (!activeContainer || !overContainer || activeContainer === overContainer) return;
    setDragItems((current) => {
      const source = current ?? derivedItems;
      const overItems = source[overContainer]!;
      const overIndex = overItems.indexOf(String(over.id));
      let newIndex: number;
      if (String(over.id) in source) {
        newIndex = overItems.length;
      } else {
        const below = active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
        newIndex = overIndex >= 0 ? overIndex + (below ? 1 : 0) : overItems.length;
      }
      movedToNewContainer.current = true;
      return {
        ...source,
        [activeContainer]: source[activeContainer]!.filter((id) => id !== String(active.id)),
        [overContainer]: [...overItems.slice(0, newIndex), String(active.id), ...overItems.slice(newIndex)],
      };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (active.data.current?.type === "column") {
      // Keyboard drags know their slot exactly; pointer drags resolve `over` (a card resolves to its column).
      const keyboardSlot = keyboardColumnIndex.current;
      const overColumn =
        keyboardSlot !== null
          ? columnOrder[keyboardSlot]
          : over
            ? columnOrder.includes(String(over.id))
              ? String(over.id)
              : findContainer(over.id, derivedItems)
            : undefined;
      if (overColumn && overColumn !== active.id) {
        const from = columnOrder.indexOf(String(active.id));
        const to = columnOrder.indexOf(overColumn);
        if (from >= 0 && to >= 0) onMoveColumn(String(active.id), arrayMove(columnOrder, from, to));
      }
      reset();
      return;
    }
    const activeContainer = findContainer(active.id);
    if (!activeContainer || !over) {
      reset();
      return;
    }
    const overContainer = findContainer(over.id);
    let finalItems = items;
    if (overContainer && overContainer !== activeContainer) {
      // A column change that was still pending when the card was dropped.
      const id = String(active.id);
      const target = items[overContainer]!.filter((x) => x !== id);
      const overIndex = String(over.id) in items ? target.length : target.indexOf(String(over.id));
      const index = overIndex >= 0 ? overIndex : target.length;
      finalItems = { ...items, [activeContainer]: items[activeContainer]!.filter((x) => x !== id), [overContainer]: [...target.slice(0, index), id, ...target.slice(index)] };
    } else if (overContainer && overContainer === activeContainer) {
      const list = items[overContainer]!;
      const activeIndex = list.indexOf(String(active.id));
      const overIndex = String(over.id) in items ? list.length - 1 : list.indexOf(String(over.id));
      if (overIndex >= 0 && activeIndex !== overIndex) {
        finalItems = { ...items, [overContainer]: arrayMove(list, activeIndex, overIndex) };
      }
    }
    const targetColumn = findContainer(active.id, finalItems)!;
    const ordered = finalItems[targetColumn]!;
    const index = ordered.indexOf(String(active.id));
    const start = origin.current;
    if (!start || start.columnId !== targetColumn || start.index !== index) {
      onMoveCard(String(active.id), targetColumn, ordered);
    }
    reset();
  };

  return {
    items,
    activeId,
    activeType,
    dndProps: {
      sensors,
      collisionDetection,
      onDragStart,
      onDragOver,
      onDragEnd,
      onDragCancel: reset,
      measuring: { droppable: { strategy: MeasuringStrategy.Always } },
      autoScroll: { threshold: { x: 0.12, y: 0.18 }, acceleration: 14 },
    },
  };
}
