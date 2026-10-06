"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Hash, MessagesSquare, Pencil, Plus, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DEFAULT_DISCORD_EVENTS, DISCORD_EVENT_META, DISCORD_EVENTS, type DiscordEventType } from "@/lib/discord";
import { useRpcMutation } from "@/lib/queries";
import { rpc, type RpcOutput } from "@/lib/rpc-client";
import type { BoardDTO } from "@/lib/types";
import { cn, formatShortDate, timeAgo } from "@/lib/utils";
import { Button } from "../ui/button";
import { Checkbox, Select, Skeleton } from "../ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Label } from "../ui/input";

type DiscordStatus = RpcOutput<"discord.status">;
type DiscordFeed = RpcOutput<"discord.feeds">[number];

export const discordKeys = {
  all: ["discord"] as const,
  status: (studioId: string) => ["discord", "status", studioId] as const,
  studioFeeds: (studioId: string) => ["discord", "studioFeeds", studioId] as const,
  feeds: (projectId: string) => ["discord", "feeds", projectId] as const,
  channels: (projectId: string) => ["discord", "channels", projectId] as const,
};

export function useDiscordStatus(studioId: string, enabled = true) {
  return useQuery({ queryKey: discordKeys.status(studioId), queryFn: () => rpc("discord.status", { studioId }), enabled, staleTime: 30_000 });
}

const ALL_BOARDS = "ALL";

function connectHref(studioId: string, studioSlug: string) {
  return `/api/integrations/discord/connect?studioId=${encodeURIComponent(studioId)}&studio=${encodeURIComponent(studioSlug)}`;
}

function eventList(events: DiscordEventType[]) {
  return DISCORD_EVENTS.filter((e) => events.includes(e))
    .map((e) => DISCORD_EVENT_META[e].label)
    .join(" · ");
}

function ServerBadge({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-[14px] font-semibold text-accent">
      {name.trim().charAt(0).toUpperCase() || "#"}
    </span>
  );
}

function LostWarning({ action }: { action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 basis-56">Forge can&apos;t reach this Discord server anymore — the bot may have been removed or lost access. Feeds are paused until it&apos;s reconnected.</span>
      {action}
    </div>
  );
}

