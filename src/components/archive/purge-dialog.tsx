"use client";

import { CircleCheck, CircleX, Info, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, rpc, type RpcOutput } from "@/lib/rpc-client";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";

export type PurgeTarget = { type: "project" | "board" | "column" | "card" | "deliverable" | "attachment"; id: string };
type Preview = RpcOutput<"archive.preview">;
type Result = RpcOutput<"archive.purge">["results"][number];

const TYPE_LABEL: Record<PurgeTarget["type"], string> = { project: "Project", board: "Board", column: "Column", card: "Card", deliverable: "Deliverable", attachment: "File" };
/** Items per request, so progress is visible and one slow item doesn't hold up the rest. */
const CHUNK = 10;

function scopeText(counts: Preview["items"][number]["counts"], type: PurgeTarget["type"]) {
  const parts: string[] = [];
  if (type !== "card" && counts.cards) parts.push(`${counts.cards} card${counts.cards === 1 ? "" : "s"}`);
  if (counts.deliverables && type !== "deliverable") parts.push(`${counts.deliverables} deliverable${counts.deliverables === 1 ? "" : "s"}`);
  if (counts.revisions) parts.push(`${counts.revisions} revision${counts.revisions === 1 ? "" : "s"}`);
  if (counts.files && type !== "attachment") parts.push(`${counts.files} file${counts.files === 1 ? "" : "s"}`);
  if (counts.comments) parts.push(`${counts.comments} comment${counts.comments === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Reviews and runs a permanent deletion: the server's preview shows exactly what goes (with
 * everything inside it), what can't and why, and how much storage comes back; deletion runs in
 * small batches with progress and a per-item result.
 */
export function PurgeDialog({ open, onOpenChange, targets, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; targets: PurgeTarget[]; onDone: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<Result[] | null>(null);
  const [freed, setFreed] = useState(0);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    setConfirm("");
    setResults(null);
    setFreed(0);
    setProgress({ done: 0, total: 0 });
    let cancelled = false;
    rpc("archive.preview", { targets })
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [open, targets]);

  const eligible = preview?.items.filter((i) => i.eligible && !i.includedIn) ?? [];
  const included = preview?.items.filter((i) => i.includedIn) ?? [];
  const blocked = preview?.items.filter((i) => !i.eligible && !i.includedIn) ?? [];

  async function run() {
    setRunning(true);
    const all: Result[] = [];
    let bytes = 0;
    setProgress({ done: 0, total: eligible.length });
    for (let i = 0; i < eligible.length; i += CHUNK) {
      const chunk = eligible.slice(i, i + CHUNK).map((x) => ({ type: x.type, id: x.id }));
      try {
        const res = await rpc("archive.purge", { targets: chunk, confirm: "DELETE" });
        all.push(...res.results);
        bytes += res.bytes;
      } catch (e) {
        for (const x of eligible.slice(i, i + CHUNK)) all.push({ type: x.type, id: x.id, label: x.label, status: "failed", reason: errorMessage(e) });
      }
      setProgress({ done: Math.min(i + CHUNK, eligible.length), total: eligible.length });
    }
    setResults(all);
    setFreed(bytes);
    setRunning(false);
    onDone();
  }

  const failed = results?.filter((r) => r.status !== "deleted") ?? [];
  return (
    <Dialog open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <DialogContent title={results ? "Deletion finished" : "Delete permanently?"} description={results ? undefined : "Archived items only. This can't be undone, and restoring won't be possible afterwards."} size="lg">
        <div className="scrollbar-thin grid max-h-[60vh] gap-4 overflow-y-auto pr-1 text-[13px]">
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-danger">{error}</p> : null}
          {!preview && !error ? (
            <p className="flex items-center gap-2 text-fg-muted">
              <Loader2 className="size-4 animate-spin" /> Working out what would be deleted…
            </p>
          ) : null}

          {preview && !results ? (
            <>
              <div className="rounded-lg border border-danger/40 bg-danger/5 p-3">
                <p className="font-medium">
                  {eligible.length} item{eligible.length === 1 ? "" : "s"} · frees about {formatBytes(preview.totals.bytes)}
                </p>
                <p className="mt-0.5 text-[12px] text-fg-muted">
                  Including {preview.totals.cards ? `${preview.totals.cards} card${preview.totals.cards === 1 ? "" : "s"}, ` : ""}
                  {preview.totals.deliverables} deliverable{preview.totals.deliverables === 1 ? "" : "s"}, {preview.totals.revisions} revision{preview.totals.revisions === 1 ? "" : "s"},{" "}
                  {preview.totals.files} file{preview.totals.files === 1 ? "" : "s"} and {preview.totals.comments} comment{preview.totals.comments === 1 ? "" : "s"}.
                  {preview.totals.sharedFiles ? ` ${preview.totals.sharedFiles} file${preview.totals.sharedFiles === 1 ? " is" : "s are"} also used by other cards and will be kept.` : ""}
                </p>
              </div>
              {eligible.length ? (
                <section aria-label="Will be deleted">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Will be deleted</h3>
                  <ul className="grid gap-1">
                    {eligible.map((i) => (
                      <li key={`${i.type}:${i.id}`} className="flex flex-wrap items-baseline gap-x-2 rounded-md border border-border px-2.5 py-1.5">
                        <span className="text-[11px] text-fg-subtle">{TYPE_LABEL[i.type]}</span>
                        <span className="min-w-0 flex-1 truncate font-medium">{i.label}</span>
                        <span className="text-[11.5px] text-fg-muted">{scopeText(i.counts, i.type)}</span>
                        <span className="text-[11.5px] text-fg-subtle">{formatBytes(i.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {included.length ? (
                <p className="flex items-start gap-1.5 text-[12px] text-fg-muted">
                  <Info className="mt-0.5 size-3.5 shrink-0" /> {included.length} selected item{included.length === 1 ? " is" : "s are"} already inside another selection ({included.map((i) => i.label).join(", ")}).
                </p>
              ) : null}
              {blocked.length ? (
                <section aria-label="Can't be deleted">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Skipped</h3>
                  <ul className="grid gap-1">
                    {blocked.map((i) => (
                      <li key={`${i.type}:${i.id}`} className="rounded-md border border-dashed border-border-strong px-2.5 py-1.5">
                        <span className="font-medium">{i.label}</span> <span className="text-fg-muted">— {i.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {eligible.length ? (
                <label className="grid gap-1 text-[12px] text-fg-muted">
                  Type <strong className="font-mono text-fg">DELETE</strong> to confirm
                  <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="DELETE" autoComplete="off" className="font-mono" aria-label="Type DELETE to confirm" />
                </label>
              ) : null}
              {running ? (
                <div role="status" aria-live="polite" className="grid gap-1">
                  <div className="h-2 overflow-hidden rounded-full bg-surface-4">
                    <div className="h-full rounded-full bg-danger transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                  </div>
                  <p className="text-[12px] text-fg-muted">
                    Deleted {progress.done} of {progress.total}…
                  </p>
                </div>
              ) : null}
            </>
          ) : null}

          {results ? (
            <>
              <p role="status" className="flex items-center gap-2 font-medium">
                <CircleCheck className="size-4 text-state-approved" /> {results.filter((r) => r.status === "deleted").length} deleted · about {formatBytes(freed)} freed
              </p>
              {failed.length ? (
                <ul className="grid gap-1">
                  {failed.map((r) => (
                    <li key={`${r.type}:${r.id}`} className="flex items-start gap-1.5 text-fg-muted">
                      <CircleX className={cn("mt-0.5 size-3.5 shrink-0", r.status === "failed" ? "text-danger" : "text-fg-subtle")} />
                      <span>
                        <strong className="text-fg">{r.label}</strong> — {r.status === "failed" ? "failed" : "skipped"}: {r.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[12px] text-fg-subtle">Stored files are removed in the background; anything still used elsewhere is kept.</p>
            </>
          ) : null}
        </div>
        <DialogFooter>
          {results ? (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" disabled={running} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="danger" loading={running} disabled={!eligible.length || confirm.trim() !== "DELETE"} onClick={() => void run()}>
                <Trash2 /> Delete {eligible.length || ""} permanently
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
