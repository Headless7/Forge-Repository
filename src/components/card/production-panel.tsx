"use client";

import { CircleAlert, CircleCheck, Undo2 } from "lucide-react";
import { useState } from "react";
import { PRODUCTION_META } from "@/lib/deliverables";
import { useCardMutation } from "@/lib/queries";
import type { ProductionStatus } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { PRODUCTION_COLOR, PRODUCTION_ICONS, ProductionPill } from "../domain/production";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { TipAnchor } from "../tutorial/tutorial";
import { Textarea } from "../ui/input";
import { useWorkspace } from "./workspace-context";

/**
 * Production stage of the card. Completing/publishing is only offered when every
 * required deliverable is approved; it records those exact revisions and never
 * changes any review state.
 */
export function ProductionPanel() {
  const { card, membersById, openDeliverable, multi } = useWorkspace();
  const [target, setTarget] = useState<ProductionStatus | null>(null);
  const [note, setNote] = useState("");
  const move = useCardMutation("card.setProduction", card.id, card.projectId, {
    onSuccess: () => {
      setTarget(null);
      setNote("");
    },
  });
  const perms = card.permissions;
  const status = card.productionStatus;
  const readiness = card.readiness;
  const last = card.productionEvents.at(-1);
  const lastActor = last?.actorId ? membersById.get(last.actorId) : undefined;
  const Icon = PRODUCTION_ICONS[status];

  const actions: Array<{ to: ProductionStatus; label: string; allowed: boolean; primary?: boolean; needsReady: boolean }> =
    status === "TODO"
      ? [
          { to: "COMPLETED", label: "Mark completed", allowed: perms.canEdit, primary: true, needsReady: true },
          { to: "PUBLISHED", label: "Mark published", allowed: perms.canPublish, needsReady: true },
        ]
      : status === "COMPLETED"
        ? [
            { to: "PUBLISHED", label: readiness.pendingChanges.length ? "Publish again" : "Mark published", allowed: perms.canPublish, primary: true, needsReady: true },
            { to: "TODO", label: "Back to To-do", allowed: perms.canEdit, needsReady: false },
          ]
        : [
            { to: "COMPLETED", label: "Back to Completed", allowed: perms.canPublish, needsReady: false },
            { to: "TODO", label: "Back to To-do", allowed: perms.canPublish, needsReady: false },
          ];

  return (
    <section aria-label="Production" className="rounded-xl border border-border bg-surface-2 p-3">
      <TipAnchor tip="production.stages" place="card" facts={{ place: "card", relevant: readiness.ready || status !== "TODO" }}>
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <Icon className="size-3.5" style={{ color: PRODUCTION_COLOR[status] }} /> Production stage
        </p>
      </TipAnchor>
      <ProductionPill status={status} size="md" pending={readiness.pendingChanges.length > 0} />
      <p className="mt-1.5 text-[12px] text-fg-muted">{PRODUCTION_META[status].description}</p>
      {last && status !== "TODO" ? (
        <p className="mt-1 text-[11.5px] text-fg-subtle">
          {PRODUCTION_META[last.toStatus].label} by {lastActor?.displayName ?? "someone"} {timeAgo(last.createdAt)}
          {last.note ? ` — “${last.note}”` : ""}
        </p>
      ) : null}

      {status !== "TODO" && card.productionSnapshot.length ? (
        <div className="mt-2 rounded-md border border-border bg-surface-3/40 p-2">
          <p className="text-[11px] font-semibold text-fg-muted">Recorded revisions</p>
          <ul className="mt-1 grid gap-0.5 text-[12px]">
            {card.productionSnapshot.map((s) => (
              <li key={s.deliverableId} className="flex gap-1.5">
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="font-mono text-fg-muted">{s.versionNumber ? `V${s.versionNumber}` : "—"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {readiness.pendingChanges.length ? (
        <TipAnchor tip="card.pending-changes" facts={{ pendingCount: readiness.pendingChanges.length, status, canPublish: perms.canPublish }}>
        <div className="mt-2 rounded-md border border-state-review/40 bg-state-review/[0.07] p-2 text-[12px]">
          <p className="font-semibold text-state-review">Changed since it was {PRODUCTION_META[status].label.toLowerCase()}</p>
          <ul className="mt-1 grid gap-1">
            {readiness.pendingChanges.map((p) => (
              <li key={`${p.deliverableId}-${p.detail}`}>
                {multi ? (
                  <button type="button" onClick={() => openDeliverable(p.deliverableId)} className="inline-flex min-h-6 items-center font-medium hover:underline">
                    {p.name}
                  </button>
                ) : (
                  <span className="font-medium">{p.name}</span>
                )}
                <span className="block text-fg-muted">{p.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-fg-subtle">The recorded revisions above are unchanged. New work is never treated as approved or released.</p>
        </div>
        </TipAnchor>
      ) : null}

      {status === "TODO" ? (
        readiness.ready ? (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-state-approved">
            <CircleCheck className="size-4" /> Every required deliverable is approved.
          </p>
        ) : (
          <div className="mt-2 text-[12px]">
            <p className="flex items-center gap-1.5 font-medium text-fg-muted">
              <CircleAlert className="size-4 text-state-review" /> Before it can be completed:
            </p>
            <ul className="mt-1 grid gap-1">
              {readiness.blockers.slice(0, 8).map((b) => (
                <li key={`${b.deliverableId}-${b.reason}`} className="rounded-md bg-surface-3/50 px-2 py-1">
                  {b.deliverableId && multi ? (
                    <button type="button" onClick={() => openDeliverable(b.deliverableId)} className="inline-flex min-h-6 items-center font-medium hover:underline">
                      {b.name}
                    </button>
                  ) : (
                    <span className="font-medium">{b.name}</span>
                  )}
                  <span className="block text-fg-muted">{b.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      <div className="mt-3 grid gap-1.5">
        {actions
          .filter((a) => a.allowed || a.primary)
          .map((a) => {
            const disabled = !a.allowed || (a.needsReady && !readiness.ready);
            return (
              <Button
                key={`${a.to}-${a.label}`}
                variant={a.primary ? "primary" : a.to === "TODO" ? "ghost" : "secondary"}
                size="sm"
                disabled={disabled}
                title={!a.allowed ? (a.to === "PUBLISHED" || status === "PUBLISHED" ? "Only managers can change Published" : "You can't change this card's stage") : a.needsReady && !readiness.ready ? "Waiting on the deliverables listed above" : undefined}
                onClick={() => setTarget(a.to)}
              >
                {a.to === "TODO" ? <Undo2 /> : null} {a.label}
              </Button>
            );
          })}
      </div>

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent
          title={target ? `${target === "TODO" ? "Move back to To-do" : `Mark ${PRODUCTION_META[target].label.toLowerCase()}`}` : ""}
          description={
            target === "PUBLISHED"
              ? "Records that this work is released / in use. Nothing is deployed to Roblox."
              : target === "COMPLETED"
                ? "Records the approved revisions as complete and ready for release."
                : "Approvals and history stay exactly as they are."
          }
        >
          {target && target !== "TODO" ? (
            <ul className="mb-3 grid gap-0.5 rounded-md border border-border bg-surface-3/40 p-2 text-[12.5px]">
              {card.deliverables
                .filter((d) => !d.archivedAt)
                .map((d) => {
                  const version = card.versions.find((v) => v.id === d.approvedVersionId);
                  return (
                    <li key={d.id} className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {d.name}
                        {!d.required ? <span className="text-fg-subtle"> · optional</span> : null}
                      </span>
                      <span className="font-mono text-fg-muted">{d.state === "APPROVED" && version ? `V${version.number} approved` : "not included"}</span>
                    </li>
                  );
                })}
            </ul>
          ) : null}
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note (e.g. which build it shipped in)" maxLength={2000} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={move.isPending} onClick={() => target && move.mutate({ cardId: card.id, status: target, note: note.trim() || undefined })}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
