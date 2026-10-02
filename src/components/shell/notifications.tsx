"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck, CircleAlert, CircleCheck, Eye, MessageSquare, AtSign, UserPlus, CalendarClock, Reply, Sparkles, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { NotificationDTO } from "@/lib/types";
import { cn, formatTimecode, timeAgo } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { Dialog, SheetContent } from "../ui/dialog";
import { Tooltip } from "../ui/menu";

const TYPE_ICON: Record<string, ReactNode> = {
  ASSIGNED: <UserPlus className="text-info" />,
  MENTIONED: <AtSign className="text-accent" />,
  COMMENT: <MessageSquare className="text-fg-muted" />,
  REPLY: <Reply className="text-fg-muted" />,
  REVIEW_REQUESTED: <Eye className="text-state-review" />,
  CHANGES_REQUESTED: <CircleAlert className="text-state-changes" />,
  APPROVED: <CircleCheck className="text-state-approved" />,
  WATCHED_CARD: <Sparkles className="text-fg-muted" />,
  DUE_SOON: <CalendarClock className="text-state-review" />,
};

export function describeNotification(n: NotificationDTO): { headline: ReactNode; detail: string | null } {
  const actor = <strong className="font-semibold text-fg">{n.actor?.displayName ?? "Someone"}</strong>;
  const card = <strong className="font-semibold text-fg">{n.card?.title ?? "a card"}</strong>;
  const d = n.data as { excerpt?: string; versionNumber?: number | null; feedbackCount?: number; change?: string; note?: string; firstItem?: string; timestampMs?: number | null };
  const v = d.versionNumber ? ` V${d.versionNumber}` : "";
  const at = typeof d.timestampMs === "number" ? `[${formatTimecode(d.timestampMs)}] ` : "";
  switch (n.type) {
    case "ASSIGNED":
      return { headline: <>{actor} assigned you to {card}</>, detail: null };
    case "MENTIONED":
      return { headline: <>{actor} mentioned you in {card}</>, detail: d.excerpt ?? null };
    case "COMMENT":
      return { headline: <>{actor} commented on {card}</>, detail: d.excerpt ? `${at}${d.excerpt}` : null };
    case "REPLY":
      return { headline: <>{actor} replied to you on {card}</>, detail: d.excerpt ?? null };
    case "REVIEW_REQUESTED":
      return { headline: <>{actor} submitted {card}{v} for review</>, detail: null };
    case "CHANGES_REQUESTED":
      return {
        headline: <>{actor} requested changes on {card}{v}</>,
        detail: d.feedbackCount ? `${d.feedbackCount} feedback item${d.feedbackCount === 1 ? "" : "s"}${d.firstItem ? ` · ${d.firstItem}` : d.note ? ` · ${d.note}` : ""}` : (d.note ?? null),
      };
    case "APPROVED":
      return { headline: <>{actor} approved {card}{v}</>, detail: d.note ?? null };
    case "WATCHED_CARD":
      return { headline: <>{actor} {d.change ?? "updated"} on {card}</>, detail: null };
    case "DUE_SOON":
      return { headline: <>{card} is due within 24 hours</>, detail: null };
    default:
      return { headline: <>{actor} updated {card}</>, detail: null };
  }
}

export function useUnreadCount(initial: number) {
  return useQuery({
    queryKey: qk.unread(),
    queryFn: async () => (await rpc("notification.unreadCount", {})).count,
    initialData: initial,
    staleTime: 15_000,
    refetchInterval: 120_000,
  });
}

