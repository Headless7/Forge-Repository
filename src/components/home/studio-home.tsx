"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CalendarClock, CircleAlert, Clock, Eye, FolderPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { RpcOutput } from "@/lib/rpc-client";
import { cn, timeAgo } from "@/lib/utils";
import { describeActivity } from "../domain/activity-text";
import { UserAvatar } from "../domain/avatar";
import { StatePill } from "../domain/state";
import { CreateProjectDialog } from "../shell/create-project-dialog";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/controls";

type Home = RpcOutput<"studio.home">;

const REASONS = {
  CHANGES_REQUESTED: { label: "Changes requested", icon: CircleAlert, className: "text-state-changes bg-state-changes/12" },
  NEEDS_YOUR_REVIEW: { label: "Needs your review", icon: Eye, className: "text-state-review bg-state-review/12" },
  OVERDUE: { label: "Overdue", icon: CalendarClock, className: "text-state-changes bg-state-changes/12" },
  DUE_SOON: { label: "Due soon", icon: Clock, className: "text-state-review bg-state-review/12" },
} as const;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function StudioHome({ initial }: { initial: Home }) {
  const { user, studio, can } = useShell();
  const [createOpen, setCreateOpen] = useState(false);
  const { data } = useQuery({ queryKey: qk.home(studio.id), queryFn: () => rpc("studio.home", { studioId: studio.id }), initialData: initial, staleTime: 20_000 });
  const cardHref = (projectSlug: string, key: string) => `/${studio.slug}/${projectSlug}?card=${encodeURIComponent(key)}`;

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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Needs your attention</h2>
            {data.attention.length === 0 ? (
              <EmptyState title="You're all caught up" description="Nothing is waiting on you right now — no change requests, reviews or deadlines." />
            ) : (
              <ul className="grid gap-2">
                {data.attention.map(({ reason, card, project }) => {
                  const meta = REASONS[reason];
                  const Icon = meta.icon;
                  return (
                    <li key={card.id}>
                      <Link href={cardHref(project.slug, card.key)} className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-2.5 transition-colors hover:border-border-strong">
                        {card.cover?.thumbUrl ? (
                          <img src={card.cover.thumbUrl} alt="" className="h-11 w-[72px] shrink-0 rounded-md object-cover" />
                        ) : (
                          <span className="flex h-11 w-[72px] shrink-0 items-center justify-center rounded-md bg-surface-4 text-lg">{project.icon}</span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-medium">{card.title}</p>
                          <p className="truncate text-[11.5px] text-fg-subtle">
                            <span className="font-mono">{card.key}</span> · {project.name}
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

            <h2 className="mb-3 mt-8 text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Recently viewed</h2>
            {data.recent.length === 0 ? (
              <p className="text-[13px] text-fg-muted">Cards you open will show up here.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {data.recent.map(({ card, project, viewedAt }) => (
                  <Link key={card.id} href={cardHref(project.slug, card.key)} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 p-2 hover:border-border-strong">
                    {card.cover?.thumbUrl ? <img src={card.cover.thumbUrl} alt="" className="h-9 w-14 shrink-0 rounded object-cover" /> : <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded bg-surface-4">{project.icon}</span>}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{card.title}</p>
                      <p className="truncate text-[11px] text-fg-subtle">viewed {timeAgo(viewedAt)}</p>
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
              <ol className="grid gap-3">
                {data.activity.map((e) => (
                  <li key={e.id} className="flex gap-2.5 text-[12.5px]">
                    <UserAvatar user={e.actor} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-fg-muted">
                        <strong className="font-medium text-fg">{e.actor?.displayName ?? "Someone"}</strong> {describeActivity(e, () => "someone", true)}
                      </p>
                      <p className="text-[11px] text-fg-subtle">
                        {timeAgo(e.createdAt)}
                        {e.project ? ` · ${e.project.icon} ${e.project.name}` : ""}
                      </p>
                    </div>
                    {e.card && e.project ? (
                      <Link href={cardHref(e.project.slug, e.card.key)} className="shrink-0 self-start rounded px-1.5 font-mono text-[10.5px] text-fg-subtle hover:bg-surface-3 hover:text-fg">
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
