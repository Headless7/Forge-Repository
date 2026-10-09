"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { PurgeDialog, type PurgeTarget } from "../archive/purge-dialog";
import { ColumnIcon } from "../domain/column-icon";
import { StatePill } from "../domain/state";
import { Button } from "../ui/button";
import { Checkbox, EmptyState, Skeleton } from "../ui/controls";
import { Dialog, DialogContent } from "../ui/dialog";

type Kind = "board" | "column" | "card" | "deliverable" | "attachment";
const FILTERS: Array<{ id: Kind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "card", label: "Cards" },
  { id: "board", label: "Boards" },
  { id: "column", label: "Columns" },
  { id: "deliverable", label: "Deliverables" },
  { id: "attachment", label: "Files" },
];

interface Row {
  kind: Kind;
  id: string;
  title: ReactNode;
  meta: ReactNode;
  bytes: number;
  /** Why it can't be selected for permanent deletion (shown instead of the checkbox). */
  locked?: string;
  restore?: () => void;
  restoring?: boolean;
}

function Section({ title, rows, selected, onToggle, canDelete }: { title: string; rows: Row[]; selected: Set<string>; onToggle: (keys: string[], on: boolean) => void; canDelete: boolean }) {
  if (!rows.length) return null;
  const selectable = rows.filter((r) => !r.locked).map((r) => `${r.kind}:${r.id}`);
  const all = selectable.length > 0 && selectable.every((k) => selected.has(k));
  const some = selectable.some((k) => selected.has(k));
  return (
    <section aria-label={title}>
      <div className="mb-1.5 flex items-center gap-2">
        {canDelete && selectable.length ? (
          <Checkbox
            checked={all ? true : some ? "indeterminate" : false}
            onCheckedChange={(v) => onToggle(selectable, v === true)}
            aria-label={`Select all archived ${title.toLowerCase()}`}
          />
        ) : null}
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          {title} · {rows.length}
        </h3>
      </div>
      <ul className="grid grid-cols-1 gap-1">
        {rows.map((r) => {
          const key = `${r.kind}:${r.id}`;
          return (
            <li key={key} className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-border bg-surface-3/40 px-3 py-2", selected.has(key) && "border-danger/50 bg-danger/5")}>
              {canDelete ? (
                r.locked ? (
                  <span className="size-4" aria-hidden />
                ) : (
                  <Checkbox checked={selected.has(key)} onCheckedChange={(v) => onToggle([key], v === true)} aria-label={`Select ${typeof r.title === "string" ? r.title : r.id}`} />
                )
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{r.title}</span>
                <span className="block truncate text-[11.5px] text-fg-subtle">
                  {r.meta}
                  {r.bytes ? ` · ${formatBytes(r.bytes)}` : ""}
                  {r.locked ? <span className="text-fg-muted"> · {r.locked}</span> : null}
                </span>
              </span>
              {r.restore ? (
                <Button size="xs" variant="secondary" loading={r.restoring} onClick={r.restore}>
                  <ArchiveRestore /> Restore
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Everything archived in a project: restore items one by one, or (owners and admins) select them
 * for permanent deletion to reclaim storage. Archiving a column doesn't archive its cards, so a
 * column with active cards can't be deleted until they're moved or archived.
 */
export function ArchivedItems({ projectId, canDelete, canRestoreColumns }: { projectId: string; canDelete: boolean; canRestoreColumns: boolean }) {
  const queryClient = useQueryClient();
  const archived = useQuery({ queryKey: qk.archived(projectId), queryFn: () => rpc("board.archived", { projectId }) });
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState<PurgeTarget[] | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.archived(projectId) });
    void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["storage"] });
  };
  const restoreCard = useRpcMutation("card.archive", { onSuccess: () => { refresh(); toast.success("Card restored to the board."); } });
  const restoreColumn = useRpcMutation("column.archive", { onSuccess: () => { refresh(); toast.success("Column restored."); } });
  const restoreBoard = useRpcMutation("board.archive", { onSuccess: () => { refresh(); toast.success("Board restored."); } });
  const restoreDeliverable = useRpcMutation("deliverable.archive", { onSuccess: () => { refresh(); toast.success("Deliverable restored."); } });
  const restoreFile = useRpcMutation("attachment.restore", { onSuccess: () => { refresh(); toast.success("File restored."); } });

  const data = archived.data;
  const rows = useMemo<Record<Kind, Row[]>>(() => {
    if (!data) return { board: [], column: [], card: [], deliverable: [], attachment: [] };
    const onBoard = (name: string) => (data.multipleBoards && name ? ` · ${name} board` : "");
    return {
      board: data.boards.map((b) => ({
        kind: "board" as const,
        id: b.id,
        title: b.name,
        meta: `archived ${timeAgo(b.archivedAt)} · ${b.cards} card${b.cards === 1 ? "" : "s"} · ${b.files} file${b.files === 1 ? "" : "s"}`,
        bytes: b.bytes,
        restore: canRestoreColumns ? () => restoreBoard.mutate({ boardId: b.id, archived: false }) : undefined,
        restoring: restoreBoard.isPending && restoreBoard.variables?.boardId === b.id,
      })),
      column: data.columns.map((c) => ({
        kind: "column" as const,
        id: c.id,
        title: (
          <span className="inline-flex items-center gap-1.5">
            <ColumnIcon name={c.icon} color={c.color} /> {c.name}
          </span>
        ),
        meta: `archived ${timeAgo(c.archivedAt)}${onBoard(c.boardName)} · ${c.activeCards} active, ${c.archivedCards} archived card${c.archivedCards === 1 ? "" : "s"}`,
        bytes: c.bytes,
        locked: c.activeCards ? "has active cards — move or archive them first" : undefined,
        restore: canRestoreColumns ? () => restoreColumn.mutate({ columnId: c.id, archived: false }) : undefined,
        restoring: restoreColumn.isPending && restoreColumn.variables?.columnId === c.id,
      })),
      card: data.cards.map((card) => ({
        kind: "card" as const,
        id: card.id,
        title: (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="font-mono text-[11px] text-fg-subtle">{card.key}</span>
            <span className="truncate">{card.title}</span>
            <StatePill state={card.state} size="sm" />
          </span>
        ),
        meta: `archived ${card.archivedAt ? timeAgo(card.archivedAt) : ""}${onBoard(card.boardName)} · ${card.files} file${card.files === 1 ? "" : "s"}`,
        bytes: card.bytes,
        restore: () => restoreCard.mutate({ cardId: card.id, archived: false }),
        restoring: restoreCard.isPending && restoreCard.variables?.cardId === card.id,
      })),
      deliverable: data.deliverables.map((d) => ({
        kind: "deliverable" as const,
        id: d.id,
        title: `D${d.number} ${d.name}`,
        meta: `${d.cardKey} ${d.cardTitle} · archived ${timeAgo(d.archivedAt)} · ${d.files} file${d.files === 1 ? "" : "s"}`,
        bytes: d.bytes,
        restore: () => restoreDeliverable.mutate({ deliverableId: d.id, archived: false }),
        restoring: restoreDeliverable.isPending && restoreDeliverable.variables?.deliverableId === d.id,
      })),
      attachment: data.attachments.map((a) => ({
        kind: "attachment" as const,
        id: a.id,
        title: a.filename,
        meta: `${a.cardKey}${a.deliverableName ? ` · ${a.deliverableName}` : ""} · archived ${timeAgo(a.archivedAt)}`,
        bytes: a.bytes,
        locked: a.sharedResource ? "used as a Roblox resource by other models" : undefined,
        restore: () => restoreFile.mutate({ attachmentId: a.id }),
        restoring: restoreFile.isPending && restoreFile.variables?.attachmentId === a.id,
      })),
    };
  }, [data, canRestoreColumns, restoreBoard, restoreCard, restoreColumn, restoreDeliverable, restoreFile]);

  if (archived.isLoading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-11" />
        ))}
      </div>
    );
  }
  // Rendered in the same place whether or not anything is left, so deleting everything doesn't
  // remount the dialog and lose its results.
  const purgeDialog = purging ? (
    <PurgeDialog
      open
      onOpenChange={(open) => !open && setPurging(null)}
      targets={purging}
      onDone={() => {
        setSelected(new Set());
        refresh();
      }}
    />
  ) : null;
  const total = rows.board.length + rows.column.length + rows.card.length + rows.deliverable.length + rows.attachment.length;
  if (!data || total === 0) {
    return (
      <>
        <EmptyState title="Nothing archived" description="Archived cards, columns, deliverables and files appear here and can be restored at any time." />
        {purgeDialog}
      </>
    );
  }
  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const visible = (kind: Kind) => filter === "all" || filter === kind;
  const selectedRows = (Object.values(rows).flat() as Row[]).filter((r) => selected.has(`${r.kind}:${r.id}`));
  const selectedBytes = selectedRows.reduce((n, r) => n + r.bytes, 0);

  return (
    <>
      <div className="grid grid-cols-1 gap-4">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Show">
          {FILTERS.map((f) => {
            const count = f.id === "all" ? total : rows[f.id].length;
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cn("h-8 rounded-md px-2.5 text-[12.5px] font-medium", filter === f.id ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")}
              >
                {f.label} <span className="text-fg-subtle">{count}</span>
              </button>
            );
          })}
        </div>
        {visible("card") ? <Section title="Cards" rows={rows.card} selected={selected} onToggle={toggle} canDelete={canDelete} /> : null}
        {visible("board") ? <Section title="Boards" rows={rows.board} selected={selected} onToggle={toggle} canDelete={canDelete} /> : null}
        {visible("column") ? <Section title="Columns" rows={rows.column} selected={selected} onToggle={toggle} canDelete={canDelete} /> : null}
        {visible("deliverable") ? <Section title="Deliverables" rows={rows.deliverable} selected={selected} onToggle={toggle} canDelete={canDelete} /> : null}
        {visible("attachment") ? <Section title="Files" rows={rows.attachment} selected={selected} onToggle={toggle} canDelete={canDelete} /> : null}

        {canDelete && selectedRows.length ? (
          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-surface-2 px-3 py-2 shadow-lg">
            <span className="flex-1 text-[13px]">
              <strong>{selectedRows.length}</strong> selected · up to {formatBytes(selectedBytes)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" variant="danger" onClick={() => setPurging(selectedRows.map((r) => ({ type: r.kind, id: r.id })))}>
              <Trash2 /> Delete permanently…
            </Button>
          </div>
        ) : null}
      </div>
      {purgeDialog}
    </>
  );
}

export function ArchivedDialog({ open, onOpenChange, projectId, canDelete, canRestoreColumns }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; canDelete: boolean; canRestoreColumns: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Archived items" description="Restore anything archived, or permanently delete it to free storage." size="lg">
        <div>{open ? <ArchivedItems projectId={projectId} canDelete={canDelete} canRestoreColumns={canRestoreColumns} /> : null}</div>
      </DialogContent>
    </Dialog>
  );
}
