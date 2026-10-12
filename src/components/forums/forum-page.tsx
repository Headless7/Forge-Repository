"use client";

import { useQuery } from "@tanstack/react-query";
import { Film, Image as ImageIcon, MessageSquare, Plus, Search, Settings2, Tag } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FORUM_KIND_META, ITEM_PRIORITY_META, ITEM_PRIORITY_ORDER, isResolvedItem, plural, priorityLabel, withArticle } from "@/lib/forum-meta";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { ForumItemSummaryDTO, ForumViewDTO, ItemPriority, MemberDTO } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { useRealtimeProject } from "../realtime";
import { UserAvatar } from "../domain/avatar";
import { LabelChip } from "../domain/state";
import { Button } from "../ui/button";
import { EmptyState, Select } from "../ui/controls";
import { Input } from "../ui/input";
import { Tooltip } from "../ui/menu";
import { ForumSettingsDialog } from "./forum-dialogs";
import { ItemPriorityIcon, ItemStatusPill } from "./item-badges";
import { ItemDialog } from "./item-dialog";
import { NewItemDialog } from "./new-item-dialog";
import { TagManagerDialog } from "./pickers";

type Scope = "all" | "none" | string;
type StatusFilter = "open" | "resolved" | "all";
type Sort = "newest" | "priority" | "updated";

/**
 * One forum (Bugs, QA or a custom tracker). The default view is the global list of every unresolved
 * item across updates; each update (milestone) also has its own list, and resolved items are a
 * filter away.
 */
