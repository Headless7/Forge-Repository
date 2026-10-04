"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Rss } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import { timeAgo } from "@/lib/utils";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { useTipOnOpen } from "../tutorial/tutorial";
import { Skeleton } from "../ui/controls";
import { Input } from "../ui/input";

// Dates in the viewer's time zone and locale: rendered in the browser only.
const StudioCalendar = dynamic(() => import("./calendar").then((m) => m.StudioCalendar), { ssr: false, loading: () => <Skeleton className="m-3 h-48" /> });

/** The private calendar link (ICS) for Google, Apple or Outlook calendars. */
function SubscribeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const feed = useQuery({ queryKey: ["calendar-feed"], queryFn: () => rpc("calendarFeed.get", {}), enabled: open });
  const [url, setUrl] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const refresh = (data: { active: boolean; createdAt: string | null; lastUsedAt: string | null }) => queryClient.setQueryData(["calendar-feed"], data);
  const create = useRpcMutation("calendarFeed.create", {
    onSuccess: (result) => {
      setUrl(result.url);
      refresh(result);
    },
  });
  const revoke = useRpcMutation("calendarFeed.revoke", {
    onSuccess: (data) => {
      setUrl(null);
      setRevoking(false);
      refresh(data);
      toast.success("Calendar link turned off. Calendars using it stop updating.");
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setUrl(null);
      }}
    >
      <DialogContent title="Subscribe in your calendar app" description="Your deadlines and milestones in Google Calendar, Apple Calendar or Outlook, kept up to date automatically.">
        <div className="grid gap-3 text-[13px]">
          {url ? (
            <>
              <p className="text-fg-muted">Copy this link now — for your security it won&apos;t be shown again. Anyone with it can see your deadlines, so don&apos;t share it.</p>
              <div className="flex gap-2">
                <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" aria-label="Calendar link" />
                <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success("Link copied"))}>
                  <Copy /> Copy
                </Button>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-fg-muted">
                <li>Google Calendar: Other calendars → + → From URL.</li>
                <li>Apple Calendar: File → New Calendar Subscription.</li>
                <li>Outlook: Add calendar → Subscribe from web.</li>
              </ul>
              <p className="text-[12px] text-fg-subtle">Calendar apps refresh on their own schedule (Google can take several hours).</p>
            </>
          ) : feed.data?.active ? (
            <p className="text-fg-muted">
              You have a calendar link (created {timeAgo(feed.data.createdAt!)}
              {feed.data.lastUsedAt ? `, last fetched ${timeAgo(feed.data.lastUsedAt)}` : ", not used yet"}). Make a new one if you lost it — the old link stops working.
            </p>
          ) : (
            <p className="text-fg-muted">Get a private link with your deadlines (cards you&apos;re assigned to, deliverables you work on or review) and your projects&apos; milestones, from a month ago to a year ahead.</p>
          )}
        </div>
        <DialogFooter>
          {feed.data?.active ? (
            <Button variant="danger-ghost" onClick={() => setRevoking(true)}>
              Turn off link
            </Button>
          ) : null}
          <span className="flex-1" />
          {!url ? (
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate({})}>
              <Rss /> {feed.data?.active ? "Make a new link" : "Create my calendar link"}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
        <ConfirmDialog
          open={revoking}
          onOpenChange={setRevoking}
          title="Turn off your calendar link?"
          description="Calendars subscribed to it will stop updating. You can make a new link any time."
          confirmLabel="Turn off"
          destructive
          loading={revoke.isPending}
          onConfirm={() => revoke.mutate({})}
        />
      </DialogContent>
    </Dialog>
  );
}

export function MyCalendarPage() {
  const { studio, user } = useShell();
  const router = useRouter();
  const [subscribing, setSubscribing] = useState(false);
  // Opening My calendar is opening the feature.
  useTipOnOpen("schedule.dates");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5">
        <h1 className="text-[15px] font-semibold tracking-tight">My calendar</h1>
        <span className="text-[12.5px] text-fg-muted">Deadlines and milestones across {studio.name}</span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={() => setSubscribing(true)}>
          <Rss /> Subscribe
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <StudioCalendar
          studioId={studio.id}
          viewerId={user.id}
          onOpenCard={(t) => router.push(`/${t.studioSlug}/${t.projectSlug}/b/${t.boardNumber}?card=${encodeURIComponent(t.key)}${t.deliverableNumber ? `&d=${t.deliverableNumber}` : ""}`)}
        />
      </div>
      <SubscribeDialog open={subscribing} onOpenChange={setSubscribing} />
    </div>
  );
}
