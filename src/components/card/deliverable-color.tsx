"use client";

import { Ban, Check, Palette } from "lucide-react";
import { ACCENT_COLORS } from "@/lib/column-icons";
import { useCardMutation } from "@/lib/queries";
import type { DeliverableDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/menu";
import { useWorkspace } from "./workspace-context";

const COLOR_NAMES: Record<(typeof ACCENT_COLORS)[number], string> = {
  "#a78bfa": "Purple",
  "#818cf8": "Indigo",
  "#60a5fa": "Blue",
  "#22d3ee": "Cyan",
  "#34d399": "Green",
  "#a3e635": "Lime",
  "#facc15": "Yellow",
  "#fb923c": "Orange",
  "#f87171": "Red",
  "#f472b6": "Pink",
  "#94a3b8": "Slate",
};

export const colorName = (color: string | null) => (color ? (COLOR_NAMES[color as keyof typeof COLOR_NAMES] ?? "Custom") : "No colour");

/**
 * The colour of a deliverable's card (a tint and top edge on the canvas, a stripe in the list).
 * People who can edit the card pick one from the palette, or none.
 */
export function DeliverableColorPicker({ deliverable: d, compact }: { deliverable: DeliverableDTO; compact?: boolean }) {
  const { card } = useWorkspace();
  const update = useCardMutation("deliverable.update", card.id, card.projectId);
  const canEdit = card.permissions.canEdit && !d.archivedAt;
  const swatch = (
    <span
      className={cn("inline-block size-4 shrink-0 rounded-full border", d.color ? "border-transparent" : "border-dashed border-border-strong")}
      style={d.color ? { backgroundColor: d.color } : undefined}
      aria-hidden
    />
  );
  if (!canEdit) {
    return (
      <span className="inline-flex min-h-7 items-center gap-1.5 text-[12.5px] text-fg-muted">
        {swatch} {colorName(d.color)}
      </span>
    );
  }
  const choose = (color: string | null) => color !== d.color && update.mutate({ deliverableId: d.id, color });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="xs" variant="ghost" aria-label={`Colour of ${d.name}: ${colorName(d.color)}`} className={cn("justify-start", !compact && "-mx-1.5")}>
          {swatch}
          {compact ? <Palette /> : null}
          <span>{compact ? "Colour" : colorName(d.color)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2" aria-label={`Colour of ${d.name}`}>
        <div className="grid grid-cols-6 gap-1.5">
          {ACCENT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={COLOR_NAMES[color]}
              aria-pressed={d.color === color}
              title={COLOR_NAMES[color]}
              onClick={() => choose(color)}
              className="touch-target flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface-2 hover:ring-2 hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: color }}
            >
              {d.color === color ? <Check className="size-4 text-black/70" strokeWidth={3} /> : null}
            </button>
          ))}
          <button
            type="button"
            aria-label="No colour"
            aria-pressed={d.color === null}
            title="No colour"
            onClick={() => choose(null)}
            className="touch-target flex size-7 items-center justify-center rounded-full border border-dashed border-border-strong text-fg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            {d.color === null ? <Check className="size-4" strokeWidth={3} /> : <Ban className="size-3.5" />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
