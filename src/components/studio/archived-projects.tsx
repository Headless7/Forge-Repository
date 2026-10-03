"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, FolderArchive, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { PurgeDialog, type PurgeTarget } from "../archive/purge-dialog";
import { Button } from "../ui/button";
import { Checkbox, Skeleton } from "../ui/controls";

/** The studio owner's archive of projects: restore them, or delete them permanently to free storage. */
export function ArchivedProjects({ studioId }: { studioId: string }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["archived-projects", studioId], queryFn: () => rpc("archive.projects", { studioId }) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState<PurgeTarget[] | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["archived-projects", studioId] });
    void queryClient.invalidateQueries({ queryKey: qk.projects(studioId) });
    void queryClient.invalidateQueries({ queryKey: ["storage", studioId] });
  };
  const restore = useRpcMutation("project.archive", {
    onSuccess: () => {
      refresh();
      toast.success("Project restored.");
    },
  });
  const rows = list.data ?? [];
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const all = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const chosen = rows.filter((p) => selected.has(p.id));

  return (
    <section className="rounded-xl border border-border bg-surface-2 p-5" aria-label="Archived projects">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        <FolderArchive className="size-4 text-fg-muted" /> Archived projects
      </h2>
      <p className="mt-0.5 text-[12.5px] text-fg-muted">Only you, the owner, can restore archived projects or delete them permanently.</p>
      <div className="mt-4">
        {list.isLoading ? (
          <Skeleton className="h-12" />
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-fg-muted">No archived projects.</p>
        ) : (
          <>
            <label className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              <Checkbox checked={all ? true : chosen.length ? "indeterminate" : false} onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((p) => p.id)) : new Set())} aria-label="Select all archived projects" />
              Select all
            </label>
            <ul className="grid gap-1">
              {rows.map((p) => (
                <li key={p.id} className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-border bg-surface-3/40 px-3 py-2", selected.has(p.id) && "border-danger/50 bg-danger/5")}>
                  <Checkbox checked={selected.has(p.id)} onCheckedChange={(v) => toggle(p.id, v === true)} aria-label={`Select ${p.name}`} />
                  <span className="text-lg" aria-hidden>
                    {p.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{p.name}</span>
                    <span className="block truncate text-[11.5px] text-fg-subtle">
                      archived {timeAgo(p.archivedAt)} · {p.cards} card{p.cards === 1 ? "" : "s"} · {p.files} file{p.files === 1 ? "" : "s"} · {formatBytes(p.bytes)}
                    </span>
                  </span>
                  <Button size="xs" variant="secondary" loading={restore.isPending && restore.variables?.projectId === p.id} onClick={() => restore.mutate({ projectId: p.id, archived: false })}>
                    <ArchiveRestore /> Restore
                  </Button>
                </li>
              ))}
            </ul>
            {chosen.length ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 px-3 py-2">
                <span className="flex-1 text-[13px]">
                  <strong>{chosen.length}</strong> selected · up to {formatBytes(chosen.reduce((n, p) => n + p.bytes, 0))}
                </span>
                <Button size="sm" variant="danger" onClick={() => setPurging(chosen.map((p) => ({ type: "project" as const, id: p.id })))}>
                  <Trash2 /> Delete permanently…
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      {purging ? (
        <PurgeDialog
          open
          onOpenChange={(open) => !open && setPurging(null)}
          targets={purging}
          onDone={() => {
            setSelected(new Set());
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}
