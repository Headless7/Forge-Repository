"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, CircleAlert, Clock, Eye, FolderPlus, Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { RpcOutput } from "@/lib/rpc-client";
import { cn, formatShortDate, timeAgo } from "@/lib/utils";
import { describeActivity } from "../domain/activity-text";
import { UserAvatar } from "../domain/avatar";
import { ChecklistDue } from "../domain/checklist-due";
import { StatePill } from "../domain/state";
import { CreateProjectDialog } from "../shell/create-project-dialog";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { Checkbox, EmptyState } from "../ui/controls";

type Home = RpcOutput<"studio.home">;

const REASONS = {
  CHANGES_REQUESTED: { label: "Changes requested", icon: CircleAlert, className: "text-state-changes bg-state-changes/12" },
  NEEDS_YOUR_REVIEW: { label: "Needs your review", icon: Eye, className: "text-state-review bg-state-review/12" },
  OVERDUE: { label: "Overdue", icon: CalendarClock, className: "text-state-changes bg-state-changes/12" },
  DUE_SOON: { label: "Due soon", icon: Clock, className: "text-state-review bg-state-review/12" },
} as const;

/** Checklist items given to the viewer: tick them off here, or open their card. */
function MyChecklistItems({ items, studioId, cardHref }: { items: Home["checklistItems"]; studioId: string; cardHref: (projectSlug: string, key: string, board?: { number: number } | null) => string }) {
  const queryClient = useQueryClient();
  // Ticked items leave the list straight away; Undo brings them back.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const mark = (id: string, done: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    if (done) next.add(id);
    else next.delete(id);
    return next;
  });
  const update = useRpcMutation("checklist.updateItem", {
    onSuccess: (card) => {
      void queryClient.invalidateQueries({ queryKey: qk.home(studioId) });
      void queryClient.invalidateQueries({ queryKey: qk.card(card.id) });
      void queryClient.invalidateQueries({ queryKey: qk.board(card.projectId) });
    },
    onError: (_error, input) => mark(input.itemId, false),
  });
  const tick = (item: Home["checklistItems"][number]) => {
    mark(item.id, true);
    update.mutate(
      { itemId: item.id, isDone: true },
      {
        onSuccess: () =>
          toast.success(`Ticked off “${item.text.length > 60 ? `${item.text.slice(0, 57)}…` : item.text}”`, {
            action: {
              label: "Undo",
              onClick: () => update.mutate({ itemId: item.id, isDone: false }, { onSuccess: () => mark(item.id, false) }),
            },
          }),
      },
    );
  };
  const open = items.filter((i) => !ticked.has(i.id));
  if (open.length === 0) return <p className="text-[13px] text-fg-muted">No checklist items are given to you.</p>;
  return (
    <ul className="grid grid-cols-1 gap-1.5">
      {open.map((item) => (
        <li key={item.id} className="flex items-start gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 transition-colors hover:border-border-strong">
          <Checkbox checked={false} onCheckedChange={(v) => v === true && tick(item)} aria-label={`Tick off ${item.text}`} className="mt-0.5" />
          <Link href={cardHref(item.project.slug, item.card.key, item.board)} className="min-w-0 flex-1">
            <p className="break-words text-[13.5px] font-medium">{item.text}</p>
            <p className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-fg-subtle">
              <span className="font-mono">{item.card.key}</span>
              <span className="min-w-0 max-w-full truncate">{item.card.title}</span>
              {item.board?.shown ? <span>{item.board.name}</span> : null}
              {item.dueOn ? <ChecklistDue dueOn={item.dueOn} /> : null}
            </p>
          </Link>
          <span className="shrink-0 text-lg" aria-hidden>
            {item.project.icon}
          </span>
        </li>
      ))}
    </ul>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function StudioHome({ initial }: { initial: Home }) {
  const { user, studio, can } = useShell();
  const [createOpen, setCreateOpen] = useState(false);
  const { data } = useQuery({ queryKey: qk.home(studio.id), queryFn: () => rpc("studio.home", { studioId: studio.id }), initialData: initial, staleTime: 20_000 });
  /** Opens the card on its board (project links without a board are redirected there too). */
  const cardHref = (projectSlug: string, key: string, board?: { number: number } | null) =>
    `/${studio.slug}/${projectSlug}${board ? `/b/${board.number}` : ""}?card=${encodeURIComponent(key)}`;
  const boardSuffix = (board: { name: string; shown: boolean } | null) => (board?.shown ? ` · ${board.name}` : "");

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[13px] text-fg-muted">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">
              {greeting()}, {user.displayName.split(" ")[0]}
            </h1>
          </div>
          {can("project.create") ? (
            <Button variant="secondary" onClick={() => setCreateOpen(true)}>
              <FolderPlus /> New project
            </Button>
          ) : null}
        </header>

        <section className="mt-8">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Projects</h2>
          {data.projects.length === 0 ? (
            <EmptyState
              icon={<FolderPlus />}
              title="No projects yet"
              description={can("project.create") ? "Create a project to get a board with categories like VFX, Animations and UI." : "Ask a studio admin to add you to a project."}
              action={can("project.create") ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create a project</Button> : null}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.projects.map((p) => (
                <Link key={p.id} href={`/${studio.slug}/${p.slug}`} className="group rounded-xl border border-border bg-surface-2 p-4 transition-colors hover:border-border-strong hover:bg-surface-3/60">
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg text-xl" style={{ backgroundColor: `color-mix(in oklab, ${p.color} 18%, transparent)` }}>
                      {p.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{p.name}</p>
                      <p className="line-clamp-2 text-[12.5px] text-fg-muted">{p.description || `${p.counts.cards} cards`}</p>
                    </div>
                    <ArrowRight className="size-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[11.5px]">
                    <span className={cn("rounded px-1.5 py-0.5 font-semibold", p.counts.needsReview ? "bg-state-review/15 text-state-review" : "bg-surface-4 text-fg-subtle")}>{p.counts.needsReview} to review</span>
                    <span className={cn("rounded px-1.5 py-0.5 font-semibold", p.counts.changesRequested ? "bg-state-changes/15 text-state-changes" : "bg-surface-4 text-fg-subtle")}>{p.counts.changesRequested} changes</span>
                    <span className="rounded bg-surface-4 px-1.5 py-0.5 text-fg-muted">{p.counts.inProgress} in progress</span>
                    <span className="rounded bg-surface-4 px-1.5 py-0.5 text-fg-muted">{p.counts.approved} approved</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Needs your attention</h2>
            {data.attention.length === 0 ? (
              <EmptyState title="You're all caught up" description="Nothing is waiting on you right now — no change requests, reviews or deadlines." />
            ) : (
              <ul className="grid grid-cols-1 gap-2">
                {data.attention.map(({ reason, card, project, board }) => {
                  const meta = REASONS[reason];
                  const Icon = meta.icon;
                  return (
                    <li key={card.id}>
                      <Link href={cardHref(project.slug, card.key, board)} className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-2.5 transition-colors hover:border-border-strong">
                        {card.cover?.thumbUrl ? (
                          <img src={card.cover.thumbUrl} alt="" className="h-11 w-[72px] shrink-0 rounded-md object-cover" />
                        ) : (
                          <span className="flex h-11 w-[72px] shrink-0 items-center justify-center rounded-md bg-surface-4 text-lg">{project.icon}</span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium">{card.title}</p>
                          <p className="truncate text-[11.5px] text-fg-subtle">
                            <span className="font-mono">{card.key}</span> · {project.name}
                            {boardSuffix(board)}
                            {card.counts.unresolvedFeedback ? <span className="text-state-changes"> · {card.counts.unresolvedFeedback} unresolved</span> : null}
                          </p>
                        </div>
                        <span className={cn("hidden items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-semibold sm:inline-flex", meta.className)}>
                          <Icon className="size-3.5" /> {meta.label}
                        </span>
                        <StatePill state={card.state} size="sm" className="sm:hidden" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            <h2 className="mb-1 mt-8 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Your deliverables</h2>
            <p className="mb-3 text-[12px] text-fg-subtle">Unfinished work you&apos;re responsible for or contribute to, soonest deadline first.</p>
            {data.deliverables.length === 0 ? (
              <p className="text-[13px] text-fg-muted">No deliverables are waiting on you.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1.5">
                {data.deliverables.map((item) => {
                  const overdue = item.dueAt ? new Date(item.dueAt).getTime() < Date.now() : false;
                  return (
                    <li key={item.deliverable.id}>
                      <Link
                        href={`${cardHref(item.project.slug, item.card.key, item.board)}&d=${item.deliverable.number}`}
                        className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 transition-colors hover:border-border-strong"
                      >
                        <span className="text-lg" aria-hidden>
                          {item.project.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium">
                            {item.deliverable.name}
                            <span className="font-normal text-fg-muted"> · {item.card.title}</span>
                          </p>
                          <p className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-fg-subtle">
                            <span className="font-mono">{item.card.key}</span>
                            {item.board?.shown ? <span>{item.board.name}</span> : null}
                            <span>{item.role === "responsible" ? "Responsible" : item.role === "contributor" ? "Contributor" : "Card assignee"}</span>
                            {item.dueAt ? (
                              <span className={cn("inline-flex items-center gap-0.5", overdue && "font-semibold text-danger")} title={item.dueInherited ? "The card's deadline" : "Its own deadline"}>
                                <CalendarClock className="size-3" />
                                {overdue ? "overdue · " : ""}
                                {item.dueInherited ? "card · " : ""}
                                {formatShortDate(item.dueAt)}
                              </span>
                            ) : null}
                            {item.waitingOn.length ? (
                              <span className="inline-flex items-center gap-0.5 text-state-review">
                                <Lock className="size-3" /> waiting on {item.waitingOn.join(", ")}
                              </span>
                            ) : null}
                          </p>
                        </div>
                        <StatePill state={item.deliverable.state} size="sm" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            <h2 className="mb-1 mt-8 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Your checklist items</h2>
            <p className="mb-3 text-[12px] text-fg-subtle">Checklist items on cards that are given to you, soonest day first.</p>
            <MyChecklistItems items={data.checklistItems} studioId={studio.id} cardHref={cardHref} />

            <h2 className="mb-3 mt-8 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Recently viewed</h2>
            {data.recent.length === 0 ? (
              <p className="text-[13px] text-fg-muted">Cards you open will show up here.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {data.recent.map(({ card, project, board, viewedAt }) => (
                  <Link key={card.id} href={cardHref(project.slug, card.key, board)} className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-surface-2 p-2 hover:border-border-strong">
                    {card.cover?.thumbUrl ? <img src={card.cover.thumbUrl} alt="" className="h-9 w-14 shrink-0 rounded object-cover" /> : <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded bg-surface-4">{project.icon}</span>}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{card.title}</p>
                      <p className="truncate text-[11px] text-fg-subtle">
                        viewed{" "}
                        {/* "54 seconds ago" can tick over between the server's HTML and the browser taking over. */}
                        <time dateTime={viewedAt} suppressHydrationWarning>
                          {timeAgo(viewedAt)}
                        </time>
                        {boardSuffix(board)}
                      </p>
                    </div>
                    <StatePill state={card.state} size="sm" />
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Recent activity</h2>
            {data.activity.length === 0 ? (
              <p className="text-[13px] text-fg-muted">No activity yet.</p>
            ) : (
              <ol className="grid grid-cols-1 gap-3">
                {data.activity.map((e) => (
                  <li key={e.id} className="flex gap-2.5 text-[12.5px]">
                    <UserAvatar user={e.actor} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-fg-muted">
                        <strong className="font-medium text-fg">{e.actor?.displayName ?? "Someone"}</strong> {describeActivity(e, () => "someone", true)}
                      </p>
                      <p className="text-[11px] text-fg-subtle">
                        <time dateTime={e.createdAt} suppressHydrationWarning>
                          {timeAgo(e.createdAt)}
                        </time>
                        {e.project ? ` · ${e.project.icon} ${e.project.name}` : ""}
                      </p>
                    </div>
                    {e.card && e.project ? (
                      <Link href={cardHref(e.project.slug, e.card.key)} className="touch-target shrink-0 self-start rounded px-1.5 font-mono text-[10.5px] text-fg-subtle hover:bg-surface-3 hover:text-fg">
                        {e.card.key}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} studio={studio} />
    </div>
  );
}
