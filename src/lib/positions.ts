/**
 * Ordering uses sparse floating-point positions: inserting between two items takes
 * the midpoint, so a move touches a single row. When gaps get too small the
 * server rebalances the whole list. The client uses the same maths optimistically.
 */
export const POSITION_GAP = 1024;
const MIN_GAP = 1e-6;

/** Position for an item placed after `prev` and before `next` (either may be absent). Null → rebalance needed. */
export function positionBetween(prev: number | null | undefined, next: number | null | undefined): number | null {
  const hasPrev = prev !== null && prev !== undefined;
  const hasNext = next !== null && next !== undefined;
  if (!hasPrev && !hasNext) return POSITION_GAP;
  if (!hasPrev) return next! - POSITION_GAP;
  if (!hasNext) return prev + POSITION_GAP;
  if (next! - prev < MIN_GAP) return null;
  return (prev + next!) / 2;
}

/** Evenly spaced positions for a full rebalance. */
export function spacedPositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_GAP);
}

/** Index where an item should be inserted, preferring neighbour hints over a raw index. */
export function resolveInsertIndex<T extends { id: string }>(
  list: readonly T[],
  hints: { afterId?: string | null; beforeId?: string | null; index?: number | null },
): number {
  if (hints.afterId) {
    const i = list.findIndex((item) => item.id === hints.afterId);
    if (i >= 0) return i + 1;
  }
  if (hints.beforeId) {
    const i = list.findIndex((item) => item.id === hints.beforeId);
    if (i >= 0) return i;
  }
  if (typeof hints.index === "number" && Number.isFinite(hints.index)) {
    return Math.max(0, Math.min(list.length, Math.floor(hints.index)));
  }
  return list.length;
}