/** Studio settings: connect the team's Discord server (Admins and the Owner) and see every feed. */
export function StudioDiscord({ studioId, studioSlug }: { studioId: string; studioSlug: string }) {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // Discord sends people back with ?discord=connected or ?discordError=…; show it once, then tidy the URL.
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(() => {
    if (searchParams.get("discord") === "connected") return { tone: "success", text: "Discord connected." };
    const error = searchParams.get("discordError");
    return error ? { tone: "error", text: error.slice(0, 300) } : null;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("discord") && !url.searchParams.has("discordError")) return;
    url.searchParams.delete("discord");
    url.searchParams.delete("discordError");
    url.searchParams.delete("ns");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const status = useDiscordStatus(studioId);
  const connection = status.data?.connection ?? null;
  const feeds = useQuery({ queryKey: discordKeys.studioFeeds(studioId), queryFn: () => rpc("discord.studioFeeds", { studioId }), enabled: Boolean(connection) });
  const [confirming, setConfirming] = useState(false);
  const disconnect = useRpcMutation("discord.disconnect", {
    onSuccess: () => {
      setConfirming(false);
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: discordKeys.all });
      toast.success("Discord disconnected.");
    },
  });

  return (
    <section id="discord" className="scroll-mt-6 rounded-xl border border-border bg-surface-2 p-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        <MessagesSquare className="size-4 text-fg-muted" /> Discord
      </h2>
      <p className="mt-0.5 text-[12.5px] text-fg-muted">
        Post review and delivery updates to channels in your team&apos;s Discord server. Messages say who did what and link back to Forge — comment and feedback text and files are never posted, and nothing can be changed from Discord.
      </p>
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("mt-3 rounded-lg border px-3 py-2 text-[12.5px]", notice.tone === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-state-approved/40 bg-state-approved/10")}>
          {notice.tone === "success" && connection ? `Connected to ${connection.guildName}. Managers can now add feeds in each project's settings.` : notice.text}
        </p>
      ) : null}
      <div className="mt-4 grid gap-4">
        {status.isLoading ? (
          <Skeleton className="h-12" />
        ) : !status.data ? (
          <p className="text-[12.5px] text-danger">Couldn&apos;t load the Discord connection.</p>
        ) : !status.data.configured ? (
          <p className="rounded-lg border border-border-strong px-3 py-2 text-[12.5px] text-fg-muted">Discord isn&apos;t set up on this Forge server. Whoever runs Forge needs to add the Discord app&apos;s credentials first.</p>
        ) : !connection ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 basis-64 text-[12.5px] text-fg-muted">
              You&apos;ll choose a server where you have <strong className="font-medium text-fg">Manage Server</strong>. Forge&apos;s bot only asks to view channels, send messages and embed links.
            </p>
            <Button asChild variant="primary">
              <a href={connectHref(studioId, studioSlug)}>Connect Discord</a>
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <ServerBadge name={connection.guildName} />
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-[13px] font-medium">{connection.guildName}</p>
                <p className="text-[11.5px] text-fg-subtle">
                  Connected{connection.connectedBy ? ` by ${connection.connectedBy}` : ""} · {formatShortDate(connection.connectedAt)}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            </div>
            {connection.lost ? (
              <LostWarning
                action={
                  <Button asChild size="xs" variant="secondary">
                    <a href={connectHref(studioId, studioSlug)}>Reconnect</a>
                  </Button>
                }
              />
            ) : null}
            <div>
              <p className="text-[13px] font-medium">Feeds{feeds.data ? ` · ${feeds.data.length}` : ""}</p>
              <p className="mb-2 text-[12px] text-fg-muted">Managers add and change feeds in each project&apos;s settings.</p>
              {feeds.isLoading ? (
                <Skeleton className="h-10" />
              ) : feeds.data?.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {feeds.data.map((feed) => (
                    <li key={feed.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <div className="min-w-0 flex-1 basis-56">
                        <p className="truncate text-[13px]">
                          <span className="font-medium">#{feed.channelName}</span>
                          <span className="text-fg-muted">
                            {" "}
                            ← {feed.projectName} · {feed.boardName ?? "All boards"}
                          </span>
                        </p>
                        <p className="text-[11.5px] text-fg-subtle">{eventList(feed.events)}</p>
                        {feed.lastError ? <p className="text-[11.5px] text-danger">{feed.lastError}</p> : null}
                      </div>
                      <Link href={`/${studioSlug}/${feed.projectSlug}/settings#discord`} className="touch-target inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
                        Manage <ArrowRight className="size-3.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-fg-muted">No feeds yet.</p>
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect Discord?"
        destructive
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate({ studioId })}
        description={`Every Discord feed in this studio is removed and Forge's bot leaves ${connection?.guildName ?? "the server"}. Messages already posted stay in Discord.`}
      />
    </section>
  );
}

/** Project settings: which channels get this project's events (Managers and above). */
export function ProjectDiscordFeeds({ board, status, studioSlug, canManage }: { board: BoardDTO; status: DiscordStatus; studioSlug: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const projectId = board.project.id;
  const connection = status.connection;
  const feeds = useQuery({ queryKey: discordKeys.feeds(projectId), queryFn: () => rpc("discord.feeds", { projectId }), enabled: Boolean(connection) });
  const [editing, setEditing] = useState<DiscordFeed | "new" | null>(null);
  const [removing, setRemoving] = useState<DiscordFeed | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: discordKeys.all });
  const remove = useRpcMutation("discord.deleteFeed", {
    onSuccess: () => {
      setRemoving(null);
      refresh();
      toast.success("Feed removed.");
    },
  });
  const test = useRpcMutation("discord.testFeed", {
    onSuccess: (result, { feedId }) => {
      const feed = feeds.data?.find((f) => f.id === feedId);
      if (result.ok) toast.success(`Test message posted in #${feed?.channelName ?? "the channel"}.`);
      else toast.error(result.error ?? "Couldn't post the test message.");
      refresh();
    },
  });

  return (
    <section id="discord" className="scroll-mt-6 rounded-xl border border-border bg-surface-2 p-5">
      <h2 className="text-[15px] font-semibold">Discord feeds</h2>
      <p className="mt-0.5 text-[12.5px] text-fg-muted">Post this project&apos;s reviews, completions and deadlines to Discord channels. Messages say who did what and link back to Forge; comment and feedback text and files are never posted.</p>
      <div className="mt-4 grid gap-3">
        {!connection ? (
          <p className="text-[12.5px] text-fg-muted">
            Discord isn&apos;t connected for this studio.{" "}
            {status.canConnect ? (
              <Link href={`/${studioSlug}/settings#discord`} className="text-accent hover:underline">
                Connect it in studio settings
              </Link>
            ) : (
              "A studio Admin or the Owner can connect it in studio settings."
            )}
          </p>
        ) : (
          <>
            {connection.lost ? <LostWarning /> : null}
            <p className="flex items-center gap-2 text-[12px] text-fg-subtle">
              <ServerBadge name={connection.guildName} />
              <span>
                Posting to <strong className="font-medium text-fg">{connection.guildName}</strong>
              </span>
            </p>
            {board.project.archived ? <p className="text-[12.5px] text-fg-muted">This project is archived, so its feeds are paused.</p> : null}
            {feeds.isLoading ? (
              <Skeleton className="h-12" />
            ) : feeds.data?.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {feeds.data.map((feed) => (
                  <li key={feed.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
                    <div className="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
                      <Hash className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px]">
                          <span className="font-medium">{feed.channelName}</span>
                          <span className="text-fg-muted"> · {feed.boardName ?? "All boards"}</span>
                        </p>
                        <p className="text-[11.5px] text-fg-subtle">{eventList(feed.events)}</p>
                        {feed.lastError ? (
                          <p className="mt-0.5 flex items-start gap-1 text-[11.5px] text-danger">
                            <AlertTriangle className="mt-px size-3.5 shrink-0" /> {feed.lastError}
                          </p>
                        ) : feed.lastSentAt ? (
                          <p className="text-[11.5px] text-fg-subtle">Last posted {timeAgo(feed.lastSentAt)}</p>
                        ) : null}
                      </div>
                    </div>
                    {canManage ? (
                      <div className="flex items-center gap-1">
                        <Button size="xs" variant="ghost" loading={test.isPending && test.variables?.feedId === feed.id} disabled={connection.lost} onClick={() => test.mutate({ feedId: feed.id })}>
                          <Send /> Send test
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label={`Edit the #${feed.channelName} feed`} onClick={() => setEditing(feed)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-xs" variant="ghost" aria-label={`Remove the #${feed.channelName} feed`} onClick={() => setRemoving(feed)}>
                          <Trash2 />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-fg-muted">No feeds yet. Add one to post this project&apos;s events to a channel.</p>
            )}
            {canManage ? (
              <div>
                <Button variant="secondary" size="sm" disabled={connection.lost} onClick={() => setEditing("new")}>
                  <Plus /> Add feed
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent
          title={editing === "new" ? "Add Discord feed" : "Edit Discord feed"}
          description="Choose a channel and what Forge posts there."
          className="top-3 max-h-[calc(100dvh-24px)] overflow-y-auto sm:top-[12vh] sm:max-h-[80vh]"
        >
          {editing ? <FeedForm board={board} feed={editing === "new" ? null : editing} existing={feeds.data ?? []} onDone={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove the #${removing?.channelName ?? ""} feed?`}
        destructive
        confirmLabel="Remove feed"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate({ feedId: removing.id })}
        description="Forge stops posting this project's events there. Messages already posted stay in Discord."
      />
    </section>
  );
}

function FeedForm({ board, feed, existing, onDone }: { board: BoardDTO; feed: DiscordFeed | null; existing: DiscordFeed[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const projectId = board.project.id;
  const channels = useQuery({ queryKey: discordKeys.channels(projectId), queryFn: () => rpc("discord.channels", { projectId }), staleTime: 30_000, retry: false });
  const [boardId, setBoardId] = useState<string>(feed?.boardId ?? ALL_BOARDS);
  const [channelId, setChannelId] = useState<string | undefined>(feed?.channelId);
  const [events, setEvents] = useState<DiscordEventType[]>(feed?.events ?? DEFAULT_DISCORD_EVENTS);
  const [confirmed, setConfirmed] = useState(false);
  const save = useRpcMutation("discord.saveFeed", {
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: discordKeys.all });
      toast.success(feed ? "Feed updated." : `Feed added. Use Send test to check Forge can post in #${saved.channelName}.`);
      onDone();
    },
  });

  const channelList = channels.data ?? [];
  const channel = channelList.find((c) => c.id === channelId);
  const channelOptions = channelList.map((c) => ({ value: c.id, label: c.category ? `#${c.name} · ${c.category}` : `#${c.name}` }));
  if (feed && channels.data && !channel) channelOptions.unshift({ value: feed.channelId, label: `#${feed.channelName} (not found)` });
  const boardOptions = [{ value: ALL_BOARDS, label: "All boards" }, ...board.boards.map((b) => ({ value: b.id, label: b.name }))];
  if (feed?.boardId && !board.boards.some((b) => b.id === feed.boardId)) boardOptions.push({ value: feed.boardId, label: `${feed.boardName ?? "Board"} (archived)` });
  const channelName = channel?.name ?? (channelId === feed?.channelId ? feed?.channelName : undefined);
  const isPrivate = board.project.visibility === "PRIVATE";
  const needsConfirmation = isPrivate && !(feed?.privateConfirmed && feed.channelId === channelId);
  const duplicate = existing.some((f) => f.id !== feed?.id && f.channelId === channelId && (f.boardId ?? ALL_BOARDS) === boardId);
  const ready = Boolean(channelId) && events.length > 0 && (!needsConfirmation || confirmed) && !duplicate;

  const toggle = (event: DiscordEventType, on: boolean) => setEvents((list) => (on ? [...list, event] : list.filter((e) => e !== event)));

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !channelId) return;
        save.mutate({ projectId, feedId: feed?.id ?? null, boardId: boardId === ALL_BOARDS ? null : boardId, channelId, events, confirmPrivate: needsConfirmation && confirmed });
      }}
    >
      <div>
        <Label>Channel</Label>
        {channels.isLoading ? (
          <Skeleton className="h-8" />
        ) : channels.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-[12.5px] text-danger">
            <span className="min-w-0 flex-1">{channels.error.message || "Couldn't load channels."}</span>
            <Button size="xs" variant="secondary" onClick={() => void channels.refetch()}>
              Retry
            </Button>
          </div>
        ) : channelOptions.length ? (
          <Select
            aria-label="Channel"
            value={channelId}
            onValueChange={(id) => {
              setChannelId(id);
              setConfirmed(false); // a private project needs confirming for each channel
            }}
            placeholder="Choose a channel"
            options={channelOptions}
          />
        ) : (
          <p className="text-[12.5px] text-fg-muted">There are no text channels in this server yet.</p>
        )}
        <p className="mt-1 text-[11.5px] text-fg-subtle">Forge&apos;s bot needs to be able to view the channel, send messages and embed links there. Send test checks it.</p>
      </div>
      <div>
        <Label>Board</Label>
        <Select aria-label="Board" value={boardId} onValueChange={setBoardId} options={boardOptions} />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-[12.5px] font-medium">Post when</legend>
        <div className="grid gap-1">
          {DISCORD_EVENTS.map((event) => {
            const id = `discord-event-${event}`;
            return (
              <label key={event} htmlFor={id} className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5 hover:bg-surface-3">
                <Checkbox id={id} className="mt-0.5" checked={events.includes(event)} onCheckedChange={(v) => toggle(event, v === true)} />
                <span>
                  <span className="block text-[13px]">{DISCORD_EVENT_META[event].label}</span>
                  <span className="block text-[11.5px] text-fg-muted">{DISCORD_EVENT_META[event].hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {!events.length ? <p className="mt-1 text-[11.5px] text-danger">Choose at least one.</p> : null}
      </fieldset>
      {needsConfirmation && channelId ? (
        <label htmlFor="discord-private" className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
          <Checkbox id="discord-private" className="mt-0.5" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
          <span className="text-[12.5px]">
            <span className="block font-medium">This project is private</span>
            <span className="block text-fg-muted">Everyone who can read {channelName ? `#${channelName}` : "this channel"} in Discord will see its card titles, who worked on them and review results. I confirm that&apos;s fine.</span>
          </span>
        </label>
      ) : null}
      {duplicate ? <p className="text-[12px] text-danger">This channel already gets {boardId === ALL_BOARDS ? "this project's" : "this board's"} events. Edit that feed instead.</p> : null}
      <DialogFooter className="mt-1">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
          {feed ? "Save feed" : "Add feed"}
        </Button>
      </DialogFooter>
    </form>
  );
}
