"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Box, CircleAlert, CircleCheck, Film, Image as ImageIcon, File as FileIcon, Music, RefreshCw, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { qk } from "@/lib/queries";
import { errorMessage, rpc } from "@/lib/rpc-client";
import type { AttachmentDTO } from "@/lib/types";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "../ui/button";

type Purpose = "version" | "attachment" | "comment" | "resource" | "cover";

export interface UploadItem {
  id: string;
  cardId: string;
  cardTitle: string;
  file: File;
  purpose: Purpose;
  versionId: string | null;
  deliverableId: string | null;
  progress: number;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  error?: string;
  attachment?: AttachmentDTO;
}

export interface UploadTarget {
  id: string;
  projectId: string;
  title: string;
  /** The deliverable new revisions/files belong to. Omitted for simple (single-deliverable) cards. */
  deliverableId?: string | null;
  /** Shown in the tray, e.g. the deliverable's name. */
  label?: string;
}

interface UploadContextValue {
  items: UploadItem[];
  /** Uploads files as a brand-new revision (V+1) of one deliverable. */
  uploadVersion: (card: UploadTarget, files: File[], options?: { notes?: string; submit?: boolean }) => Promise<AttachmentDTO[]>;
  /** Uploads reference files (or comment attachments) without creating a version. */
  uploadFiles: (card: UploadTarget, files: File[], purpose: Exclude<Purpose, "version">) => Promise<AttachmentDTO[]>;
  retry: (itemId: string) => void;
  dismiss: (itemId: string) => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

export function useUploads() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUploads must be used inside <UploadProvider>");
  return ctx;
}

function putWithProgress(url: string, file: File, headers: Record<string, string>, onProgress: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = `Upload failed (${xhr.status}).`;
        try {
          message = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          // not JSON (e.g. S3 XML error)
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.send(file);
  });
}

/** Reads duration/dimensions in the browser — used when the server has no ffmpeg. */
async function clientMeta(file: File): Promise<{ durationMs?: number; width?: number; height?: number } | undefined> {
  if (!file.type.startsWith("video/")) return undefined;
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value?: { durationMs?: number; width?: number; height?: number }) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), 4000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      done({
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      });
    };
    video.onerror = () => {
      clearTimeout(timer);
      done(undefined);
    };
    video.src = url;
  });
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  const projects = useRef(new Map<string, string>());

  const patch = useCallback((id: string, update: Partial<UploadItem>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...update } : i)));
  }, []);

  const refresh = useCallback(
    (cardId: string) => {
      void queryClient.invalidateQueries({ queryKey: qk.card(cardId) });
      const projectId = projects.current.get(cardId);
      if (projectId) void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
    },
    [queryClient],
  );

  const run = useCallback(
    async (item: UploadItem): Promise<AttachmentDTO> => {
      patch(item.id, { status: "uploading", progress: 0, error: undefined });
      try {
        const intent = await rpc("upload.create", {
          cardId: item.cardId,
          filename: item.file.name || "pasted-image.png",
          size: item.file.size,
          contentType: item.file.type || "application/octet-stream",
          purpose: item.purpose,
          versionId: item.versionId,
          deliverableId: item.purpose === "version" ? null : item.deliverableId,
        });
        await putWithProgress(intent.upload.url, item.file, intent.upload.headers, (p) => patch(item.id, { progress: p }));
        patch(item.id, { status: "processing", progress: 1 });
        const attachment = await rpc("upload.complete", { attachmentId: intent.attachmentId, clientMeta: await clientMeta(item.file) });
        patch(item.id, { status: "done", attachment });
        // Finished uploads disappear from the tray after a moment.
        setTimeout(() => setItems((list) => list.filter((i) => i.id !== item.id)), 4000);
        return attachment;
      } catch (error) {
        patch(item.id, { status: "error", error: errorMessage(error) });
        throw error;
      }
    },
    [patch],
  );

  const enqueue = useCallback(
    async (card: UploadTarget, files: File[], purpose: Purpose, versionId: string | null) => {
      projects.current.set(card.id, card.projectId);
      const created: UploadItem[] = files.map((file) => ({
        id: crypto.randomUUID(),
        cardId: card.id,
        cardTitle: card.label ? `${card.title} › ${card.label}` : card.title,
        file,
        purpose,
        versionId,
        deliverableId: card.deliverableId ?? null,
        progress: 0,
        status: "queued",
      }));
      setItems((list) => [...list, ...created]);
      const results: AttachmentDTO[] = [];
      // Sequential keeps bandwidth focused so the first file finishes first.
      for (const item of created) {
        try {
          results.push(await run(item));
        } catch {
          // shown in the tray with a retry button
        }
        refresh(card.id);
      }
      return results;
    },
    [refresh, run],
  );

  const uploadVersion = useCallback<UploadContextValue["uploadVersion"]>(
    async (card, files, options = {}) => {
      if (files.length === 0) return [];
      let version: { id: string; number: number; deliverableId: string };
      try {
        version = await rpc("version.create", card.deliverableId ? { deliverableId: card.deliverableId, notes: options.notes } : { cardId: card.id, notes: options.notes });
      } catch (error) {
        toast.error(errorMessage(error));
        return [];
      }
      refresh(card.id);
      const results = await enqueue(card, files, "version", version.id);
      if (results.length === files.length) {
        if (options.submit) {
          try {
            await rpc("review.submit", { deliverableId: version.deliverableId, versionId: version.id });
            toast.success(`V${version.number} uploaded and submitted for review.`);
          } catch (error) {
            toast.error(errorMessage(error));
          }
          refresh(card.id);
        } else {
          toast.success(`V${version.number} uploaded to “${card.label ?? card.title}”.`);
        }
      }
      return results;
    },
    [enqueue, refresh],
  );

  const uploadFiles = useCallback<UploadContextValue["uploadFiles"]>(
    (card, files, purpose) => enqueue(card, files, purpose, null),
    [enqueue],
  );

  const retry = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;
      void run(item)
        .then(() => refresh(item.cardId))
        .catch(() => {});
    },
    [items, refresh, run],
  );

  const dismiss = useCallback((itemId: string) => setItems((list) => list.filter((i) => i.id !== itemId)), []);

  const value = useMemo(() => ({ items, uploadVersion, uploadFiles, retry, dismiss }), [items, uploadVersion, uploadFiles, retry, dismiss]);

  return (
    <UploadContext.Provider value={value}>
      {children}
      <UploadTray items={items.filter((i) => i.purpose !== "comment")} onRetry={retry} onDismiss={dismiss} />
    </UploadContext.Provider>
  );
}

