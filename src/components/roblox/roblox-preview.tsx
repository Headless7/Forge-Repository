"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Download, Loader2, RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { qk } from "@/lib/queries";
import { errorMessage, rpc, RpcError } from "@/lib/rpc-client";
import { buildClip, buildRigSolver } from "@/lib/roblox/animation";
import { ROBLOX_MANIFEST_VERSION, type ResourceUse, type RigInfo, type RobloxFileMeta, type RobloxManifest } from "@/lib/roblox/manifest";
import type { AttachmentDTO } from "@/lib/types";
import type { TimelineHandle } from "../card/workspace-context";
import { Select } from "../ui/controls";
import { useScope } from "../card/workspace-context";
import { useUploads } from "../upload/upload-manager";
import type { ResolvedResource } from "./resources";
import { looksLikeR6, standardR6Manifest } from "./standard-rig";
import type { RigChoice, TimeMarker, ViewerMode } from "./viewer";

const RobloxViewer = dynamic(() => import("./viewer"), {
  ssr: false,
  loading: () => <Centered>Starting the 3D viewer…</Centered>,
});

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-white/70">{children}</div>;
}

type Meta = Partial<RobloxFileMeta> & { previewError?: string; processor?: string; format?: string };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the preview data (${res.status}).`);
  return (await res.json()) as T;
}

const STANDARD = "standard:r6";

/** Which of a file's rigs an animation fits best (most keyed joints found), or -1. Cached per manifest. */
const rigMatches = new WeakMap<RobloxManifest, WeakMap<RobloxManifest, Map<number, number>>>();
function bestRigFor(rigs: RobloxManifest, animations: RobloxManifest, animationNode: number): number {
  let byFile = rigMatches.get(rigs);
  if (!byFile) rigMatches.set(rigs, (byFile = new WeakMap()));
  let cache = byFile.get(animations);
  if (!cache) byFile.set(animations, (cache = new Map()));
  const key = animationNode;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const clip = buildClip(animations, animationNode);
  // Rigs with the same joints (two copies of one creature) tie on matches: then the rig the
  // animation is stored in wins (e.g. its AnimSaves folder).
  const storedIn = (rigNode: number) => {
    if (rigs !== animations) return false;
    for (let p = animations.nodes[animationNode]?.p ?? -1; p !== -1; p = animations.nodes[p]!.p) if (p === rigNode) return true;
    return false;
  };
  let best = -1;
  let bestScore = 0;
  rigs.rigs.forEach((rig, i) => {
    const matched = buildRigSolver(rigs, i).bind(clip).matched;
    const score = matched === 0 ? 0 : matched * 2 + (storedIn(rig.node) ? 1 : 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  cache.set(key, best);
  return best;
}

/** "R15", "custom · 39 bones"… */
const rigKind = (r: RigInfo) => (r.bones?.length ? `${r.rigType} · ${r.bones.length} bone${r.bones.length === 1 ? "" : "s"}` : r.rigType);
/** Missing assets are requested in batches of this size (the server's batch limit). */
const AUTO_FETCH_BATCH = 50;
/** Assets already tried this session (project:kind:contentId → error, or null while in flight). */
const fetchAttempts = new Map<string, string | null>();
/** Assets Roblox asked us to wait for: retried once this time (ms) has passed. */
const retryNotBefore = new Map<string, number>();
const attemptKey = (projectId: string, use: Pick<ResourceUse, "kind" | "contentId">) => `${projectId}:${use.kind}:${use.contentId}`;

export function RobloxPreview({
  attachment,
  timelineRef,
  markers,
  activeMarkerId,
  onMarkerClick,
  onTimelineActive,
  onPlayingChange,
  onTimeChange,
}: {
  attachment: AttachmentDTO;
  timelineRef: RefObject<TimelineHandle | null>;
  markers: TimeMarker[];
  activeMarkerId: string | null;
  onMarkerClick: (id: string) => void;
  onTimelineActive: (active: boolean) => void;
  onPlayingChange?: (playing: boolean) => void;
  onTimeChange?: (ms: number) => void;
}) {
  const { card, scope } = useScope();
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const meta = attachment.meta as Meta | null;
  const [rebuilding, setRebuilding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoFetching, setAutoFetching] = useState(0);
  const [, setAttemptsVersion] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const canProvide = scope.permissions.canUpload || card.permissions.canEdit;

  const manifestQuery = useQuery({
    queryKey: ["roblox-manifest", attachment.id, meta?.processor ?? "", meta?.manifestVersion ?? 0],
    queryFn: () => fetchJson<RobloxManifest>(attachment.derivedUrl!),
    enabled: Boolean(attachment.derivedUrl) && attachment.status === "READY",
    staleTime: Infinity,
    retry: 1,
  });
  const manifest = manifestQuery.data;

  // ── Rig resolution for animations ──────────────────────────────────────────
  const fileHasRig = Boolean(manifest?.rigs.length);
  const needsRig = Boolean(manifest?.capabilities.animation) && !fileHasRig;
  const rigsQuery = useQuery({
    queryKey: ["roblox-rigs", card.id],
    queryFn: () => rpc("roblox.rigs", { cardId: card.id }),
    enabled: needsRig,
    staleTime: 60_000,
  });
  const configured = (attachment.previewConfig?.rigAttachmentId as string | null | undefined) ?? null;
  const [localRig, setLocalRig] = useState<string | null>(null);
  const [fileRigIndex, setFileRigIndex] = useState(0);
  const joints = useMemo(() => (manifest ? [...new Set(manifest.animations.flatMap((a) => a.joints))] : []), [manifest]);
  const r6 = looksLikeR6(joints);
  const candidates = (rigsQuery.data ?? []).filter((c) => c.attachmentId !== attachment.id);
  const chosen = localRig ?? configured ?? (candidates.find((c) => c.sameCard)?.attachmentId ?? null);
  const chosenCandidate = candidates.find((c) => c.attachmentId === chosen);
  const rigManifestQuery = useQuery({
    queryKey: ["roblox-rig-manifest", chosenCandidate?.attachmentId],
    queryFn: () => fetchJson<RobloxManifest>(chosenCandidate!.manifestUrl),
    enabled: Boolean(chosenCandidate),
    staleTime: Infinity,
  });
  const standard = useMemo(() => (chosen === STANDARD ? standardR6Manifest() : null), [chosen]);

  // A file with several rigs (e.g. a creature and an R6 dummy) plays each animation on the rig
  // whose joints it animates — until someone picks a rig by hand.
  const [rigPickedByHand, setRigPickedByHand] = useState(false);
  const [clipNode, setClipNode] = useState<number | null>(null);
  const rigSource = fileHasRig ? manifest : (rigManifestQuery.data ?? null);
  useEffect(() => {
    if (!manifest || !rigSource || clipNode === null || rigPickedByHand || rigSource.rigs.length < 2) return;
    const best = bestRigFor(rigSource, manifest, clipNode);
    if (best >= 0) setFileRigIndex(best);
  }, [manifest, rigSource, clipNode, rigPickedByHand]);

  const rig: RigChoice | null = useMemo(() => {
    if (!manifest) return null;
    if (fileHasRig) {
      const i = Math.min(fileRigIndex, manifest.rigs.length - 1);
      return { manifest, rigIndex: i, label: `${manifest.rigs[i]!.name} (in this file, ${rigKind(manifest.rigs[i]!)})`, source: "file" };
    }
    if (!needsRig) return null;
    if (standard) return { manifest: standard, rigIndex: 0, label: "Standard R6 block rig — stand-in", source: "standard" };
    const borrowed = rigManifestQuery.data;
    if (chosenCandidate && borrowed?.rigs.length) {
      const i = Math.min(fileRigIndex, borrowed.rigs.length - 1);
      return {
        manifest: borrowed,
        rigIndex: i,
        label: `${borrowed.rigs[i]!.name} (${rigKind(borrowed.rigs[i]!)}) · ${chosenCandidate.cardKey}${chosenCandidate.deliverableName ? ` › ${chosenCandidate.deliverableName}` : ""}`,
        source: "attachment",
      };
    }
    return null;
  }, [manifest, fileHasRig, fileRigIndex, needsRig, standard, chosenCandidate, rigManifestQuery.data]);

  // Meshes and textures for everything on stage: the file, plus a rig borrowed from another file.
  const stageUses = useMemo(() => {
    const uses = [...(manifest?.resources ?? []), ...(rig?.source === "attachment" ? rig.manifest.resources : [])];
    return uses.filter((r) => r.affectsPreview && (r.kind === "mesh" || r.kind === "texture"));
  }, [manifest, rig]);
  const neededIds = useMemo(() => [...new Set(stageUses.map((r) => r.contentId))], [stageUses]);
  const resourcesKey = useMemo(() => ["roblox-resources", card.id, attachment.id, rig?.source === "attachment" ? (chosenCandidate?.attachmentId ?? "") : ""] as const, [card.id, attachment.id, rig?.source, chosenCandidate?.attachmentId]);
  const resourcesQuery = useQuery({
    queryKey: resourcesKey,
    queryFn: () => rpc("roblox.resources", { cardId: card.id, contentIds: neededIds }),
    enabled: Boolean(manifest),
    staleTime: 60_000,
  });

  const chooseRig = (value: string) => {
    setLocalRig(value);
    if (value !== STANDARD && canProvide) {
      rpc("roblox.previewConfig", { attachmentId: attachment.id, rigAttachmentId: value })
        .then(() => void queryClient.invalidateQueries({ queryKey: qk.card(card.id) }))
        .catch((error) => toast.error(errorMessage(error)));
    }
  };

  // Which rig inside the rig file (when it holds several).
  const rigFile = fileHasRig ? manifest : rig?.source === "attachment" ? rig.manifest : null;
  const rigIndexPicker =
    rigFile && rigFile.rigs.length > 1 ? (
      <Select
        variant="media"
        aria-label="Rig"
        value={String(Math.min(fileRigIndex, rigFile.rigs.length - 1))}
        onValueChange={(v) => {
          setRigPickedByHand(true);
          setFileRigIndex(Number(v));
        }}
        className="max-w-56"
        options={rigFile.rigs.map((r, i) => ({ value: String(i), label: `${r.name} (${rigKind(r)})` }))}
      />
    ) : null;
  const rigPicker = fileHasRig ? (
    rigIndexPicker
  ) : needsRig ? (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        variant="media"
        aria-label="Rig to preview on"
        value={chosen ?? undefined}
        onValueChange={chooseRig}
        placeholder={rigsQuery.isLoading ? "Looking for rigs…" : candidates.length ? "Choose a rig…" : "No rig files in this project yet"}
        disabled={rigsQuery.isLoading || (!candidates.length && !r6)}
        className="max-w-72"
        options={[
          ...candidates.map((c) => ({ value: c.attachmentId, label: `${c.sameCard ? "This card" : c.cardKey} · ${c.deliverableName ?? c.cardTitle} — ${c.filename}` })),
          ...(r6 ? [{ value: STANDARD, label: "Standard R6 block rig (stand-in, not your character)" }] : []),
        ]}
      />
      {rigIndexPicker}
      {rigManifestQuery.isFetching ? <Loader2 className="size-3.5 animate-spin text-white/60" aria-label="Loading the rig" /> : null}
      {!candidates.length ? <span className="text-[11px] text-white/55">Upload the rig (.rbxm) to this card — e.g. as its own deliverable — and it appears here.</span> : null}
    </div>
  ) : null;

  // ── Resource actions ───────────────────────────────────────────────────────
  const refreshResources = useCallback(() => void queryClient.invalidateQueries({ queryKey: resourcesKey }), [queryClient, resourcesKey]);
  // Missing meshes/textures are downloaded from Roblox as soon as the preview opens (by someone
  // allowed to provide files), in one batched request. The server keeps them in the studio's
  // 7-day cache, so every preview after that is instant. If Roblox asks Forge to slow down, the
  // affected assets are retried once the wait is over instead of being marked as failed.
  const canFetch = Boolean(resourcesQuery.data?.canFetch);
  useEffect(() => {
    if (!manifest || !resourcesQuery.data || !canProvide || !canFetch) return;
    const resolved = new Set(resourcesQuery.data.resources.map((r) => `${r.kind}:${r.contentId}`));
    const nowMs = Date.now();
    const todo = stageUses
      .filter((r) => !r.builtin && r.contentId.startsWith("rbxassetid://"))
      .filter((r, i, all) => all.findIndex((x) => x.kind === r.kind && x.contentId === r.contentId) === i)
      .filter((r) => !resolved.has(`${r.kind}:${r.contentId}`))
      .filter((r) => !fetchAttempts.has(attemptKey(card.projectId, r)) && (retryNotBefore.get(attemptKey(card.projectId, r)) ?? 0) <= nowMs)
      .slice(0, AUTO_FETCH_BATCH);
    if (!todo.length) return;
    for (const use of todo) fetchAttempts.set(attemptKey(card.projectId, use), null);
    setAutoFetching(todo.length);
    const waitThenRetry = (ms: number) => setTimeout(() => setRetryTick((t) => t + 1), ms + 500);
    void (async () => {
      try {
        const results = await rpc("roblox.fetchMany", {
          cardId: card.id,
          items: todo.map((use) => ({ contentId: use.contentId, kind: use.kind === "mesh" ? ("mesh" as const) : ("texture" as const) })),
        });
        let wait = 0;
        for (const result of results) {
          const key = attemptKey(card.projectId, result);
          if (result.resource) {
            fetchAttempts.delete(key);
            retryNotBefore.delete(key);
          } else if (result.error?.code === "RATE_LIMITED") {
            const ms = result.error.retryAfterMs ?? 30_000;
            fetchAttempts.delete(key);
            retryNotBefore.set(key, Date.now() + ms);
            wait = Math.max(wait, ms);
          } else {
            fetchAttempts.set(key, result.error?.message ?? "Couldn't fetch this asset.");
          }
        }
        if (wait) waitThenRetry(wait);
      } catch (error) {
        // The whole request was refused (e.g. too many requests): try again later, don't give up on the assets.
        const ms = error instanceof RpcError && error.code === "RATE_LIMITED" ? Number(error.details?.retryAfterMs) || 30_000 : 0;
        for (const use of todo) {
          const key = attemptKey(card.projectId, use);
          if (ms) {
            fetchAttempts.delete(key);
            retryNotBefore.set(key, Date.now() + ms);
          } else {
            fetchAttempts.set(key, errorMessage(error));
          }
        }
        if (ms) waitThenRetry(ms);
      } finally {
        setAutoFetching(0);
        setAttemptsVersion((v) => v + 1);
        void queryClient.invalidateQueries({ queryKey: ["roblox-resources", card.id] });
      }
    })();
  }, [manifest, stageUses, resourcesQuery.data, canProvide, canFetch, card.id, card.projectId, queryClient, retryTick]);

  const resourceActions = {
    canProvide,
    canFetch,
    privateAssets: Boolean(resourcesQuery.data?.privateAssets),
    autoFetching,
    fetchError: (use: ResourceUse) => {
      const key = attemptKey(card.projectId, use);
      const until = retryNotBefore.get(key) ?? 0;
      if (until > Date.now()) return `Roblox asked Forge to slow down — trying again in ${Math.ceil((until - Date.now()) / 1000)} s.`;
      return fetchAttempts.get(key) ?? null;
    },
    busy,
    upload: async (use: ResourceUse, file: File) => {
      setBusy(use.contentId);
      try {
        const [uploaded] = await uploads.uploadFiles({ ...scope.uploadTarget }, [file], "resource");
        if (!uploaded) throw new Error("The upload didn't finish.");
        await rpc("roblox.resolve", { cardId: card.id, contentId: use.contentId, kind: use.kind === "mesh" ? "mesh" : "texture", attachmentId: uploaded.id });
        toast.success(`${use.kind === "mesh" ? "Mesh" : "Texture"} provided — every reference to it in this project now uses ${file.name}.`);
        refreshResources();
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    fetchFromRoblox: async (use: ResourceUse) => {
      setBusy(use.contentId);
      try {
        await rpc("roblox.fetch", { cardId: card.id, contentId: use.contentId, kind: use.kind === "mesh" ? "mesh" : "texture" });
        fetchAttempts.delete(attemptKey(card.projectId, use));
        toast.success("Fetched from Roblox.");
        refreshResources();
      } catch (error) {
        fetchAttempts.set(attemptKey(card.projectId, use), errorMessage(error));
        setAttemptsVersion((v) => v + 1);
        toast.error(errorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    remove: async (res: ResolvedResource & { id?: string }) => {
      if (!res.id) return;
      try {
        await rpc("roblox.unresolve", { cardId: card.id, resourceId: res.id });
        refreshResources();
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
  };

  // ── States ─────────────────────────────────────────────────────────────────
  const rebuild = async () => {
    setRebuilding(true);
    try {
      await rpc("roblox.rebuild", { attachmentId: attachment.id });
      void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRebuilding(false);
    }
  };

  // Previews made by an older version of the reader lack newer data (e.g. 2D UI): rebuild once.
  const stale = attachment.status === "READY" && !meta?.previewError && typeof meta?.manifestVersion === "number" && meta.manifestVersion < ROBLOX_MANIFEST_VERSION;
  const upgradeTried = useRef(false);
  useEffect(() => {
    if (!stale || upgradeTried.current || !card.permissions.canComment) return;
    upgradeTried.current = true;
    void rpc("roblox.rebuild", { attachmentId: attachment.id })
      .then(() => queryClient.invalidateQueries({ queryKey: qk.card(card.id) }))
      .catch(() => {});
  }, [stale, attachment.id, card.id, card.permissions.canComment, queryClient]);

  if (attachment.status === "PROCESSING" || attachment.status === "PENDING") {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin" />
        Reading the Roblox file… (nothing in it is executed)
      </Centered>
    );
  }
  if (meta?.previewError || (!attachment.derivedUrl && attachment.status === "READY")) {
    return (
      <Centered>
        <CircleAlert className="size-7 text-state-review" />
        <p className="max-w-md text-white/85">{meta?.previewError ?? "There's no preview for this file yet."}</p>
        <p className="max-w-md text-[12px] text-white/55">The original upload is untouched — you can always download it.</p>
        <div className="mt-1 flex gap-2">
          <button type="button" onClick={() => void rebuild()} disabled={rebuilding} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[12.5px] hover:bg-white/15 disabled:opacity-50">
            <RefreshCw className={rebuilding ? "size-4 animate-spin" : "size-4"} /> Try again
          </button>
          {attachment.downloadUrl ? (
            <a href={attachment.downloadUrl} className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[12.5px] hover:bg-white/15">
              <Download className="size-4" /> Download original
            </a>
          ) : null}
        </div>
      </Centered>
    );
  }
  if (manifestQuery.isError) {
    return (
      <Centered>
        <CircleAlert className="size-7 text-state-review" />
        {errorMessage(manifestQuery.error)}
        <button type="button" onClick={() => void manifestQuery.refetch()} className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-[12.5px] hover:bg-white/15">
          <RefreshCw className="size-4" /> Retry
        </button>
      </Centered>
    );
  }
  if (!manifest) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin" /> Loading preview…
      </Centered>
    );
  }

  const initialMode: ViewerMode = meta?.primary === "effects" ? "effects" : meta?.primary === "animation" ? "animation" : meta?.primary === "ui" ? "ui" : "model";
  const resources: Array<ResolvedResource & { id?: string }> = (resourcesQuery.data?.resources ?? []).map((r) => ({
    id: r.id,
    contentId: r.contentId,
    kind: r.kind,
    url: r.url,
    format: r.format,
    filename: r.filename,
    source: r.source,
    expiresAt: r.expiresAt,
  }));

  return (
    <RobloxViewer
      manifest={manifest}
      filename={attachment.filename}
      downloadUrl={attachment.downloadUrl}
      rig={rig}
      rigPicker={rigPicker}
      resources={resources}
      resourceActions={resourceActions}
      initialMode={initialMode}
      timelineRef={timelineRef}
      markers={markers}
      activeMarkerId={activeMarkerId}
      onMarkerClick={onMarkerClick}
      onTimelineActive={onTimelineActive}
      onPlayingChange={onPlayingChange}
      onTimeChange={onTimeChange}
      onClipChange={setClipNode}
    />
  );
}
