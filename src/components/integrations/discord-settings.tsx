"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Hash, MessagesSquare, Pause, Pencil, Plus, Send, Trash2 } from "lucide-react";
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
type DiscordServer = DiscordStatus["servers"][number];
type DiscordFeed = RpcOutput<"discord.project">["feeds"][number];

export const discordKeys = {
  all: ["discord"] as const,
  status: (studioId: string) => ["discord", "status", studioId] as const,
  studioFeeds: (studioId: string) => ["discord", "studioFeeds", studioId] as const,
  project: (projectId: string) => ["discord", "project", projectId] as const,
  channels: (projectId: string) => ["discord", "channels", projectId] as const,
};

export function useDiscordStatus(studioId: string, enabled = true) {
  return useQuery({ queryKey: discordKeys.status(studioId), queryFn: () => rpc("discord.status", { studioId }), enabled, staleTime: 30_000 });
}

const ALL_BOARDS = "ALL";
const NO_SERVER = "NONE";

function connectHref(studioId: string, studioSlug: string) {
  return `/api/integrations/discord/connect?studioId=${encodeURIComponent(studioId)}&studio=${encodeURIComponent(studioSlug)}`;
}

function eventList(events: DiscordEventType[]) {
  return DISCORD_EVENTS.filter((e) => events.includes(e))
    .map((e) => DISCORD_EVENT_META[e].label)
    .join(" · ");
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
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
      <span className="min-w-0 flex-1 basis-56">Forge can&apos;t reach this Discord server anymore — the bot may have been removed or lost access. Its feeds are paused until it&apos;s reconnected.</span>
      {action}
    </div>
  );
}

function PausedTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-4 px-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg-muted">
      <Pause className="size-3" /> Paused
    </span>
  );
}

