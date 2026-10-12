"use client";

import { useQuery } from "@tanstack/react-query";
import { Bug, Film, Image as ImageIcon, MessageSquare, Plus, Search, Tag } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUG_PRIORITY_META, BUG_PRIORITY_ORDER, isResolvedBug } from "@/lib/bug-meta";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { BugListDTO, BugPriority, BugSummaryDTO, MemberDTO } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { useRealtimeProject } from "../realtime";
import { UserAvatar } from "../domain/avatar";
import { LabelChip } from "../domain/state";
import { Button } from "../ui/button";
import { EmptyState, Select } from "../ui/controls";
import { Input } from "../ui/input";
import { Tooltip } from "../ui/menu";
import { BugPriorityIcon, BugStatusPill } from "./bug-badges";
import { BugDialog } from "./bug-dialog";
import { NewBugDialog } from "./new-bug-dialog";
import { TagManagerDialog } from "./pickers";

type Scope = "all" | "none" | string;
type StatusFilter = "open" | "resolved" | "all";
type Sort = "newest" | "priority" | "updated";

/**
 * A project's bug tracker. The default view is the global list of every unresolved bug across
 * updates; each update (milestone) also has its own list, and resolved bugs are a filter away.
 */
export function BugsPage({ initial, members, studioSlug, projectSlug }: { initial: BugListDTO; members: MemberDTO[]; studioSlug: string; projectSlug: string }) {
  const projectId = initial.project.id;
  useRealtimeProject(projectId);
  const { data: list } = useQuery({ queryKey: qk.bugs(projectId), queryFn: () => rpc("bug.list", { projectId }), initialData: initial, staleTime: 10_000 });
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openNumber = Number(searchParams.get("bug")) || null;

  const [scope, setScope] = useState<Scope>("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [q, setQ] = useState("");
  const [priority, setPriority] = useState<BugPriority | "any">("any");
  const [tagId, setTagId] = useState<string>("any");
  const [person, setPerson] = useState<string>("any");
  const [sort, setSort] = useState<Sort>("newest");
  const [reporting, setReporting] = useState(false);
  const [managingTags, setManagingTags] = useState(false);

  const can = (p: (typeof list.viewer.permissions)[number]) => list.viewer.permissions.includes(p) && !list.project.archived;
  const viewerId = list.viewer.userId;
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const tagsById = useMemo(() => new Map(list.tags.map((t) => [t.id, t])), [list.tags]);
  const milestonesById = useMemo(() => new Map(list.milestones.map((m) => [m.id, m])), [list.milestones]);

  // ── The open bug, in the URL (?bug=12) so links and Back work ─────────────
  const pushed = useRef(false);
  const openBug = useCallback(
    (number: number) => {
      const params = new URLSearchParams(window.location.search);
      const already = params.get("bug");
      params.set("bug", String(number));
      const url = `${pathname}?${params.toString()}`;
      if (already) window.history.replaceState(null, "", url);
      else {
        window.history.pushState(null, "", url);
        pushed.current = true;
      }
    },
    [pathname],
  );
  const closeBug = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("bug");
    const query = params.toString();
    window.history.replaceState(null, "", `${pathname}${query ? `?${query}` : ""}`);
  }, [pathname]);
  useEffect(() => {
    if (!openNumber) pushed.current = false;
  }, [openNumber]);
  const openBugId = openNumber ? list.bugs.find((b) => b.number === openNumber)?.id : undefined;

  // ── Filtering ─────────────────────────────────────────────────────────────
  const unresolved = useMemo(() => list.bugs.filter((b) => !isResolvedBug(b.status)), [list.bugs]);
  const openCount = (filter: (b: BugSummaryDTO) => boolean) => unresolved.filter(filter).length;
  const scopes: Array<{ id: Scope; label: string; count: number; released?: boolean }> = [
    { id: "all", label: "All updates", count: unresolved.length },
    ...list.milestones.filter((m) => !m.archived).map((m) => ({ id: m.id, label: m.name, count: openCount((b) => b.milestoneId === m.id), released: Boolean(m.releasedAt) })),
    { id: "none", label: "No update", count: openCount((b) => !b.milestoneId) },
  ];
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    const rows = list.bugs.filter((b) => {
      if (scope === "none" ? b.milestoneId : scope !== "all" && b.milestoneId !== scope) return false;
      if (status === "open" ? isResolvedBug(b.status) : status === "resolved" && !isResolvedBug(b.status)) return false;
      if (priority !== "any" && b.priority !== priority) return false;
      if (tagId !== "any" && !b.tagIds.includes(tagId)) return false;
      if (person === "me" ? !(b.assigneeId === viewerId || b.reviewerId === viewerId || b.reportedById === viewerId) : person !== "any" && b.assigneeId !== person) return false;
      if (needle && !`${b.key} ${b.title}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const rank = (b: BugSummaryDTO) => BUG_PRIORITY_META[b.priority].rank;
    return rows.sort((a, b) => {
      if (sort === "priority") return rank(b) - rank(a) || b.createdAt.localeCompare(a.createdAt);
      if (sort === "updated") return b.lastActivityAt.localeCompare(a.lastActivityAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [list.bugs, scope, status, priority, tagId, person, needle, sort, viewerId]);

  const nothingYet = list.bugs.length === 0;
  const scopeLabel = scope === "all" ? "every update" : scope === "none" ? "no update" : (milestonesById.get(scope)?.name ?? "this update");

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[12px] text-fg-subtle">
              <Link href={`/${studioSlug}/${projectSlug}`} className="hover:text-fg">
                {list.project.icon} {list.project.name}
              </Link>{" "}
              / Bugs
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Bugs</h1>
          </div>
          <div className="flex items-center gap-2">
            {can("bugtag.manage") ? (
              <Button variant="ghost" size="sm" onClick={() => setManagingTags(true)}>
                <Tag /> Tags
              </Button>
            ) : null}
            {can("bug.create") ? (
              <Button variant="primary" onClick={() => setReporting(true)}>
                <Plus /> Report a bug
              </Button>
            ) : null}
          </div>
        </div>

        {/* Scope: the global list, or one update */}
        <div className="scrollbar-none -mx-4 mt-5 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label="Updates">
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
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bugs…" aria-label="Search bugs" className="pl-7" />
          </div>
          <Select<BugPriority | "any"> aria-label="Priority" value={priority} onValueChange={setPriority} className="h-8 w-auto min-w-32" options={[{ value: "any", label: "Any priority" }, ...BUG_PRIORITY_ORDER.map((p) => ({ value: p, label: BUG_PRIORITY_META[p].label, icon: <BugPriorityIcon priority={p} /> }))]} />
          {list.tags.length ? <Select<string> aria-label="Tag" value={tagId} onValueChange={setTagId} className="h-8 w-auto min-w-28" options={[{ value: "any", label: "Any tag" }, ...list.tags.map((t) => ({ value: t.id, label: t.name }))]} /> : null}
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
              icon={<Bug />}
              title="No bugs reported"
              description="Bugs live here, beside the boards: each with its priority, where it happens, who fixes it and who verifies the fix. Unresolved bugs stay listed under every update until they're verified."
              action={can("bug.create") ? <Button variant="primary" onClick={() => setReporting(true)}><Plus /> Report the first bug</Button> : null}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Bug />}
              title={status === "open" ? `No open bugs for ${scopeLabel}` : status === "resolved" ? "No resolved bugs here" : "No bugs match"}
              description={needle || priority !== "any" || tagId !== "any" || person !== "any" ? "Try clearing a filter." : status === "open" ? "Nothing waiting to be fixed or verified." : undefined}
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-2">
              {filtered.map((b) => (
                <li key={b.id}>
                  <BugRow bug={b} membersById={membersById} tagsById={tagsById} milestoneName={b.milestoneId ? (milestonesById.get(b.milestoneId)?.name ?? null) : null} showUpdate={scope === "all"} onOpen={() => openBug(b.number)} />
                </li>
              ))}
            </ul>
          )}
          {!nothingYet && filtered.length ? (
            <p className="mt-2 text-[11.5px] text-fg-subtle">
              {filtered.length} bug{filtered.length === 1 ? "" : "s"} · {status === "open" ? "open, in progress or waiting for verification" : status === "resolved" ? "verified or closed" : "all statuses"}
            </p>
          ) : null}
        </div>
      </div>

      <NewBugDialog open={reporting} onOpenChange={setReporting} list={list} members={members} defaultMilestoneId={scope !== "all" && scope !== "none" ? scope : null} onCreated={(bug) => openBug(bug.number)} />
      {can("bugtag.manage") ? <TagManagerDialog open={managingTags} onOpenChange={setManagingTags} tags={list.tags} projectId={projectId} /> : null}
      {openNumber ? (
        openBugId ? (
          <BugDialog key={openBugId} bugId={openBugId} list={list} members={members} studioSlug={studioSlug} projectSlug={projectSlug} onClose={closeBug} />
        ) : (
          <MissingBug number={openNumber} projectKey={list.project.key} onClose={closeBug} />
        )
      ) : null}
    </div>
  );
}

function BugRow({
  bug,
  membersById,
  tagsById,
  milestoneName,
  showUpdate,
  onOpen,
}: {
  bug: BugSummaryDTO;
  membersById: Map<string, MemberDTO>;
  tagsById: Map<string, { id: string; name: string; color: string }>;
  milestoneName: string | null;
  showUpdate: boolean;
  onOpen: () => void;
}) {
  const assignee = bug.assigneeId ? membersById.get(bug.assigneeId) : undefined;
  const tags = bug.tagIds.map((id) => tagsById.get(id)).filter((t): t is { id: string; name: string; color: string } => Boolean(t));
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none md:items-center">
      <BugPriorityIcon priority={bug.priority} className="mt-1 shrink-0 md:mt-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{bug.key}</span>
          <span className={cn("min-w-0 truncate text-[13.5px] font-medium", isResolvedBug(bug.status) && "text-fg-muted")}>{bug.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fg-subtle">
          {tags.map((t) => (
            <LabelChip key={t.id} label={t} />
          ))}
          {showUpdate && milestoneName ? <span>{milestoneName}</span> : null}
          {bug.counts.attachments ? (
            <span className="inline-flex items-center gap-0.5">
              {bug.cover?.kind === "VIDEO" ? <Film className="size-3" /> : <ImageIcon className="size-3" />} {bug.counts.attachments}
            </span>
          ) : null}
          {bug.counts.comments ? (
            <span className="inline-flex items-center gap-0.5">
              <MessageSquare className="size-3" /> {bug.counts.comments}
            </span>
          ) : null}
          <span>{timeAgo(bug.createdAt)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {bug.cover?.thumbUrl ? <img src={bug.cover.thumbUrl} alt="" loading="lazy" decoding="async" className="hidden h-9 w-12 rounded border border-border-strong object-cover sm:block" /> : null}
        {assignee ? (
          <Tooltip content={`${assignee.displayName} is fixing it`}>
            <span>
              <UserAvatar user={assignee} size="sm" online={assignee.online} />
            </span>
          </Tooltip>
        ) : (
          <span className="hidden text-[11px] text-fg-subtle sm:inline">Unassigned</span>
        )}
        <BugStatusPill status={bug.status} resolution={bug.resolution} size="sm" short className="md:hidden" />
        <BugStatusPill status={bug.status} resolution={bug.resolution} size="sm" className="hidden md:inline-flex" />
      </div>
    </button>
  );
}

function MissingBug({ number, projectKey, onClose }: { number: number; projectKey: string; onClose: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-4 z-40 mx-auto w-fit max-w-[calc(100vw-32px)] rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-[13px] shadow-lg animate-slide-up" role="alert">
      {projectKey}-B{number} doesn&apos;t exist or was deleted.{" "}
      <button type="button" onClick={onClose} className="font-medium text-accent hover:underline">
        Dismiss
      </button>
    </div>
  );
}
