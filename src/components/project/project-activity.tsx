"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { isToday, isYesterday, format } from "date-fns";
import Link from "next/link";
import { useMemo, useState } from "react";
import { qk } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { ActivityDTO, MemberDTO } from "@/lib/types";
import { cn, formatDateTime, timeAgo } from "@/lib/utils";
import { describeActivity } from "../domain/activity-text";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { EmptyState, Skeleton } from "../ui/controls";

function dayLabel(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, MMMM d");
}

export function ProjectActivity({
  projectId,
  projectName,
  projectIcon,
  studioSlug,
  projectSlug,
  members,
  initial,
}: {
  projectId: string;
  projectName: string;
  projectIcon: string;
  studioSlug: string;
  projectSlug: string;
  members: MemberDTO[];
  initial: ActivityDTO[];
}) {
  const [all, setAll] = useState(false);
  const query = useInfiniteQuery({
    queryKey: qk.projectActivity(projectId, all),
    queryFn: ({ pageParam }) => rpc("project.activity", { projectId, all, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length === 40 ? last[last.length - 1]!.createdAt : null),
    initialData: all ? undefined : { pages: [initial], pageParams: [null] },
  });
  const memberName = (id: string) => members.find((m) => m.id === id)?.displayName ?? "someone";
  const events = useMemo(() => query.data?.pages.flat() ?? [], [query.data]);
  const groups = useMemo(() => {
    const map = new Map<string, ActivityDTO[]>();
    for (const e of events) {
      const key = dayLabel(e.createdAt);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()];
  }, [events]);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[12px] text-fg-subtle">
              <Link href={`/${studioSlug}/${projectSlug}`} className="hover:text-fg">
                {projectIcon} {projectName}
              </Link>{" "}
              / Activity
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Project activity</h1>
          </div>
          <div className="flex rounded-md bg-surface-3 p-0.5 text-[12.5px]">
            {[
              [false, "Highlights"],
              [true, "Everything"],
            ].map(([value, label]) => (
              <button key={String(label)} type="button" onClick={() => setAll(value as boolean)} className={cn("h-7 rounded px-3 font-medium", all === value ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")}>
                {label as string}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6">
          {query.isLoading ? (
            <div className="grid gap-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <EmptyState title="No activity yet" description="Card moves, uploads, submissions and reviews will appear here." />
          ) : (
            groups.map(([day, list]) => (
              <section key={day} className="mb-6">
                <h2 className="sticky top-0 z-10 mb-2 bg-bg/90 py-1 text-[12px] font-semibold uppercase tracking-wide text-fg-subtle backdrop-blur">{day}</h2>
                <ol className="grid gap-1">
                  {list.map((e) => (
                    <li key={e.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                      <UserAvatar user={e.actor} size="md" />
                      <div className="min-w-0 flex-1 text-[13px]">
                        <p className="text-fg-muted">
                          <strong className="font-medium text-fg">{e.actor?.displayName ?? "Someone"}</strong> {describeActivity(e, memberName, true)}
                        </p>
                        <time className="text-[11.5px] text-fg-subtle" title={formatDateTime(e.createdAt)}>
                          {timeAgo(e.createdAt)}
                        </time>
                      </div>
                      {e.card ? (
                        <Link href={`/${studioSlug}/${projectSlug}?card=${encodeURIComponent(e.card.key)}`} className="shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-fg-muted hover:border-border-strong hover:text-fg">
                          {e.card.key}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ))
          )}
          {query.hasNextPage ? (
            <div className="text-center">
              <Button variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                Load older activity
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
