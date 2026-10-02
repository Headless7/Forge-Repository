"use client";

import { Maximize, Minimize, Pause, Play, StepBack, StepForward, Volume2, VolumeX, MapPin } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn, formatTimecode } from "@/lib/utils";
import { PortalContainer, Select } from "../ui/controls";
import { keyBelongsToControl } from "../ui/keys";
import { Tooltip } from "../ui/menu";

export interface VideoMarker {
  id: string;
  timestampMs: number;
  author: string;
  text: string;
  resolved: boolean;
  x?: number | null;
  y?: number | null;
}

export interface VideoPlayerHandle {
  seek: (ms: number) => void;
  play: () => void;
  pause: () => void;
  currentTimeMs: () => number;
  element: () => HTMLVideoElement | null;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

interface Props {
  src: string;
  poster?: string | null;
  fps?: number | null;
  durationMs?: number | null;
  markers?: VideoMarker[];
  activeMarkerId?: string | null;
  onMarkerClick?: (id: string) => void;
  /** Point on the paused frame for the feedback being composed. */
  pendingPoint?: { x: number; y: number } | null;
  onPlacePoint?: (x: number, y: number, timeMs: number) => void;
  onTimeChange?: (ms: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  className?: string;
  label?: string;
}

/**
 * Review player: frame-accurate stepping, speed, volume, fullscreen and a
 * timeline that shows exactly where feedback was left. Comments near the
 * playhead are overlaid on the video itself.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { src, poster, fps, durationMs, markers = [], activeMarkerId, onMarkerClick, pendingPoint, onPlacePoint, onTimeChange, onPlayingChange, className, label = "Video" },
  ref,
) {
  const shell = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [intrinsic, setIntrinsic] = useState({ w: 0, h: 0 });
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState((durationMs ?? 0) / 1000);
  const [playing, setPlaying] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrubbing = useRef(false);
  const frame = 1 / (fps && fps > 1 ? fps : 30);

  const seekTo = useCallback((seconds: number) => {
    const v = video.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : duration;
    v.currentTime = Math.max(0, Math.min(d || seconds, seconds));
    setTime(v.currentTime);
  }, [duration]);

  useImperativeHandle(
    ref,
    () => ({
      seek: (ms) => seekTo(ms / 1000),
      play: () => void video.current?.play().catch(() => {}),
      pause: () => video.current?.pause(),
      currentTimeMs: () => Math.round((video.current?.currentTime ?? 0) * 1000),
      element: () => video.current,
    }),
    [seekTo],
  );

  // Smooth time display while playing (timeupdate only fires ~4×/s).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v && !scrubbing.current) setTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    onTimeChange?.(Math.round(time * 1000));
  }, [time, onTimeChange]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setStageSize({ w: entry!.contentRect.width, h: entry!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The visible frame inside the letterboxed <video>; pins are positioned relative to it.
  const box = (() => {
    if (!intrinsic.w || !intrinsic.h || !stageSize.w) return null;
    const scale = Math.min(stageSize.w / intrinsic.w, stageSize.h / intrinsic.h);
    const width = intrinsic.w * scale;
    const height = intrinsic.h * scale;
    return { left: (stageSize.w - width) / 2, top: (stageSize.h - height) / 2, width, height };
  })();

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    setError(null);
    setPlaying(false);
    setTime(0);
  }, [src]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const step = (frames: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    seekTo(v.currentTime + frames * frame);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.();
  };

  const timeFromPointer = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * (duration || 0);
  };

  const onTrackDown = (e: ReactPointerEvent) => {
    scrubbing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    seekTo(timeFromPointer(e.clientX));
  };
  const onTrackMove = (e: ReactPointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    setHover({ x: e.clientX - rect.left, t: timeFromPointer(e.clientX) });
    if (scrubbing.current) seekTo(timeFromPointer(e.clientX));
  };
  const onTrackUp = () => {
    scrubbing.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (keyBelongsToControl(e)) return;
    const key = e.key.toLowerCase();
    const v = video.current;
    if (!v) return;
    if (key === " " || key === "k") togglePlay();
    else if (key === "j") seekTo(v.currentTime - 1);
    else if (key === "l") seekTo(v.currentTime + 1);
    else if (key === "arrowleft") (v.paused ? step(-1) : seekTo(v.currentTime - 1));
    else if (key === "arrowright") (v.paused ? step(1) : seekTo(v.currentTime + 1));
    else if (key === ",") step(-1);
    else if (key === ".") step(1);
    else if (key === "m") setMuted((m) => !m);
    else if (key === "f") toggleFullscreen();
    else if (key === "home") seekTo(0);
    else if (key === "end") seekTo(duration);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    if (video.current) {
      video.current.volume = volume;
      video.current.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed]);

  const nowMs = time * 1000;
  const visible = markers.filter((m) => Math.abs(m.timestampMs - nowMs) <= 1200).slice(0, 3);
  const pins = markers.filter((m) => m.x != null && m.y != null && Math.abs(m.timestampMs - nowMs) <= (playing ? 250 : 450));
  const pct = (t: number) => (duration ? `${Math.min(100, (t / duration) * 100)}%` : "0%");

  return (
    // While fullscreen, the speed menu and tooltips must render inside the fullscreen element.
    <PortalContainer.Provider value={fullscreen ? shell.current : null}>
      <div
        ref={shell}
        tabIndex={0}
        role="region"
        aria-label={`${label} player. Space to play or pause, arrow keys to step.`}
        onKeyDown={onKeyDown}
        className={cn("group/player relative flex h-full w-full select-none flex-col bg-black outline-none", className)}
      >
        <div ref={stage} className="relative min-h-0 flex-1">
          <video
            ref={video}
            src={src}
            poster={poster ?? undefined}
            preload="metadata"
            playsInline
            onClick={(e) => {
              if (pinMode && onPlacePoint && box) {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = (e.clientX - rect.left - box.left) / box.width;
                const y = (e.clientY - rect.top - box.top) / box.height;
                if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
                  e.currentTarget.pause();
                  onPlacePoint(Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000, Math.round(e.currentTarget.currentTime * 1000));
                  setPinMode(false);
                }
                return;
              }
              togglePlay();
            }}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration || (durationMs ?? 0) / 1000);
              setIntrinsic({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
            }}
            onPlay={() => {
              setPlaying(true);
              onPlayingChange?.(true);
            }}
            onPause={(e) => {
              setPlaying(false);
              setTime(e.currentTarget.currentTime);
              onPlayingChange?.(false);
            }}
            onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            onProgress={(e) => {
              const v = e.currentTarget;
              if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
            }}
            onError={() => setError("This video can't be played in your browser yet. If it was just uploaded, a playable version is being prepared.")}
            className={cn("absolute inset-0 h-full w-full object-contain", pinMode && "cursor-crosshair")}
          />

          {/* Feedback near the playhead, shown on the video itself */}
          {visible.length ? (
            <div className="pointer-events-none absolute left-3 top-3 z-10 grid max-w-[min(420px,70%)] gap-1.5">
              {visible.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onMarkerClick?.(m.id)}
                  className={cn(
                    "pointer-events-auto rounded-lg border px-2.5 py-1.5 text-left text-[12px] leading-snug text-white shadow-lg backdrop-blur animate-fade-in",
                    m.resolved ? "border-white/15 bg-black/55" : "border-state-changes/60 bg-black/70",
                    m.id === activeMarkerId && "ring-2 ring-white/70",
                  )}
                >
                  <span className="mr-1.5 font-mono text-[10.5px] text-white/70">{formatTimecode(m.timestampMs)}</span>
                  <span className="font-semibold">{m.author}:</span> <span className="line-clamp-2">{m.text}</span>
                </button>
              ))}
            </div>
          ) : null}

          {box ? (
            <div className="pointer-events-none absolute z-10" style={box}>
              {pins.map((m) => (
                <span
                  key={m.id}
                  className={cn("absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-lg", m.resolved ? "bg-state-approved/85" : "bg-state-changes")}
                  style={{ left: `${m.x! * 100}%`, top: `${m.y! * 100}%` }}
                />
              ))}
              {pendingPoint ? (
                <span
                  className="absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow-lg animate-pulse-ring"
                  style={{ left: `${pendingPoint.x * 100}%`, top: `${pendingPoint.y * 100}%` }}
                />
              ) : null}
            </div>
          ) : null}

          {!playing && !error ? (
            <button
              type="button"
              aria-label="Play"
              onClick={togglePlay}
              className="absolute left-1/2 top-1/2 z-10 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition-opacity group-hover/player:opacity-100 group-focus-within/player:opacity-100"
            >
              <Play className="ml-1 size-6 fill-current" />
            </button>
          ) : null}
          {error ? <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-lg bg-black/75 p-4 text-center text-[13px] text-white">{error}</div> : null}
        </div>

        {/* Controls */}
        <div className="shrink-0 bg-gradient-to-t from-black via-black/95 to-black/80 px-3 pb-2 pt-1.5 text-white">
          <div
            ref={track}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration * 1000)}
            aria-valuenow={Math.round(time * 1000)}
            aria-valuetext={formatTimecode(time * 1000)}
            tabIndex={-1}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onPointerUp={onTrackUp}
            onPointerLeave={() => setHover(null)}
            className="relative h-5 cursor-pointer touch-none"
          >
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15">
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/25" style={{ width: pct(buffered) }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: pct(time) }} />
            </div>
            {markers.map((m) => (
              <Tooltip key={m.id} content={`${formatTimecode(m.timestampMs)} · ${m.author}: ${m.text}`}>
                <button
                  type="button"
                  aria-label={`Feedback at ${formatTimecode(m.timestampMs)}: ${m.text}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    seekTo(m.timestampMs / 1000);
                    video.current?.pause();
                    onMarkerClick?.(m.id);
                  }}
                  className={cn(
                    "absolute top-1/2 z-10 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/40 transition-transform hover:scale-y-125",
                    m.resolved ? "bg-state-approved" : "bg-state-changes",
                    m.id === activeMarkerId && "h-4 w-2 ring-2 ring-white",
                  )}
                  style={{ left: pct(m.timestampMs / 1000) }}
                />
              </Tooltip>
            ))}
            <div className="pointer-events-none absolute top-1/2 z-20 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: pct(time) }} />
            {hover ? (
              <span className="pointer-events-none absolute -top-6 z-20 -translate-x-1/2 rounded bg-black/85 px-1.5 font-mono text-[10.5px]" style={{ left: hover.x }}>
                {formatTimecode(hover.t * 1000)}
              </span>
            ) : null}
          </div>

          <div className="mt-0.5 flex items-center gap-1 text-[12px]">
            <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} className="flex size-8 items-center justify-center rounded hover:bg-white/15">
              {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
            </button>
            <Tooltip content="Previous frame" shortcut=",">
              <button type="button" aria-label="Previous frame" onClick={() => step(-1)} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
                <StepBack className="size-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="Next frame" shortcut=".">
              <button type="button" aria-label="Next frame" onClick={() => step(1)} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
                <StepForward className="size-3.5" />
              </button>
            </Tooltip>
            <span className="ml-1 whitespace-nowrap font-mono tabular-nums">
              {formatTimecode(time * 1000)} <span className="hidden text-white/50 sm:inline">/ {formatTimecode(duration * 1000)}</span>
            </span>
            <span className="ml-2 hidden font-mono text-[11px] text-white/50 tabular-nums sm:inline">F {Math.floor(time / frame)}</span>
            <span className="flex-1" />
            {onPlacePoint ? (
              <Tooltip content={pinMode ? "Click the frame to place a pin" : "Pin a spot on the paused frame"}>
                <button
                  type="button"
                  aria-pressed={pinMode}
                  aria-label="Pin a spot on the frame"
                  onClick={() => {
                    video.current?.pause();
                    setPinMode((p) => !p);
                  }}
                  className={cn("flex h-7 items-center gap-1 rounded px-2 hover:bg-white/15", pinMode && "bg-accent text-white hover:bg-accent")}
                >
                  <MapPin className="size-3.5" /> <span className="hidden md:inline">Pin</span>
                </button>
              </Tooltip>
            ) : null}
            <Select variant="media" aria-label="Playback speed" value={String(speed)} onValueChange={(v) => setSpeed(Number(v))} className="border-transparent bg-transparent" options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))} />
            <button type="button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted((m) => !m)} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
              {muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(Number(e.target.value) === 0);
              }}
              className="hidden w-16 accent-white md:block"
            />
            <button type="button" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
              {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </PortalContainer.Provider>
  );
});
