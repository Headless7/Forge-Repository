"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { DiscordVideoLink } from "@/lib/discord-links";
import { formatDateTime } from "@/lib/utils";
import { DiscordIcon } from "../domain/discord-icon";

/**
 * A video someone linked from Discord, playable right here instead of opening Discord. The
 * link only works until Discord's signature expires, so an expired or broken one explains
 * itself instead of showing a dead player.
 */
export function DiscordVideo({ link }: { link: DiscordVideoLink }) {
  const [failed, setFailed] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const expired = mounted && link.expiresAt !== null && Date.now() > link.expiresAt;

  if (expired || failed) {
    return (
      <div className="my-1 flex items-start gap-2 rounded-md border border-border bg-surface-3/40 px-2.5 py-2 text-[12.5px] text-fg-muted">
        <DiscordIcon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block font-medium text-fg">{expired ? "This Discord video link has expired" : "This Discord video couldn't be loaded"}</span>
          {expired && link.expiresAt !== null ? `Discord links stop working after about a day (this one on ${formatDateTime(new Date(link.expiresAt))}). ` : "It may have expired or been deleted. "}
          Open the video in Discord, copy its link again and paste the new one.
        </span>
      </div>
    );
  }
  return (
    <figure className="my-1 max-w-[560px] overflow-hidden rounded-md border border-border bg-black">
      {/* The clip streams straight from Discord: nothing is stored here, which is the point of linking it. */}
      <video src={link.url} controls playsInline preload="metadata" className="max-h-[360px] w-full bg-black" aria-label={`Discord video ${link.filename}`} onError={() => setFailed(true)} />
      <figcaption className="flex items-center gap-1.5 bg-surface-2 px-2 py-1 text-[11.5px] text-fg-subtle">
        <DiscordIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={link.filename}>
          {link.filename}
        </span>
        {mounted && link.expiresAt !== null ? <span className="hidden sm:inline">Link works until {formatDateTime(new Date(link.expiresAt))}</span> : null}
        <a href={link.url} target="_blank" rel="noopener noreferrer nofollow" className="touch-target inline-flex items-center gap-1 text-fg-muted hover:text-fg" aria-label="Open in Discord">
          <ExternalLink className="size-3.5" />
        </a>
      </figcaption>
    </figure>
  );
}
