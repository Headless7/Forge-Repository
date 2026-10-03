"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { qk, useRpcMutation } from "@/lib/queries";
import type { ScheduleCardDTO, ScheduleDeliverableDTO } from "@/lib/types";
import { toLocalInput } from "@/lib/utils";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { FieldError, Label } from "../ui/input";

export interface ScheduleSelection {
  card: ScheduleCardDTO;
  deliverable: ScheduleDeliverableDTO | null;
}

const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

/**
 * The keyboard- and touch-friendly way to see and change an item's dates (the timeline's bars can
 * also be dragged with a mouse). Deliverables without their own dates follow the card's.
 */
export function ScheduleItemDialog({ selection, onClose, onOpenCard }: { selection: ScheduleSelection | null; onClose: () => void; onOpenCard: (selection: ScheduleSelection) => void }) {
  const queryClient = useQueryClient();
  const card = selection?.card;
  const d = selection?.deliverable ?? null;
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!selection) return;
    setStart(toLocalInput(d ? d.ownStartAt : (card?.startAt ?? null)));
    setDue(toLocalInput(d ? d.ownDueAt : (card?.dueAt ?? null)));
    setError(null);
  }, [selection, card, d]);

  const done = () => {
    if (card) {
      void queryClient.invalidateQueries({ queryKey: qk.board(card.project.id) });
      void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
      void queryClient.invalidateQueries({ queryKey: ["schedule"] });
    }
    toast.success("Dates saved.");
    onClose();
  };
  const updateCard = useRpcMutation("card.update", { onSuccess: done });
  const updateDeliverable = useRpcMutation("deliverable.update", { onSuccess: done });
  if (!selection || !card) return null;

  const save = (values: { startAt: string | null; dueAt: string | null }) => {
    const effectiveStart = values.startAt ?? (d ? card.startAt : null);
    const effectiveDue = values.dueAt ?? (d ? card.dueAt : null);
    if (effectiveStart && effectiveDue && new Date(effectiveStart) > new Date(effectiveDue)) {
      setError("The start can't be after the deadline.");
      return;
    }
    if (d) updateDeliverable.mutate({ deliverableId: d.id, ...values });
    else updateCard.mutate({ cardId: card.id, ...values });
  };
  const busy = updateCard.isPending || updateDeliverable.isPending;
  const state = d?.state ?? card.state;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={d ? `D${d.number} ${d.name}` : card.title} description={`${card.key}${d ? ` ${card.title}` : ""} · ${card.board.name}`}>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-muted">
            <StatePill state={state} size="sm" />
            {d?.blockedBy.length ? (
              <span className="inline-flex items-center gap-1 text-state-review">
                <Lock className="size-3.5" /> waiting on {d.blockedBy.map((id) => card.deliverables.find((x) => x.id === id)?.name ?? "?").join(", ")}
              </span>
            ) : null}
          </div>
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save({ startAt: toIso(start), dueAt: toIso(due) });
            }}
          >
            <div>
              <Label htmlFor="schedule-start">Start</Label>
              <input
                id="schedule-start"
                type="datetime-local"
                value={start}
                disabled={!card.canEdit}
                onChange={(e) => setStart(e.target.value)}
                className="h-9 w-full rounded-md border border-border-strong bg-surface-3 px-2 text-[13px] outline-none focus:border-accent disabled:opacity-60 [color-scheme:dark] light:[color-scheme:light]"
              />
              {d && !start && card.startAt ? <p className="mt-1 text-[11.5px] text-fg-subtle">Follows the card&apos;s start</p> : null}
            </div>
            <div>
              <Label htmlFor="schedule-due">Deadline</Label>
              <input
                id="schedule-due"
                type="datetime-local"
                value={due}
                disabled={!card.canEdit}
                onChange={(e) => setDue(e.target.value)}
                className="h-9 w-full rounded-md border border-border-strong bg-surface-3 px-2 text-[13px] outline-none focus:border-accent disabled:opacity-60 [color-scheme:dark] light:[color-scheme:light]"
              />
              {d && !due && card.dueAt ? <p className="mt-1 text-[11.5px] text-fg-subtle">Follows the card&apos;s deadline</p> : null}
            </div>
            {error ? (
              <div className="sm:col-span-2">
                <FieldError>{error}</FieldError>
              </div>
            ) : null}
            {d && (d.ownStartAt || d.ownDueAt) && card.canEdit ? (
              <button type="button" className="inline-flex min-h-6 items-center text-left text-[12px] text-accent hover:underline sm:col-span-2" onClick={() => save({ startAt: null, dueAt: null })}>
                Use the card&apos;s dates instead
              </button>
            ) : null}
            {!card.canEdit ? <p className="text-[12px] text-fg-subtle sm:col-span-2">You can see these dates but not change them.</p> : null}
            <DialogFooter className="sm:col-span-2">
              <Button variant="ghost" onClick={() => onOpenCard(selection)}>
                Open {d ? "deliverable" : "card"} <ArrowRight />
              </Button>
              {card.canEdit ? (
                <Button type="submit" variant="primary" loading={busy}>
                  Save dates
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
