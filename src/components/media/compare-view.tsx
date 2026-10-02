"use client";

import { Link2, Link2Off } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { VERSION_STATUS_META } from "@/lib/card-meta";
import type { AttachmentDTO, VersionDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatePill } from "../domain/state";
import { Select } from "../ui/controls";
import { Tooltip } from "../ui/menu";
import { ImageViewer } from "./image-viewer";
import { VideoPlayer, type VideoPlayerHandle } from "./video-player";

function primaryMedia(version: VersionDTO | undefined, attachments: AttachmentDTO[]): AttachmentDTO | undefined {
  if (!version) return undefined;
  return attachments.find((a) => version.attachmentIds.includes(a.id) && a.kind !== "FILE" && a.url);
}

/**
 * Side-by-side version comparison. Video panes can be linked so play/pause/seek
 * mirror across both; the linking goes through the players' imperative handles,
 * which is where frame-accurate sync would hook in.
 */
export function CompareView({ versions, attachments, initialLeftId, initialRightId }: { versions: VersionDTO[]; attachments: AttachmentDTO[]; initialLeftId: string; initialRightId: string }) {
  const [leftId, setLeftId] = useState(initialLeftId);
  const [rightId, setRightId] = useState(initialRightId);
  const [linked, setLinked] = useState(true);
  const leftPlayer = useRef<VideoPlayerHandle>(null);
  const rightPlayer = useRef<VideoPlayerHandle>(null);
  const left = primaryMedia(versions.find((v) => v.id === leftId), attachments);
  const right = primaryMedia(versions.find((v) => v.id === rightId), attachments);
  const bothVideo = left?.kind === "VIDEO" && right?.kind === "VIDEO";

  useEffect(() => {
    if (!linked || !bothVideo) return;
    const a = leftPlayer.current?.element();
    const b = rightPlayer.current?.element();
    if (!a || !b) return;
    let syncing = false;
    const mirror = (from: HTMLVideoElement, to: HTMLVideoElement) => {
      const handlers = {
        play: () => void to.play().catch(() => {}),
        pause: () => to.pause(),
        seeked: () => {
          if (syncing) return;
          syncing = true;
          to.currentTime = from.currentTime;
          setTimeout(() => (syncing = false), 50);
        },
        ratechange: () => (to.playbackRate = from.playbackRate),
      };
      for (const [event, fn] of Object.entries(handlers)) from.addEventListener(event, fn);
      return () => {
        for (const [event, fn] of Object.entries(handlers)) from.removeEventListener(event, fn);
      };
    };
    const offA = mirror(a, b);
    const offB = mirror(b, a);
    return () => {
      offA();
      offB();
    };
  }, [linked, bothVideo, left?.id, right?.id]);

  const options = versions.map((v) => ({
    value: v.id,
    label: `V${v.number} · ${VERSION_STATUS_META[v.status].label}`,
  }));

  const pane = (media: AttachmentDTO | undefined, which: "left" | "right") => {
    if (!media?.url) return <div className="flex h-full items-center justify-center text-[13px] text-white/60">No media in this version</div>;
    if (media.kind === "VIDEO") {
      return <VideoPlayer ref={which === "left" ? leftPlayer : rightPlayer} src={media.url} poster={media.thumbUrl} fps={media.fps} durationMs={media.durationMs} label={`Version ${which}`} />;
    }
    return <ImageViewer src={media.url} alt={media.filename} naturalWidth={media.width} naturalHeight={media.height} markers={[]} />;
  };

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center gap-2 border-b border-white/10 bg-black px-2 py-1.5">
        <div className="grid flex-1 grid-cols-2 gap-2">
          {[
            [leftId, setLeftId],
            [rightId, setRightId],
          ].map(([value, set], i) => {
            const version = versions.find((v) => v.id === value);
            return (
              <div key={i} className="flex items-center gap-2">
                <Select aria-label={i === 0 ? "Left version" : "Right version"} value={value as string} onValueChange={set as (v: string) => void} options={options} className="h-7 max-w-52 border-white/15 bg-white/5 text-white" />
                {version ? <StatePill state={VERSION_STATUS_META[version.status].state} size="sm" className="hidden lg:inline-flex" /> : null}
              </div>
            );
          })}
        </div>
        {bothVideo ? (
          <Tooltip content={linked ? "Playback linked — both videos play and seek together" : "Link playback"}>
            <button
              type="button"
              onClick={() => setLinked((l) => !l)}
              aria-pressed={linked}
              className={cn("flex h-7 items-center gap-1.5 rounded px-2 text-[12px] text-white/80 hover:bg-white/10", linked && "bg-accent/30 text-white")}
            >
              {linked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />} Sync
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-white/10 md:grid-cols-2">
        <div className="min-h-[200px] bg-black">{pane(left, "left")}</div>
        <div className="min-h-[200px] bg-black">{pane(right, "right")}</div>
      </div>
    </div>
  );
}