/** Studio settings: the Discord servers connected to the studio (Admins and the Owner), each with its projects and feeds. */
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
  const servers = status.data?.servers ?? [];
  const canConnect = Boolean(status.data?.canConnect);
  const feeds = useQuery({ queryKey: discordKeys.studioFeeds(studioId), queryFn: () => rpc("discord.studioFeeds", { studioId }), enabled: servers.length > 0 && canConnect });
  const [disconnecting, setDisconnecting] = useState<DiscordServer | null>(null);
  const disconnect = useRpcMutation("discord.disconnect", {
    onSuccess: () => {
      toast.success(`${disconnecting?.guildName ?? "The server"} disconnected.`);
      setDisconnecting(null);
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: discordKeys.all });
    },
  });
  // The server just connected is the one connected most recently.
  const newest = servers.reduce<DiscordServer | null>((latest, s) => (!latest || s.connectedAt > latest.connectedAt ? s : latest), null);
  const feedsIn = (guildId: string) => (feeds.data ?? []).filter((f) => f.guildId === guildId);
  const leaving = disconnecting ? { feeds: feedsIn(disconnecting.guildId).length, projects: disconnecting.projects.length } : null;

  return (
    <section id="discord" className="scroll-mt-6 rounded-xl border border-border bg-surface-2 p-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        <MessagesSquare className="size-4 text-fg-muted" /> Discord
      </h2>
      <p className="mt-0.5 text-[12.5px] text-fg-muted">
        Post review and delivery updates to channels in your Discord servers. Messages say who did what and link back to Forge — comment and feedback text and files are never posted. Members who connect their own Discord account can also use Forge&apos;s commands there (/mywork, /reviews, /card, /due, /newcard, /additem): the replies are private, and anything they do uses their own Forge permissions.
      </p>
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("mt-3 rounded-lg border px-3 py-2 text-[12.5px]", notice.tone === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-state-approved/40 bg-state-approved/10")}>
          {notice.tone === "success" && newest
            ? `Connected to ${newest.guildName}. ${servers.length > 1 ? "Choose it as the Discord server in a project's settings to post there." : "Managers can now add feeds in each project's settings."}`
            : notice.text}
        </p>
      ) : null}
      <div className="mt-4 grid gap-4">
        {status.isLoading ? (
          <Skeleton className="h-12" />
        ) : !status.data ? (
          <p className="text-[12.5px] text-danger">Couldn&apos;t load the Discord connection.</p>
        ) : !status.data.configured ? (
          <p className="rounded-lg border border-border-strong px-3 py-2 text-[12.5px] text-fg-muted">Discord isn&apos;t set up on this Forge server. Whoever runs Forge needs to add the Discord app&apos;s credentials first.</p>
        ) : !servers.length ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 basis-64 text-[12.5px] text-fg-muted">
              You&apos;ll choose a server where you have <strong className="font-medium text-fg">Manage Server</strong>. Forge&apos;s bot only asks to view channels, send messages and embed links.
            </p>
            {canConnect ? (
              <Button asChild variant="primary">
                <a href={connectHref(studioId, studioSlug)}>Connect Discord</a>
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <ul className="grid gap-3" aria-label="Connected Discord servers">
              {servers.map((server) => (
                <li key={server.guildId} className="grid gap-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <ServerBadge name={server.guildName} />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate text-[13px] font-medium">{server.guildName}</p>
                      <p className="text-[11.5px] text-fg-subtle">
                        Connected{server.connectedBy ? ` by ${server.connectedBy}` : ""} · {formatShortDate(server.connectedAt)}
                      </p>
                    </div>
                    {canConnect ? (
                      <Button variant="ghost" size="sm" onClick={() => setDisconnecting(server)}>
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                  {server.lost ? (
                    <LostWarning
                      action={
                        canConnect ? (
                          <Button asChild size="xs" variant="secondary">
                            <a href={connectHref(studioId, studioSlug)}>Reconnect</a>
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : null}
                  {canConnect ? (
                    <div className="grid gap-2">
                      <p className="text-[12px]">
                        <span className="text-fg-muted">Projects posting here: </span>
                        {server.projects.length ? (
                          server.projects.map((p, i) => (
                            <span key={p.id}>
                              {i ? ", " : null}
                              <Link href={`/${studioSlug}/${p.slug}/settings#discord`} className="text-accent hover:underline">
                                {p.name}
                              </Link>
                              {p.archived ? <span className="text-fg-subtle"> (archived)</span> : null}
                            </span>
                          ))
                        ) : (
                          <span className="text-fg-subtle">none yet — choose this server in a project&apos;s settings.</span>
                        )}
                      </p>
                      {feeds.isLoading ? (
                        <Skeleton className="h-10" />
                      ) : feedsIn(server.guildId).length ? (
                        <ul className="divide-y divide-border rounded-lg border border-border" aria-label={`Feeds in ${server.guildName}`}>
                          {feedsIn(server.guildId).map((feed) => (
                            <li key={feed.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                              <div className="min-w-0 flex-1 basis-56">
                                {/* Wraps rather than truncating: on a phone the project and board are the point of the line. */}
                                <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px]">
                                  <span className="min-w-0 [overflow-wrap:anywhere]">
                                    <span className="font-medium">#{feed.channelName}</span>
                                    <span className="text-fg-muted">
                                      {" "}
                                      ← {feed.projectName} · {feed.boardName ?? "All boards"}
                                    </span>
                                  </span>
                                  {feed.paused ? <PausedTag /> : null}
                                </p>
                                <p className="text-[11.5px] text-fg-subtle">{feed.paused ? "The project posts to another server now." : eventList(feed.events)}</p>
                                {feed.lastError && !feed.paused ? <p className="text-[11.5px] text-danger">{feed.lastError}</p> : null}
                              </div>
                              <Link href={`/${studioSlug}/${feed.projectSlug}/settings#discord`} className="touch-target inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
                                Manage <ArrowRight className="size-3.5" />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[12px] text-fg-subtle">No feeds in this server yet. Managers add them in each project&apos;s settings.</p>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {canConnect ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-0 flex-1 basis-64 text-[12px] text-fg-muted">Each project posts to one server. Admins and the Owner choose it in the project&apos;s settings.</p>
                <Button asChild variant="secondary" size="sm">
                  <a href={connectHref(studioId, studioSlug)}>
                    <Plus /> Connect another server
                  </a>
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(disconnecting)}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.guildName ?? "this server"}?`}
        destructive
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onConfirm={() => disconnecting && disconnect.mutate({ studioId, guildId: disconnecting.guildId })}
        description={
          leaving
            ? `${leaving.feeds ? `Its ${plural(leaving.feeds, "feed")} ${leaving.feeds === 1 ? "is" : "are"} removed. ` : ""}${leaving.projects ? `${plural(leaving.projects, "project")} posting here won't have a Discord server until an Admin chooses another. ` : ""}Forge's bot leaves ${disconnecting?.guildName ?? "the server"} unless another studio still uses it. Messages already posted stay in Discord.`
            : undefined
        }
      />
    </section>
  );
}

/** Project settings: the project's Discord server (Admins and the Owner choose it) and which of its channels get this project's events (Managers and above). */
export function ProjectDiscordFeeds({ board, status, studioSlug, canManage }: { board: BoardDTO; status: DiscordStatus; studioSlug: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const projectId = board.project.id;
  const servers = status.servers;
  const project = useQuery({ queryKey: discordKeys.project(projectId), queryFn: () => rpc("discord.project", { projectId }), enabled: servers.length > 0 });
  const server = project.data?.server ?? null;
  const feeds = project.data?.feeds ?? [];
  const active = feeds.filter((f) => !f.paused);
  const paused = feeds.filter((f) => f.paused);
  const [editing, setEditing] = useState<DiscordFeed | "new" | null>(null);
  const [removing, setRemoving] = useState<DiscordFeed | null>(null);
  const [switching, setSwitching] = useState<{ guildId: string | null } | null>(null);
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
      const feed = feeds.find((f) => f.id === feedId);
      if (result.ok) toast.success(`Test message posted in #${feed?.channelName ?? "the channel"}.`);
      else toast.error(result.error ?? "Couldn't post the test message.");
      refresh();
    },
  });
  const choose = useRpcMutation("discord.setProjectServer", {
    onSuccess: (next) => {
      setSwitching(null);
      queryClient.setQueryData(discordKeys.project(projectId), next);
      refresh();
      const resumed = next.feeds.filter((f) => !f.paused).length;
      toast.success(next.server ? `${board.project.name} now posts to ${next.server.guildName}.${resumed ? ` ${plural(resumed, "feed")} ${resumed === 1 ? "posts" : "post"} there.` : ""}` : `${board.project.name} no longer posts to Discord.`);
    },
  });

  const canChoose = Boolean(project.data?.canChooseServer) && canManage;
  const nameOf = (guildId: string | null) => servers.find((s) => s.guildId === guildId)?.guildName ?? null;
  const pick = (value: string) => {
    const guildId = value === NO_SERVER ? null : value;
    if (guildId === (server?.guildId ?? null)) return;
    // Feeds that post now would pause: say which before switching.
    if (active.length) setSwitching({ guildId });
    else choose.mutate({ projectId, guildId });
  };
  const switchingTo = switching ? nameOf(switching.guildId) : null;
  const resuming = switching ? paused.filter((f) => f.guildId === switching.guildId).length : 0;

  return (
    <section id="discord" className="scroll-mt-6 rounded-xl border border-border bg-surface-2 p-5">
      <h2 className="text-[15px] font-semibold">Discord feeds</h2>
      <p className="mt-0.5 text-[12.5px] text-fg-muted">Post this project&apos;s reviews, completions and deadlines to Discord channels. Messages say who did what and link back to Forge; comment and feedback text and files are never posted.</p>
      <div className="mt-4 grid gap-3">
        {!servers.length ? (
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
        ) : project.isLoading ? (
          <Skeleton className="h-12" />
        ) : !project.data ? (
          <p className="text-[12.5px] text-danger">Couldn&apos;t load this project&apos;s Discord feeds.</p>
        ) : (
          <>
            <div className="grid gap-1.5">
              <Label>Discord server</Label>
              {canChoose ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="Discord server"
                    className="w-auto min-w-48 max-w-full"
                    value={server?.guildId ?? NO_SERVER}
                    onValueChange={pick}
                    disabled={choose.isPending}
                    options={[
                      ...servers.map((s) => ({ value: s.guildId, label: s.lost ? `${s.guildName} (can't reach)` : s.guildName, disabled: s.lost && s.guildId !== server?.guildId })),
                      { value: NO_SERVER, label: "No server" },
                    ]}
                  />
                  <span className="text-[11.5px] text-fg-subtle">All of this project&apos;s feeds post to this server.</span>
                </div>
              ) : server ? (
                <p className="flex items-center gap-2 text-[12.5px] text-fg-muted">
                  <ServerBadge name={server.guildName} />
                  <span>
                    Posting to <strong className="font-medium text-fg">{server.guildName}</strong>
                  </span>
                </p>
              ) : (
                <p className="text-[12.5px] text-fg-muted">No Discord server chosen yet. A studio Admin or the Owner can choose one here.</p>
              )}
            </div>
            {server?.lost ? <LostWarning /> : null}
            {board.project.archived ? <p className="text-[12.5px] text-fg-muted">This project is archived, so its feeds are paused.</p> : null}
            {active.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Feeds">
                {active.map((feed) => (
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
                        <Button size="xs" variant="ghost" loading={test.isPending && test.variables?.feedId === feed.id} disabled={server?.lost} onClick={() => test.mutate({ feedId: feed.id })}>
                          <Send /> Send test
                        </Button>
                        <Button size="icon-xs" variant="ghost" className="touch-target" aria-label={`Edit the #${feed.channelName} feed`} onClick={() => setEditing(feed)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-xs" variant="ghost" className="touch-target" aria-label={`Remove the #${feed.channelName} feed`} onClick={() => setRemoving(feed)}>
                          <Trash2 />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : server ? (
              <p className="text-[12.5px] text-fg-muted">No feeds yet. Add one to post this project&apos;s events to a channel.</p>
            ) : null}
            {canManage && server ? (
              <div>
                <Button variant="secondary" size="sm" disabled={server.lost} onClick={() => setEditing("new")}>
                  <Plus /> Add feed
                </Button>
              </div>
            ) : null}
            {paused.length ? (
              <div className="grid gap-1.5">
                <p className="text-[12.5px] font-medium">Paused feeds</p>
                <p className="text-[11.5px] text-fg-subtle">
                  These are in other servers. They post again if the project switches back{server ? `, or edit one to move it to ${server.guildName}` : ""}.
                </p>
                <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Paused feeds">
                  {paused.map((feed) => (
                    <li key={feed.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
                      <div className="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
                        <Hash className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                        <div className="min-w-0 flex-1">
                          <p className="flex min-w-0 items-center gap-1.5 text-[13px]">
                            <span className="truncate">
                              <span className="font-medium text-fg-muted">{feed.channelName}</span>
                              <span className="text-fg-subtle"> · {feed.boardName ?? "All boards"}</span>
                            </span>
                            <PausedTag />
                          </p>
                          <p className="text-[11.5px] text-fg-subtle">in {feed.guildName ?? "a server that isn't connected anymore"}</p>
                        </div>
                      </div>
                      {canManage ? (
                        <div className="flex items-center gap-1">
                          {server && !server.lost ? (
                            <Button size="icon-xs" variant="ghost" className="touch-target" aria-label={`Move the #${feed.channelName} feed to ${server.guildName}`} onClick={() => setEditing(feed)}>
                              <Pencil />
                            </Button>
                          ) : null}
                          <Button size="icon-xs" variant="ghost" className="touch-target" aria-label={`Remove the #${feed.channelName} feed`} onClick={() => setRemoving(feed)}>
                            <Trash2 />
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent
          title={editing === "new" ? "Add Discord feed" : editing?.paused ? "Move Discord feed" : "Edit Discord feed"}
          description={
            editing !== "new" && editing?.paused && server
              ? `It was in #${editing.channelName} (${editing.guildName ?? "another server"}). Choose a channel in ${server.guildName} and it starts posting again.`
              : `Choose a channel${server ? ` in ${server.guildName}` : ""} and what Forge posts there.`
          }
        >
          {editing ? <FeedForm board={board} feed={editing === "new" ? null : editing} existing={feeds} onDone={() => setEditing(null)} /> : null}
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
        description={removing?.paused ? "It's paused, so nothing changes in Discord; it just won't come back if the project switches servers." : "Forge stops posting this project's events there. Messages already posted stay in Discord."}
      />
      <ConfirmDialog
        open={Boolean(switching)}
        onOpenChange={(open) => !open && setSwitching(null)}
        title={switchingTo ? `Post to ${switchingTo} instead?` : "Stop posting to Discord?"}
        confirmLabel={switchingTo ? "Switch server" : "Remove server"}
        loading={choose.isPending}
        onConfirm={() => switching && choose.mutate({ projectId, guildId: switching.guildId })}
        description={`${plural(active.length, "feed")} in ${server?.guildName ?? "the current server"} ${active.length === 1 ? "pauses" : "pause"} until the project switches back: ${active.map((f) => `#${f.channelName}`).join(", ")}.${resuming ? ` ${plural(resuming, "paused feed")} in ${switchingTo} ${resuming === 1 ? "starts" : "start"} posting again.` : ""}`}
      />
    </section>
  );
}

function FeedForm({ board, feed, existing, onDone }: { board: BoardDTO; feed: DiscordFeed | null; existing: DiscordFeed[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const projectId = board.project.id;
  const channels = useQuery({ queryKey: discordKeys.channels(projectId), queryFn: () => rpc("discord.channels", { projectId }), staleTime: 30_000, retry: false });
  // A paused feed's channel is in another server: moving it starts from an empty choice.
  const current = feed && !feed.paused ? feed : null;
  const [boardId, setBoardId] = useState<string>(feed?.boardId ?? ALL_BOARDS);
  const [channelId, setChannelId] = useState<string | undefined>(current?.channelId);
  const [events, setEvents] = useState<DiscordEventType[]>(feed?.events ?? DEFAULT_DISCORD_EVENTS);
  const [confirmed, setConfirmed] = useState(false);
  const save = useRpcMutation("discord.saveFeed", {
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: discordKeys.all });
      toast.success(feed ? (feed.paused ? `Feed moved to #${saved.channelName}.` : "Feed updated.") : `Feed added. Use Send test to check Forge can post in #${saved.channelName}.`);
      onDone();
    },
  });

  const channelList = channels.data ?? [];
  const channel = channelList.find((c) => c.id === channelId);
  const channelOptions = channelList.map((c) => ({ value: c.id, label: c.category ? `#${c.name} · ${c.category}` : `#${c.name}` }));
  if (current && channels.data && !channel) channelOptions.unshift({ value: current.channelId, label: `#${current.channelName} (not found)` });
  const boardOptions = [{ value: ALL_BOARDS, label: "All boards" }, ...board.boards.map((b) => ({ value: b.id, label: b.name }))];
  if (feed?.boardId && !board.boards.some((b) => b.id === feed.boardId)) boardOptions.push({ value: feed.boardId, label: `${feed.boardName ?? "Board"} (archived)` });
  const channelName = channel?.name ?? (channelId === current?.channelId ? current?.channelName : undefined);
  const isPrivate = board.project.visibility === "PRIVATE";
  const needsConfirmation = isPrivate && !(current?.privateConfirmed && current.channelId === channelId);
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
          {feed ? (feed.paused ? "Move feed" : "Save feed") : "Add feed"}
        </Button>
      </DialogFooter>
    </form>
  );
}
