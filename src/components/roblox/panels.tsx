"use client";

import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CloudDownload,
  Eye,
  EyeOff,
  FileCode2,
  Folder,
  Image as ImageIcon,
  Lightbulb,
  Link2,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Waypoints,
  Zap,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { ManifestNode, ResourceUse, RobloxManifest, SupportLevel } from "@/lib/roblox/manifest";
import { classSupport, SUPPORT_LABELS } from "@/lib/roblox/support";
import { cn } from "@/lib/utils";
import type { EffectInfo } from "./effects";
import type { ResolvedResource, ResourceStatus } from "./resources";

const PART_LIKE = /Part$|Operation$|^Seat$|^VehicleSeat$|^SpawnLocation$/;

function classIcon(className: string): ReactNode {
  if (PART_LIKE.test(className)) return <Box className="size-3.5 text-sky-400" />;
  if (className === "Model" || className === "Folder" || className === "Actor") return <Folder className="size-3.5 text-amber-400" />;
  if (/Script$/.test(className)) return <FileCode2 className="size-3.5 text-fg-subtle" />;
  if (className === "ParticleEmitter" || className === "Fire" || className === "Smoke" || className === "Sparkles") return <Sparkles className="size-3.5 text-fuchsia-400" />;
  if (className === "Beam" || className === "Trail") return <Zap className="size-3.5 text-fuchsia-400" />;
  if (/Light$/.test(className)) return <Lightbulb className="size-3.5 text-yellow-300" />;
  if (className === "Attachment" || className === "Bone" || /Motor|Weld/.test(className)) return <Waypoints className="size-3.5 text-emerald-400" />;
  if (className === "Decal" || className === "Texture" || className === "SurfaceAppearance") return <ImageIcon className="size-3.5 text-sky-300" />;
  return <CircleDashed className="size-3.5 text-fg-subtle" />;
}

const LEVEL_TONE: Record<SupportLevel, string> = {
  full: "text-state-approved",
  approximate: "text-state-review",
  unsupported: "text-state-changes",
  data: "text-fg-subtle",
};

// ── Explorer ────────────────────────────────────────────────────────────────