export function ForumPage({ initial, members, studioSlug, projectSlug }: { initial: ForumViewDTO; members: MemberDTO[]; studioSlug: string; projectSlug: string }) {
  const projectId = initial.project.id;
  const forumId = initial.forum.id;
  useRealtimeProject(projectId);
  const { data: view } = useQuery({ queryKey: qk.forum(projectId, forumId), queryFn: () => rpc("forum.get", { forumId }), initialData: initial, staleTime: 10_000 });
  const { forum } = view;
  const noun = forum.itemLabel;
  const nouns = plural(noun);
  const words = FORUM_KIND_META[forum.kind];
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openNumber = Number(searchParams.get("item")) || null;

  const [scope, setScope] = useState<Scope>("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [q, setQ] = useState("");
  const [priority, setPriority] = useState<ItemPriority | "any">("any");
  const [tagId, setTagId] = useState<string>("any");
  const [person, setPerson] = useState<string>("any");
  const [sort, setSort] = useState<Sort>("newest");
  const [reporting, setReporting] = useState(false);
  const [managingTags, setManagingTags] = useState(false);
  const [settings, setSettings] = useState(false);

  const readOnly = view.project.archived || forum.archived;
  const can = (p: (typeof view.viewer.permissions)[number]) => view.viewer.permissions.includes(p) && !readOnly;
  const viewerId = view.viewer.userId;
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const tagsById = useMemo(() => new Map(view.tags.map((t) => [t.id, t])), [view.tags]);
  const milestonesById = useMemo(() => new Map(view.milestones.map((m) => [m.id, m])), [view.milestones]);

  // ── The open item, in the URL (?item=12) so links and Back work ────────────
  const pushed = useRef(false);
  const openItem = useCallback(
    (number: number) => {
      const params = new URLSearchParams(window.location.search);
      const already = params.get("item");
      params.set("item", String(number));
      const url = `${pathname}?${params.toString()}`;
      if (already) window.history.replaceState(null, "", url);
      else {
        window.history.pushState(null, "", url);
        pushed.current = true;
      }
    },
    [pathname],
  );
  const closeItem = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("item");
    const query = params.toString();
    window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}`);
  }, [pathname]);
  useEffect(() => {
    if (!openNumber) pushed.current = false;
  }, [openNumber]);
  const openItemId = openNumber ? view.items.find((b) => b.number === openNumber)?.id : undefined;

  // ── Filtering ─────────────────────────────────────────────────────────────
  const unresolved = useMemo(() => view.items.filter((b) => !isResolvedItem(b.status)), [view.items]);
  const openCount = (filter: (b: ForumItemSummaryDTO) => boolean) => unresolved.filter(filter).length;
  const scopes: Array<{ id: Scope; label: string; count: number; released?: boolean }> = [
    { id: "all", label: "All updates", count: unresolved.length },
    ...view.milestones.filter((m) => !m.archived).map((m) => ({ id: m.id, label: m.name, count: openCount((b) => b.milestoneId === m.id), released: Boolean(m.releasedAt) })),
    { id: "none", label: "No update", count: openCount((b) => !b.milestoneId) },
  ];
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = view.items.filter((b) => {
      if (scope === "none" ? b.milestoneId : scope !== "all" && b.milestoneId !== scope) return false;
      if (status === "open" ? isResolvedItem(b.status) : status === "resolved" && !isResolvedItem(b.status)) return false;
      if (priority !== "any" && b.priority !== priority) return false;
      if (tagId !== "any" && !b.tagIds.includes(tagId)) return false;
      if (person === "me" ? !(b.assigneeId === viewerId || b.reviewerId === viewerId || b.reportedById === viewerId) : person !== "any" && b.assigneeId !== person) return false;
      if (needle && !`${b.key} ${b.title}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const rank = (b: ForumItemSummaryDTO) => ITEM_PRIORITY_META[b.priority].rank;
    return rows.sort((a, b) => {
      if (sort === "priority") return rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt);
      if (sort === "updated") return b.lastActivityAt.localeCompare(a.lastActivityAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [view.items, scope, status, priority, tagId, person, needle, sort, viewerId]);

  const nothingYet = view.items.length === 0;
  const scopeLabel = scope === "all" ? "every update" : scope === "none" ? "no update" : (milestonesById.get(scope)?.name ?? "this update");

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] text-fg-subtle">
              <Link href={`/${studioSlug}/${projectSlug}`} className="hover:text-fg">
                {view.project.icon} {view.project.name}
              </Link>{" "}
              / Forums
            </p>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight">
              <span aria-hidden>{forum.icon}</span> {forum.name}
              {forum.archived ? <span className="rounded bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">Archived</span> : null}
            </h1>
            {forum.description ? <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">{forum.description}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {view.viewer.permissions.includes("forum.manage") && !view.project.archived ? (
              <>
                <Tooltip content="Tags">
                  <Button variant="ghost" size="icon-sm" aria-label="Tags" onClick={() => setManagingTags(true)}>
                    <Tag />
                  </Button>
                </Tooltip>
                <Tooltip content="Forum settings">
                  <Button variant="ghost" size="icon-sm" aria-label="Forum settings" onClick={() => setSettings(true)}>
                    <Settings2 />
                  </Button>
                </Tooltip>
              </>
            ) : null}
            {can("item.create") ? (
              <Button variant="primary" onClick={() => setReporting(true)}>
                <Plus /> {words.actions.create} {withArticle(noun)}
              </Button>
            ) : null}
          </div>
        </div>

        {view.forums.length > 1 ? (
          <nav aria-label="Forums" className="scrollbar-none -mx-4 mt-4 flex gap-1 overflow-x-auto border-b border-border px-4 md:mx-0 md:px-0">
            {view.forums.map((f) => (
              <Link
                key={f.id}
                href={`/${studioSlug}/${projectSlug}/f/${f.slug}`}
                aria-current={f.id === forum.id ? "page" : undefined}
                className={cn("-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium", f.id === forum.id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")}
              >
                <span aria-hidden>{f.icon}</span> {f.name}
              </Link>
            ))}
          </nav>
        ) : null}

        {/* Scope: the global list, or one update */}
        <div className="scrollbar-none -mx-4 mt-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label="Updates">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scope === s.id}
              onClick={() => setScope(s.id)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium",
                scope === s.id ? "border-accent bg-accent-soft text-fg" : "border-border-strong text-fg-muted hover:bg-surface-3 hover:text-fg",
                s.released && "opacity-80",
              )}
            >
              {s.label}
              <span className={cn("rounded-full px-1.5 text-[10.5px] font-semibold leading-4", s.count ? "bg-state-changes/15 text-state-changes" : "bg-surface-4 text-fg-subtle")}>{s.count}</span>
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md bg-surface-3 p-0.5 text-[12.5px]">
            {(
              [
                ["open", "Open"],
                ["resolved", "Resolved"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" onClick={() => setStatus(value)} className={cn("h-7 rounded px-3 font-medium", status === value ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")} aria-pressed={status === value}>
                {label}
              </button>
            ))}
          </div>
          <div className="relative min-w-40 flex-1 sm:max-w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${nouns}…`} aria-label={`Search ${nouns}`} className="pl-7" />
          </div>
          <Select<ItemPriority | "any"> aria-label="Priority" value={priority} onValueChange={setPriority} className="h-8 w-auto min-w-32" options={[{ value: "any", label: "Any priority" }, ...ITEM_PRIORITY_ORDER.map((p) => ({ value: p, label: priorityLabel(forum.kind, p), icon: <ItemPriorityIcon kind={forum.kind} priority={p} /> }))]} />
          {view.tags.length ? <Select<string> aria-label="Tag" value={tagId} onValueChange={setTagId} className="h-8 w-auto min-w-28" options={[{ value: "any", label: "Any tag" }, ...view.tags.map((t) => ({ value: t.id, label: t.name }))]} /> : null}
          <Select<string>
            aria-label="Person"
            value={person}
            onValueChange={setPerson}
            className="h-8 w-auto min-w-32"
            options={[{ value: "any", label: "Anyone" }, { value: "me", label: "Mine" }, ...members.map((m) => ({ value: m.id, label: m.displayName, icon: <UserAvatar user={m} size="xs" /> }))]}
          />
          <Select<Sort> aria-label="Sort" value={sort} onValueChange={setSort} className="h-8 w-auto min-w-28" options={[{ value: "newest", label: "Newest" }, { value: "priority", label: "Priority" }, { value: "updated", label: "Recently updated" }]} />
        </div>

        {/* The list */}
        <div className="mt-4">
          {nothingYet ? (
            <EmptyState
              icon={<span className="text-2xl">{forum.icon}</span>}
              title={`No ${nouns} yet`}
              description={`Each ${noun} has a priority, where it happens, who does it and who verifies. Unresolved ${nouns} stay listed under every update until they're verified.`}
              action={can("item.create") ? <Button variant="primary" onClick={() => setReporting(true)}><Plus /> {words.actions.create} the first {noun}</Button> : null}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<span className="text-2xl">{forum.icon}</span>}
              title={status === "open" ? `No open ${nouns} for ${scopeLabel}` : status === "resolved" ? `No resolved ${nouns} here` : `No ${nouns} match`}
              description={needle || priority !== "any" || tagId !== "any" || person !== "any" ? "Try clearing a filter." : status === "open" ? "Nothing waiting to be done or verified." : undefined}
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-2">
              {filtered.map((b) => (
                <li key={b.id}>
                  <ItemRow item={b} kind={forum.kind} membersById={membersById} tagsById={tagsById} milestoneName={b.milestoneId ? (milestonesById.get(b.milestoneId)?.name ?? null) : null} showUpdate={scope === "all"} onOpen={() => openItem(b.number)} />
                </li>
              ))}
            </ul>
          )}
          {!nothingYet && filtered.length ? (
            <p className="mt-2 text-[11.5px] text-fg-subtle">
              {filtered.length} {filtered.length === 1 ? noun : nouns} · {status === "open" ? "open, in progress or waiting for verification" : status === "resolved" ? "verified or closed" : "all statuses"}
            </p>
          ) : null}
        </div>
      </div>

      <NewItemDialog open={reporting} onOpenChange={setReporting} view={view} members={members} defaultMilestoneId={scope !== "all" && scope !== "none" ? scope : null} onCreated={(item) => openItem(item.number)} />
      {view.viewer.permissions.includes("forum.manage") ? (
        <>
          <TagManagerDialog open={managingTags} onOpenChange={setManagingTags} tags={view.tags} forumId={forum.id} projectId={projectId} />
          <ForumSettingsDialog open={settings} onOpenChange={setSettings} forum={forum} members={members} studioSlug={studioSlug} projectSlug={projectSlug} />
        </>
      ) : null}
      {openNumber ? (
        openItemId ? (
          <ItemDialog key={openItemId} itemId={openItemId} view={view} members={members} studioSlug={studioSlug} projectSlug={projectSlug} onClose={closeItem} />
        ) : (
          <MissingItem number={openNumber} prefix={`${view.project.key}-${forum.keyPrefix}`} onClose={closeItem} />
        )
      ) : null}
    </div>
  );
}

