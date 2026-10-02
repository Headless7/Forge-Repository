import type { KeyboardEvent } from "react";

/**
 * For players with keyboard shortcuts: whether a key belongs to the focused control instead.
 * Menus render in a portal but their key events still bubble through React to the player, so
 * typing in a select list (Space, letters) must not also play/pause or seek. Text fields,
 * sliders and lists keep their keys; buttons keep Space/Enter (pressing them).
 */
export function keyBelongsToControl(e: KeyboardEvent<HTMLElement>): boolean {
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target)) return true;
  if (target === e.currentTarget) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox'], [role='option'], [role='menu'], [role='menuitem'], [role='slider']")) return true;
  return (e.key === " " || e.key === "Enter") && Boolean(target.closest("button, a[href], [role='button'], [role='tab']"));
}
