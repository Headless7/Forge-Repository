"use client";

import { Dialog, DialogContent } from "../ui/dialog";
import { Kbd } from "../ui/controls";

const GROUPS: Array<{ title: string; items: Array<[string[], string]> }> = [
  {
    title: "Anywhere",
    items: [
      [["/"], "Search cards"],
      [["Ctrl", "K"], "Search cards"],
      [["?"], "Show keyboard shortcuts"],
      [["Esc"], "Close dialogs and the card workspace"],
    ],
  },
  {
    title: "Board",
    items: [
      [["C"], "Create a card"],
      [["F"], "Open filters"],
      [["M"], "Toggle My tasks"],
      [["R"], "Toggle Needs review"],
    ],
  },
  {
    title: "Card workspace",
    items: [
      [["←", "→"], "Previous / next card in the review queue"],
      [["Ctrl", "Enter"], "Send comment or feedback"],
      [["A"], "Approve (reviewers)"],
    ],
  },
  {
    title: "Video player",
    items: [
      [["Space"], "Play / pause"],
      [["J", "L"], "Back / forward 1 second"],
      [[",", "."], "Previous / next frame"],
      [["M"], "Mute"],
      [["F"], "Fullscreen"],
    ],
  },
  {
    title: "Image viewer",
    items: [
      [["0"], "Fit to screen"],
      [["1"], "Actual size (100%)"],
      [["+", "−"], "Zoom in / out"],
      [["F"], "Fullscreen"],
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" size="lg">
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{group.title}</h3>
              <ul className="grid gap-1.5">
                {group.items.map(([keys, label]) => (
                  <li key={label + keys.join()} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-fg-muted">{label}</span>
                    <span className="flex gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
