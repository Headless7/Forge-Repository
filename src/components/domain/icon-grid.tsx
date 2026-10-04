import type { LucideIcon } from "lucide-react";
import { iconLabel } from "@/lib/board-icons";
import { cn } from "@/lib/utils";

/** A grid of icon choices (columns, boards). Each is a toggle button announced by name. */
export function IconGrid<N extends string>({
  icons,
  components,
  value,
  onSelect,
  color,
  label,
}: {
  icons: readonly N[];
  components: Record<N, LucideIcon>;
  value: string | null;
  onSelect: (name: N) => void;
  color?: string | null;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-8 gap-1">
      {icons.map((name) => {
        const Icon: LucideIcon = components[name];
        return (
          <button
            key={name}
            type="button"
            aria-label={iconLabel(name)}
            aria-pressed={value === name}
            onClick={() => onSelect(name)}
            className={cn("flex size-7 items-center justify-center rounded-md hover:bg-surface-4 focus-visible:ring-2 focus-visible:ring-accent", value === name && "bg-accent-soft ring-1 ring-accent")}
          >
            <Icon className="size-4" style={{ color: color ?? undefined }} />
          </button>
        );
      })}
    </div>
  );
}