function kindIcon(file: File) {
  if (file.type.startsWith("video/")) return <Film />;
  if (file.type.startsWith("image/")) return <ImageIcon />;
  if (file.type.startsWith("audio/") || /\.(mp3|ogg|oga)$/i.test(file.name)) return <Music />;
  if (/\.rbxm?x?$|\.rbxlx?$/i.test(file.name)) return <Box />;
  return <FileIcon />;
}

function UploadTray({ items, onRetry, onDismiss }: { items: UploadItem[]; onRetry: (id: string) => void; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-4 z-[70] w-80 max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-border-strong bg-surface-2 shadow-lg animate-slide-up" role="status" aria-live="polite">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold text-fg-muted">
        Uploads · {items.filter((i) => i.status === "done").length}/{items.length} done
      </div>
      <ul className="scrollbar-thin max-h-64 overflow-y-auto">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2.5 px-3 py-2 text-[12.5px]">
            <span className="text-fg-subtle [&_svg]:size-4">{kindIcon(item.file)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{item.file.name || "Pasted image"}</p>
              <p className={cn("truncate text-[11px]", item.status === "error" ? "text-danger" : "text-fg-subtle")}>
                {item.status === "error"
                  ? `Upload failed — ${item.error}`
                  : item.status === "processing"
                    ? "Checking the file…"
                    : item.status === "done"
                      ? `Added to ${item.cardTitle}`
                      : `${Math.round(item.progress * 100)}% · ${formatBytes(item.file.size)}`}
              </p>
              {item.status === "uploading" || item.status === "queued" ? (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-4">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.max(3, item.progress * 100)}%` }} />
                </div>
              ) : null}
            </div>
            {item.status === "done" ? <CircleCheck className="size-4 text-state-approved" /> : null}
            {item.status === "processing" ? <span className="size-3.5 animate-spin rounded-full border-2 border-fg-subtle border-t-transparent" /> : null}
            {item.status === "error" ? (
              <>
                <CircleAlert className="size-4 text-danger" />
                <Button size="xs" variant="secondary" onClick={() => onRetry(item.id)}>
                  <RefreshCw /> Retry
                </Button>
                <button type="button" aria-label="Dismiss" onClick={() => onDismiss(item.id)} className="text-fg-subtle hover:text-fg">
                  <X className="size-3.5" />
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