function NotificationItem({ n, onOpen, onToggleRead }: { n: NotificationDTO; onOpen: (n: NotificationDTO) => void; onToggleRead: (n: NotificationDTO) => void }) {
  const { headline, detail } = describeNotification(n);
  const unread = !n.readAt;
  return (
    <li className={cn("group relative flex gap-3 border-b border-border px-4 py-3 transition-colors hover:bg-surface-3/60", unread && "bg-accent-soft/40")}>
      <div className="relative mt-0.5">
        <UserAvatar user={n.actor} size="md" />
        <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border border-border-strong bg-surface-2 [&_svg]:size-2.5">
          {TYPE_ICON[n.type] ?? <Bell />}
        </span>
      </div>
      <button type="button" onClick={() => onOpen(n)} className="min-w-0 flex-1 text-left">
        <p className="text-[13px] leading-snug text-fg-muted">{headline}</p>
        {detail ? <p className="mt-1 line-clamp-2 rounded-md border-l-2 border-border-strong pl-2 text-[12.5px] text-fg-muted">{detail}</p> : null}
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-subtle">
          {n.project ? (
            <>
              <span>{n.project.icon}</span>
              <span className="truncate">{n.project.name}</span>
              {n.card ? <span className="font-mono">· {n.card.key}</span> : null}
              <span>·</span>
            </>
          ) : null}
          <span>{timeAgo(n.createdAt)}</span>
        </p>
      </button>
      <Tooltip content={unread ? "Mark as read" : "Mark as unread"}>
        <button
          type="button"
          onClick={() => onToggleRead(n)}
          aria-label={unread ? "Mark as read" : "Mark as unread"}
          className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full"
        >
          <span className={cn("size-2 rounded-full transition-colors", unread ? "bg-accent" : "bg-transparent ring-1 ring-border-strong group-hover:ring-fg-subtle")} />
        </button>
      </Tooltip>
    </li>
  );
}

export function NotificationsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useInfiniteQuery({
    queryKey: [...qk.notifications(), unreadOnly],
    queryFn: ({ pageParam }) => rpc("notification.list", { unreadOnly, before: pageParam ?? undefined, limit: 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.items.length === 30 ? last.items[last.items.length - 1]!.createdAt : null),
    enabled: open,
  });
  const markRead = useRpcMutation("notification.markRead", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.notifications() });
    },
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = list.data?.pages[0]?.unreadCount ?? 0;

  const openNotification = (n: NotificationDTO) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    onOpenChange(false);
    router.push(n.href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent title="Notifications" side="right">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[15px] font-semibold">Notifications</h2>
            <p className="text-xs text-fg-subtle">{unreadCount ? `${unreadCount} unread` : "You're all caught up"}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={!unreadCount} onClick={() => markRead.mutate({ all: true })}>
              <CheckCheck /> Mark all read
            </Button>
            <Tooltip content="Notification settings">
              <Button asChild size="icon-sm" variant="ghost" aria-label="Notification settings">
                <Link href="/account/notifications" onClick={() => onOpenChange(false)}>
                  <Settings />
                </Link>
              </Button>
            </Tooltip>
          </div>
        </header>
        <div className="flex gap-1 border-b border-border px-4 py-2">
          {[
            [false, "All"],
            [true, "Unread"],
          ].map(([value, label]) => (
            <button
              key={String(label)}
              type="button"
              onClick={() => setUnreadOnly(value as boolean)}
              className={cn("h-7 rounded-md px-2.5 text-[13px] font-medium", unreadOnly === value ? "bg-surface-4 text-fg" : "text-fg-muted hover:text-fg")}
            >
              {label as string}
            </button>
          ))}
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div className="grid gap-3 p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-surface-3" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-fg-muted">
              <BellOff className="size-6 text-fg-subtle" />
              <p className="text-sm">{unreadOnly ? "No unread notifications." : "Nothing here yet."}</p>
            </div>
          ) : (
            <ul>
              {items.map((n) => (
                <NotificationItem key={n.id} n={n} onOpen={openNotification} onToggleRead={(x) => markRead.mutate({ ids: [x.id], read: !x.readAt })} />
              ))}
            </ul>
          )}
          {list.hasNextPage ? (
            <div className="p-3 text-center">
              <Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Load older
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Dialog>
  );
}