export function ExplorerPanel({
  manifest,
  selected,
  onSelect,
  hidden,
  onToggleHidden,
  renderable,
}: {
  manifest: RobloxManifest;
  selected: number | null;
  onSelect: (node: number) => void;
  hidden: ReadonlySet<number>;
  onToggleHidden: (node: number) => void;
  renderable: ReadonlySet<number>;
}) {
  const nodes = manifest.nodes;
  const children = useMemo(() => {
    const map = new Map<number, number[]>();
    nodes.forEach((n, i) => map.set(n.p, [...(map.get(n.p) ?? []), i]));
    return map;
  }, [nodes]);
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    const open = new Set<number>();
    for (const r of children.get(-1) ?? []) {
      open.add(r);
      if ((children.get(-1) ?? []).length <= 2) for (const c of children.get(r) ?? []) if ((children.get(c) ?? []).length < 12) open.add(c);
    }
    return open;
  });
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? nodes.map((n, i) => (n.n.toLowerCase().includes(q) || n.c.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0) : []), [nodes, q]);

  const row = (i: number, depth: number): ReactNode => {
    const n = nodes[i]!;
    const kids = children.get(i) ?? [];
    const open = expanded.has(i);
    return (
      <li key={i}>
        <div
          className={cn("group flex h-6 items-center gap-1 rounded pr-1 text-[12px]", selected === i ? "bg-accent-soft text-fg" : "hover:bg-surface-3")}
          style={{ paddingLeft: depth * 12 + 2 }}
        >
          {kids.length ? (
            <button
              type="button"
              aria-label={open ? `Collapse ${n.n}` : `Expand ${n.n}`}
              onClick={() => setExpanded((s) => {
                const next = new Set(s);
                if (open) next.delete(i);
                else next.add(i);
                return next;
              })}
              className="flex size-4 items-center justify-center text-fg-subtle"
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            <span className="size-4" />
          )}
          <button type="button" onClick={() => onSelect(i)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={`${n.c} "${n.n}"`}>
            {classIcon(n.c)}
            <span className={cn("truncate", hidden.has(i) && "opacity-40")}>{n.n}</span>
            {n.n !== n.c ? <span className="hidden truncate text-[10.5px] text-fg-subtle xl:inline">{n.c}</span> : null}
          </button>
          {renderable.has(i) ? (
            <button type="button" aria-label={hidden.has(i) ? `Show ${n.n}` : `Hide ${n.n}`} onClick={() => onToggleHidden(i)} className="text-fg-subtle opacity-0 hover:text-fg group-hover:opacity-100 focus:opacity-100">
              {hidden.has(i) ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          ) : null}
        </div>
        {open && kids.length ? <ul>{kids.slice(0, 400).map((k) => row(k, depth + 1))}</ul> : null}
        {open && kids.length > 400 ? <p className="text-[11px] text-fg-subtle" style={{ paddingLeft: depth * 12 + 20 }}>+ {kids.length - 400} more (use search)</p> : null}
      </li>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find by name or class" aria-label="Find in hierarchy" className="h-7 w-full rounded-md border border-border-strong bg-surface-3 pl-7 pr-2 text-[12px] outline-none focus:border-accent" />
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {q ? (
          <ul>
            {matches.slice(0, 300).map((i) => row(i, 0))}
            {!matches.length ? <li className="px-2 text-[12px] text-fg-muted">No matches.</li> : null}
          </ul>
        ) : (
          <ul>{(children.get(-1) ?? []).map((r) => row(r, 0))}</ul>
        )}
      </div>
    </div>
  );
}

// ── Properties ──────────────────────────────────────────────────────────────

export function PropertiesPanel({ manifest, node }: { manifest: RobloxManifest; node: number | null }) {
  if (node === null) return <p className="p-3 text-[12px] text-fg-muted">Select something in the scene or the explorer to inspect it.</p>;
  const n: ManifestNode = manifest.nodes[node]!;
  const support = classSupport(n.c);
  const path: string[] = [];
  for (let p = node; p !== -1; p = manifest.nodes[p]!.p) path.unshift(manifest.nodes[p]!.n);
  return (
    <div className="scrollbar-thin h-full overflow-y-auto p-3 text-[12px]">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold">
        {classIcon(n.c)} {n.n}
      </p>
      <p className="mt-0.5 break-all text-[11px] text-fg-subtle">
        {n.c} · {path.join(" › ")}
      </p>
      <p className={cn("mt-2 rounded-md bg-surface-3/60 px-2 py-1 text-[11.5px]", LEVEL_TONE[support.level])}>
        {SUPPORT_LABELS[support.level]} — <span className="text-fg-muted">{support.note}</span>
      </p>
      {n.a && Object.keys(n.a).length ? (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Attributes</p>
          <dl className="mt-1 grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-x-2 gap-y-0.5">
            {Object.entries(n.a).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="truncate text-fg-muted" title={k}>
                  {k}
                </dt>
                <dd className="truncate font-mono" title={JSON.stringify(v)}>
                  {typeof v === "number" ? String(Math.round(v * 1000) / 1000) : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Properties</p>
      {n.x.length ? (
        <dl className="mt-1 grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          {n.x.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate text-fg-muted" title={k}>
                {k}
              </dt>
              <dd className="font-mono text-[11.5px] [overflow-wrap:anywhere]" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-fg-muted">No serialised properties.</p>
      )}
    </div>
  );
}

// ── Resources ───────────────────────────────────────────────────────────────

export interface ResourceActions {
  canProvide: boolean;
  /** The server can download assets from Roblox (public ones always; private ones with a key). */
  canFetch: boolean;
  privateAssets: boolean;
  /** Assets being downloaded automatically right now. */
  autoFetching: number;
  fetchError: (use: ResourceUse) => string | null;
  busy: string | null;
  upload: (use: ResourceUse, file: File) => void;
  fetchFromRoblox: (use: ResourceUse) => void;
  remove: (resource: ResolvedResource & { id?: string }) => void;
}

/** Built-in content (rbxasset://) ships with Roblox, not on the web: say where to find the file. */
function builtinHint(contentId: string) {
  const file = contentId.replace(/^rbxasset:\/\//, "").replace(/\//g, "\\");
  return `Built into Roblox, so it can't be downloaded — upload it from Roblox Studio's install folder: %LOCALAPPDATA%\\Roblox\\Versions\\<version>\\content\\${file}. `;
}

export function ResourcesPanel({
  manifest,
  resolved,
  status,
  actions,
  onSelectNode,
}: {
  manifest: RobloxManifest;
  resolved: Array<ResolvedResource & { id?: string }>;
  status: ReadonlyMap<string, ResourceStatus>;
  actions: ResourceActions;
  onSelectNode: (node: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<ResourceUse | null>(null);
  const needed = manifest.resources.filter((r) => r.affectsPreview && (r.kind === "mesh" || r.kind === "texture"));
  const info = manifest.resources.filter((r) => !r.affectsPreview || !(r.kind === "mesh" || r.kind === "texture"));
  const byKey = new Map(resolved.map((r) => [`${r.kind}:${r.contentId}`, r]));
  const missing = needed.filter((r) => !byKey.has(`${r.kind}:${r.contentId}`));

  return (
    <div className="scrollbar-thin h-full overflow-y-auto p-3 text-[12px]">
      <p className="text-fg-muted">
        Roblox models reference meshes and textures stored on Roblox. Provide the files to render them for real — they&apos;re shared across this project.
      </p>
      <p className="mt-2 text-[12.5px] font-semibold">
        {needed.length === 0 ? "This file doesn't reference any external meshes or textures." : missing.length ? `${missing.length} of ${needed.length} needed resources missing` : `All ${needed.length} resources provided`}
      </p>
      <ul className="mt-2 grid gap-1.5">
        {needed.map((use) => {
          const res = byKey.get(`${use.kind}:${use.contentId}`);
          const st = status.get(use.contentId);
          const state = !res ? "missing" : st?.state === "error" ? "error" : st?.state === "loaded" ? "loaded" : "resolved";
          return (
            <li key={`${use.kind}:${use.contentId}`} className="rounded-md border border-border bg-surface-2 p-2">
              <div className="flex items-start gap-1.5">
                {state === "missing" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-state-review" /> : state === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" /> : <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-state-approved" />}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {use.kind === "mesh" ? "Mesh" : "Texture"} <span className="break-all font-mono text-[11px] text-fg-muted">{use.contentId}</span>
                  </p>
                  <p className="text-[11px] text-fg-subtle">
                    {use.builtin && !res ? builtinHint(use.contentId) : ""}
                    Used by{" "}
                    {use.uses.slice(0, 3).map((u, i) => (
                      <button key={`${u.node}-${u.prop}`} type="button" onClick={() => onSelectNode(u.node)} className="text-accent hover:underline">
                        {i ? ", " : ""}
                        {manifest.nodes[u.node]?.n ?? "?"}
                      </button>
                    ))}
                    {use.uses.length > 3 ? ` +${use.uses.length - 3}` : ""}
                  </p>
                  {res ? (
                    <p className="mt-0.5 truncate text-[11px] text-fg-muted" title={res.source === "roblox" && res.expiresAt ? `Freed on ${new Date(res.expiresAt).toLocaleString()} unless it's used again` : undefined}>
                      {res.source === "roblox"
                        ? `Fetched from Roblox · kept until ${res.expiresAt ? new Date(res.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "unused for 7 days"} (renews when used)`
                        : `Using ${res.filename}`}
                    </p>
                  ) : null}
                  {st?.state === "error" ? <p className="mt-0.5 text-[11px] text-danger">{st.message}</p> : null}
                  {!res && actions.fetchError(use) ? <p className="mt-0.5 text-[11px] text-state-review">Couldn&apos;t fetch from Roblox: {actions.fetchError(use)}</p> : null}
                </div>
              </div>
              {actions.canProvide ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  <button
                    type="button"
                    disabled={Boolean(actions.busy)}
                    onClick={() => {
                      setTarget(use);
                      input.current!.accept = use.kind === "mesh" ? ".mesh,.obj,.glb,.fbx" : "image/png,image/jpeg,image/webp,image/gif";
                      input.current!.click();
                    }}
                    className="inline-flex h-6 items-center gap-1 rounded border border-border-strong px-1.5 text-[11px] hover:bg-surface-3 disabled:opacity-50"
                  >
                    {actions.busy === use.contentId ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />} {res ? "Replace" : "Upload file"}
                  </button>
                  {!use.builtin && /^rbxassetid:\/\//.test(use.contentId) ? (
                    <button
                      type="button"
                      disabled={!actions.canFetch || Boolean(actions.busy)}
                      title={actions.canFetch ? "Download it from Roblox" : "Fetching from Roblox is turned off on this server (ROBLOX_PUBLIC_ASSET_FETCH)"}
                      onClick={() => actions.fetchFromRoblox(use)}
                      className="inline-flex h-6 items-center gap-1 rounded border border-border-strong px-1.5 text-[11px] hover:bg-surface-3 disabled:opacity-50"
                    >
                      <CloudDownload className="size-3" /> Fetch from Roblox
                    </button>
                  ) : null}
                  {res?.id && res.source !== "roblox" ? (
                    <button type="button" onClick={() => actions.remove(res)} className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-fg-muted hover:text-danger">
                      <Trash2 className="size-3" /> Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {actions.autoFetching ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-fg-muted">
          <Loader2 className="size-3 animate-spin" /> Fetching {actions.autoFetching} asset{actions.autoFetching === 1 ? "" : "s"} from Roblox…
        </p>
      ) : null}
      {actions.canFetch && !actions.privateAssets && needed.some((u) => !u.builtin) ? (
        <p className="mt-2 text-[11px] text-fg-subtle">
          Forge tries to fetch these from Roblox automatically, but without an API key Roblox only hands out a few (mostly older)
          assets. For the rest, upload the file — or an admin can set <code className="rounded bg-surface-4 px-1">ROBLOX_OPEN_CLOUD_API_KEY</code>.
        </p>
      ) : null}
      {info.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11.5px] text-fg-muted">Other references ({info.length}) — not needed for the preview</summary>
          <ul className="mt-1 grid gap-0.5 text-[11px] text-fg-muted">
            {info.slice(0, 60).map((r) => (
              <li key={`${r.kind}:${r.contentId}`} className="flex gap-1.5">
                <Link2 className="mt-0.5 size-3 shrink-0" /> <span className="capitalize">{r.kind}</span> <span className="break-all font-mono">{r.contentId}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && target) actions.upload(target, file);
        }}
      />
    </div>
  );
}

// ── Fidelity ────────────────────────────────────────────────────────────────

export function FidelityPanel({ manifest, runtimeNotes }: { manifest: RobloxManifest; runtimeNotes: string[] }) {
  const groups: SupportLevel[] = ["full", "approximate", "unsupported", "data"];
  return (
    <div className="scrollbar-thin h-full overflow-y-auto p-3 text-[12px]">
      <p className="text-fg-muted">What this preview draws from the file. Nothing in the file is ever executed.</p>
      {runtimeNotes.length || manifest.warnings.length ? (
        <ul className="mt-2 grid gap-1">
          {[...runtimeNotes, ...manifest.warnings].map((w) => (
            <li key={w} className="flex gap-1.5 rounded-md bg-state-review/10 px-2 py-1 text-[11.5px]">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-state-review" /> {w}
            </li>
          ))}
        </ul>
      ) : null}
      {groups.map((level) => {
        const entries = manifest.support.filter((s) => s.level === level);
        if (!entries.length) return null;
        return (
          <section key={level} className="mt-3">
            <p className={cn("text-[11px] font-semibold uppercase tracking-wide", LEVEL_TONE[level])}>
              {SUPPORT_LABELS[level]} ({entries.reduce((n, e) => n + e.count, 0)})
            </p>
            <ul className="mt-1 grid gap-1">
              {entries.map((e) => (
                <li key={e.className}>
                  <span className="font-medium">{e.className}</span> <span className="text-fg-subtle">×{e.count}</span>
                  {level !== "data" ? <span className="block text-[11px] text-fg-muted">{e.note}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ── Effects list ────────────────────────────────────────────────────────────

export function EffectsPanel({ manifest, info, onToggle, onEmit, onSelect }: { manifest: RobloxManifest; info: EffectInfo[]; onToggle: (node: number, enabled: boolean) => void; onEmit: (node: number, count: number) => void; onSelect: (node: number) => void }) {
  if (!info.length) return <p className="p-3 text-[12px] text-fg-muted">No particle emitters, beams or trails in this file.</p>;
  return (
    <ul className="scrollbar-thin grid h-full content-start gap-1.5 overflow-y-auto p-2 text-[12px]">
      {info.map((e) => {
        const n = manifest.nodes[e.node]!;
        return (
          <li key={e.node} className="rounded-md border border-border bg-surface-2 p-2">
            <div className="flex items-center gap-1.5">
              <input type="checkbox" checked={e.enabled} aria-label={`Enable ${n.n}`} onChange={(ev) => onToggle(e.node, ev.target.checked)} />
              <button type="button" onClick={() => onSelect(e.node)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline">
                {n.n}
              </button>
              <span className="text-[10.5px] text-fg-subtle">{e.className}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-fg-muted">
              {e.className === "ParticleEmitter" || e.className === "Fire" || e.className === "Smoke" || e.className === "Sparkles" ? `${e.live} live` : null}
              {e.emitCount ? ` · EmitCount ${e.emitCount}` : ""}
              {e.texture === "placeholder" ? <span className="text-state-review"> · placeholder texture</span> : e.texture === "file" ? " · texture ✓" : ""}
            </p>
            {e.issue ? <p className="text-[11px] text-fg-subtle">{e.issue}</p> : null}
            {e.className !== "Beam" && e.className !== "Trail" ? (
              <button type="button" onClick={() => onEmit(e.node, e.emitCount || 10)} className="mt-1 inline-flex h-6 items-center gap-1 rounded border border-border-strong px-1.5 text-[11px] hover:bg-surface-3">
                <Sparkles className="size-3" /> Emit {e.emitCount || 10}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