function ItemRow({
  item,
  kind,
  membersById,
  tagsById,
  milestoneName,
  showUpdate,
  onOpen,
}: {
  item: ForumItemSummaryDTO;
  kind: ForumViewDTO["forum"]["kind"];
  membersById: Map<string, MemberDTO>;
  tagsById: Map<string, { id: string; name: string; color: string }>;
  milestoneName: string | null;
  showUpdate: boolean;
  onOpen: () => void;
}) {
  const assignee = item.assigneeId ? membersById.get(item.assigneeId) : undefined;
  const tags = item.tagIds.map((id) => tagsById.get(id)).filter((t): t is { id: string; name: string; color: string } => Boolean(t));
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none md:items-center">
      <ItemPriorityIcon kind={kind} priority={item.priority} className="mt-1 shrink-0 md:mt-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{item.key}</span>
          <span className={cn("min-w-0 truncate text-[13.5px] font-medium", isResolvedItem(item.status) && "text-fg-muted")}>{item.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg-subtle">
          {tags.map((t) => (
            <LabelChip key={t.id} label={t} />
          ))}
          {showUpdate && milestoneName ? <span>{milestoneName}</span> : null}
          {item.counts.attachments ? (
            <span className="inline-flex items-center gap-0.5">
              {item.cover?.kind === "VIDEO" ? <Film className="size-3" /> : <ImageIcon className="size-3" />} {item.counts.attachments}
            </span>
          ) : null}
          {item.counts.comments ? (
            <span className="inline-flex items-center gap-0.5">
              <MessageSquare className="size-3" /> {item.counts.comments}
            </span>
          ) : null}
          <span>{timeAgo(item.createdAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.cover?.thumbUrl ? <img src={item.cover.thumbUrl} alt="" loading="lazy" decoding="async" className="hidden h-9 w-12 rounded border border-border-strong object-cover sm:block" /> : null}
        {assignee ? (
          <Tooltip content={`${assignee.displayName} is on it`}>
            <span>
              <UserAvatar user={assignee} size="sm" online={assignee.online} />
            </span>
          </Tooltip>
        ) : (
          <span className="hidden text-[11px] text-fg-subtle sm:inline">Unassigned</span>
        )}
        <ItemStatusPill kind={kind} status={item.status} resolution={item.resolution} size="sm" short className="md:hidden" />
        <ItemStatusPill kind={kind} status={item.status} resolution={item.resolution} size="sm" className="hidden md:inline-flex" />
      </div>
    </button>
  );
}

function MissingItem({ number, prefix, onClose }: { number: number; prefix: string; onClose: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-4 z-40 mx-auto w-fit max-w-[calc(100vw-32px)] rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-[13px] shadow-lg animate-slide-up" role="alert">
      {prefix}
      {number} doesn&apos;t exist or was deleted.{" "}
      <button type="button" onClick={onClose} className="font-medium text-accent hover:underline">
        Dismiss
      </button>
    </div>
  );
}
