"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { CardSummaryDTO } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { ColumnIcon } from "../domain/column-icon";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { EmptyState, Skeleton } from "../ui/controls";
import { ConfirmDialog, Dialog, DialogContent } from "../ui/dialog";
import { Input } from "../ui/input";

export function ArchivedItems({ projectId, canDelete, canRestoreColumns }: { projectId: string; canDelete: boolean; canRestoreColumns: boolean }) {
  const queryClient = useQueryClient();
  const archived = useQuery({ queryKey: qk.archived(projectId), queryFn: () => rpc("board.archived", { projectId }) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.archived(projectId) });
    void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
  };
  const restoreCard = useRpcMutation("card.archive", { onSuccess: () => { refresh(); toast.success("Card restored to the board."); } });
  const restoreColumn = useRpcMutation("column.archive", { onSuccess: () => { refresh(); toast.success("Column restored."); } });
  const deleteCard = useRpcMutation("card.delete", { onSuccess: () => { refresh(); setPending(null); toast.success("Card permanently deleted."); } });
  const [pending, setPending] = useState<CardSummaryDTO | null>(null);
  const [confirm, setConfirm] = useState("");

  if (archived.isLoading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
    );
  }
  const data = archived.data;
  if (!data || (data.cards.length === 0 && data.columns.length === 0)) {
    return <EmptyState title="Nothing archived" description="Archived cards and columns appear here and can be restored at any time." />;
  }
  return (
    <div className="grid gap-5">
      {data.columns.length ? (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Columns</h3>
          <ul className="grid gap-1">
            {data.columns.map((c) => (
              <li key={c.id} className="flex items-center gap-2.5 rounded-md border border-border bg-surface-3/40 px-3 py-2">
                <ColumnIcon name={c.icon} color={c.color} />
                <span className="flex-1 text-[13px] font-medium">{c.name}</span>
                <span className="text-[11px] text-fg-subtle">archived {timeAgo(c.archivedAt)}</span>
                {canRestoreColumns ? (
                  <Button size="xs" variant="secondary" loading={restoreColumn.isPending && restoreColumn.variables?.columnId === c.id} onClick={() => restoreColumn.mutate({ columnId: c.id, archived: false })}>
                    <ArchiveRestore /> Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.cards.length ? (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Cards</h3>
          <ul className="grid gap-1">
            {data.cards.map((card) => (
              <li key={card.id} className="flex items-center gap-2.5 rounded-md border border-border bg-surface-3/40 px-3 py-2">
                <span className="font-mono text-[11px] text-fg-subtle">{card.key}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{card.title}</span>
                <StatePill state={card.state} size="sm" />
                <Button size="xs" variant="secondary" loading={restoreCard.isPending && restoreCard.variables?.cardId === card.id} onClick={() => restoreCard.mutate({ cardId: card.id, archived: false })}>
                  <ArchiveRestore /> Restore
                </Button>
                {canDelete ? (
                  <Button size="icon-xs" variant="danger-ghost" aria-label={`Delete ${card.title} permanently`} onClick={() => { setConfirm(""); setPending(card); }}>
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        title="Delete card permanently?"
        destructive
        confirmLabel="Delete forever"
        loading={deleteCard.isPending}
        confirmDisabled={confirm.trim().toUpperCase() !== pending?.key.toUpperCase()}
        onConfirm={() => pending && deleteCard.mutate({ cardId: pending.id, confirm })}
        description={
          <>
            This removes <strong>{pending?.title}</strong>, all of its versions, media, feedback and history. This can&apos;t be undone. Type <strong className="font-mono">{pending?.key}</strong> to confirm.
          </>
        }
      >
        <Input className="mt-3 font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={pending?.key} aria-label="Type the card key to confirm" />
      </ConfirmDialog>
    </div>
  );
}

export function ArchivedDialog({ open, onOpenChange, projectId, canDelete, canRestoreColumns }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; canDelete: boolean; canRestoreColumns: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Archived items" description="Nothing in production history is lost — restore cards and columns here." size="lg">
        <div className="scrollbar-thin max-h-[60vh] overflow-y-auto pr-1">{open ? <ArchivedItems projectId={projectId} canDelete={canDelete} canRestoreColumns={canRestoreColumns} /> : null}</div>
      </DialogContent>
    </Dialog>
  );
}
