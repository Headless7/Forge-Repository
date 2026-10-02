"use client";

import { Download, Pause, Play, Repeat, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn, formatTimecode } from "@/lib/utils";
import type { TimelineHandle } from "../card/workspace-context";
import { Select } from "../ui/controls";
import { keyBelongsToControl } from "../ui/keys";
import { Tooltip } from "../ui/menu";

export interface AudioMarker {
  id: string;
  timestampMs: number;
  author: string;
  text: string;
  resolved: boolean;
}

export interface AudioPlayerProps {
  /** The original upload. */
  src: string;
  mimeType: string;
  /** Browser-compatibility copy (AAC), used only when the original can't play here. */
  fallbackSrc?: string | null;
  peaksUrl?: string | null;
  waveformState?: "ready" | "processing" | "failed";
  durationMs?: number | null;
  markers?: AudioMarker[];
  activeMarkerId?: string | null;
  onMarkerClick?: (id: string) => void;
  onPlayingChange?: (playing: boolean) => void;
  onTimeChange?: (ms: number) => void;
  downloadUrl?: string | null;
  label: string;
  meta?: Record<string, unknown> | null;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

function usePeaks(url: string | null | undefined) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setError(false);
    fetch(url, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { peaks?: number[] }) => setPeaks(Array.isArray(data.peaks) ? data.peaks : null))
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(true);
      });
    return () => controller.abort();
  }, [url]);
  return { peaks, error };
}

/** Waveform drawn on a canvas; the played part uses the accent colour. */
function Waveform({ peaks, progress, markers, activeMarkerId, durationMs, onSeek, onMarkerClick }: {
  peaks: number[] | null;
  progress: number;
  markers: AudioMarker[];
  activeMarkerId?: string | null;
  durationMs: number;
  onSeek: (fraction: number) => void;
  onMarkerClick?: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const height = 96;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(c);
    const played = styles.getPropertyValue("--accent").trim() || "#7c6cf2";
    const rest = styles.getPropertyValue("--fg-subtle").trim() || "#6c7280";
    const bar = 3;
    const gap = 1;
    const count = Math.max(1, Math.floor(width / (bar + gap)));
    const loudest = peaks?.length ? Math.max(0.05, ...peaks) : 1;
    for (let i = 0; i < count; i++) {
      let amp = 0.04;
      if (peaks?.length) {
        const from = Math.floor((i / count) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((i + 1) / count) * peaks.length));
        for (let j = from; j < to; j++) amp = Math.max(amp, (peaks[j] ?? 0) / loudest);
      }
      const h = Math.max(2, amp * (height - 8));
      ctx.fillStyle = i / count <= progress ? played : rest;
      ctx.globalAlpha = i / count <= progress ? 1 : 0.55;
      ctx.fillRect(i * (bar + gap), (height - h) / 2, bar, h);
    }
    ctx.globalAlpha = 1;
  }, [peaks, progress, width]);

  const fractionAt = (e: PointerEvent) => {
    const rect = wrap.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  return (
    <div
      ref={wrap}
      className="relative h-24 w-full cursor-pointer select-none"
      onPointerDown={(e) => onSeek(fractionAt(e))}
      onPointerMove={(e) => setHover(fractionAt(e))}
      onPointerLeave={() => setHover(null)}
    >
      <canvas ref={canvas} aria-hidden className="h-full w-full" style={{ width: "100%", height: 96 }} />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-white/90" style={{ left: `${progress * 100}%` }} />
      {hover !== null && durationMs ? (
        <div className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-black/80 px-1.5 font-mono text-[10.5px] text-white" style={{ left: `${hover * 100}%` }}>
          {formatTimecode(hover * durationMs)}
        </div>
      ) : null}
      {durationMs
        ? markers.map((m) => (
            <Tooltip key={m.id} content={`${formatTimecode(m.timestampMs)} · ${m.author}: ${m.text}`}>
              <button
                type="button"
                aria-label={`Feedback at ${formatTimecode(m.timestampMs)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  onSeek(m.timestampMs / durationMs);
                  onMarkerClick?.(m.id);
                }}
                className={cn(
                  "absolute -bottom-1.5 size-3 -translate-x-1/2 rounded-full border-2 border-bg",
                  m.resolved ? "bg-state-approved" : "bg-state-changes",
                  activeMarkerId === m.id && "ring-2 ring-accent",
                )}
                style={{ left: `${Math.min(100, (m.timestampMs / durationMs) * 100)}%` }}
              />
            </Tooltip>
          ))
        : null}
    </div>
  );
}

export const AudioPlayer = forwardRef<TimelineHandle, AudioPlayerProps>(function AudioPlayer(props, ref) {
  const { src, mimeType, fallbackSrc, peaksUrl, waveformState, markers = [], activeMarkerId, onMarkerClick, onPlayingChange, onTimeChange, downloadUrl, label, meta } = props;
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(props.durationMs ?? 0);
  const [volume, setVolume] = useState(0.9);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const { peaks, error: peaksError } = usePeaks(peaksUrl);

  // Prefer the original; fall back to the compatibility copy only when this browser can't decode it.
  const [useFallback, setUseFallback] = useState(false);
  const codec = String(meta?.codec ?? "").toLowerCase();
  useEffect(() => {
    const probe = document.createElement("audio");
    const type = mimeType === "audio/ogg" ? `audio/ogg; codecs="${codec === "opus" ? "opus" : "vorbis"}"` : mimeType;
    setUseFallback(probe.canPlayType(type) === "" && Boolean(fallbackSrc));
  }, [mimeType, codec, fallbackSrc]);
  const activeSrc = useFallback && fallbackSrc ? fallbackSrc : src;

  const seek = useCallback((ms: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    setTime(el.currentTime * 1000);
    onTimeChange?.(el.currentTime * 1000);
  }, [onTimeChange]);

  useImperativeHandle(
    ref,
    () => ({
      seek,
      play: () => void audio.current?.play().catch(() => {}),
      pause: () => audio.current?.pause(),
      currentTimeMs: () => Math.round((audio.current?.currentTime ?? 0) * 1000),
    }),
    [seek],
  );

  // Stop playback when the source changes or the player goes away. (Don't strip `src` here: React has
  // already applied the new one by the time this cleanup runs, and StrictMode re-runs effects on mount.)
  useEffect(() => {
    const el = audio.current;
    return () => el?.pause();
  }, [activeSrc]);

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (audio.current) audio.current.muted = muted;
  }, [muted]);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setFailed(true));
    else el.pause();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (keyBelongsToControl(e)) return;
    const step = e.shiftKey ? 5000 : 1000;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      seek(time - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seek(time + step);
    } else if (e.key === "m") setMuted((m) => !m);
    else if (e.key === "l") setLoop((l) => !l);
  };

  const progress = duration ? Math.min(1, time / duration) : 0;
  const details = useMemo(() => {
    const m = meta ?? {};
    return [m.codec ? String(m.codec).toUpperCase() : null, m.sampleRate ? `${Math.round(Number(m.sampleRate) / 100) / 10} kHz` : null, m.channels ? (m.channels === 1 ? "mono" : m.channels === 2 ? "stereo" : `${m.channels} ch`) : null, m.bitrateKbps ? `${m.bitrateKbps} kb/s` : null]
      .filter(Boolean)
      .join(" · ");
  }, [meta]);

  return (
    <div
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Audio player: ${label}`}
      className="flex h-full w-full flex-col justify-center gap-3 bg-gradient-to-b from-[#15161c] to-[#0e0f13] p-4 text-white outline-none focus-visible:ring-2 focus-visible:ring-ring md:p-6"
    >
      <audio
        ref={audio}
        src={activeSrc}
        preload="metadata"
        loop={loop}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(Math.round(d * 1000));
          setFailed(false);
        }}
        onTimeUpdate={(e) => {
          const ms = e.currentTarget.currentTime * 1000;
          setTime(ms);
          if (e.currentTarget.paused) onTimeChange?.(ms);
        }}
        onSeeked={(e) => onTimeChange?.(e.currentTarget.currentTime * 1000)}
        onPlay={() => {
          setPlaying(true);
          onPlayingChange?.(true);
        }}
        onPause={(e) => {
          setPlaying(false);
          onPlayingChange?.(false);
          onTimeChange?.(e.currentTarget.currentTime * 1000);
        }}
        onEnded={() => {
          setPlaying(false);
          onPlayingChange?.(false);
        }}
        onError={() => {
          if (!useFallback && fallbackSrc) setUseFallback(true);
          else setFailed(true);
        }}
      />
      <div className="flex items-center gap-2 text-[12px] text-white/70">
        <span className="truncate font-medium text-white/90">{label}</span>
        {details ? <span className="hidden truncate sm:inline">· {details}</span> : null}
        <span className="flex-1" />
        {useFallback ? <span className="rounded bg-white/10 px-1.5 text-[11px]" title="Your browser can't decode the original; playing an AAC copy made from it. Download the original for exact audio.">Compatibility copy</span> : null}
      </div>

      <div className="relative pt-6">
        <Waveform
          peaks={peaks}
          progress={progress}
          markers={markers}
          activeMarkerId={activeMarkerId}
          durationMs={duration}
          onSeek={(f) => seek(f * duration)}
          onMarkerClick={onMarkerClick}
        />
        {!peaks ? (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-[12px] text-white/60">
            {waveformState === "failed" || peaksError ? "Waveform unavailable — playback still works." : waveformState === "processing" ? "Generating waveform…" : "Loading waveform…"}
          </p>
        ) : null}
      </div>

      {failed ? (
        <p className="rounded-md bg-danger/20 px-3 py-2 text-[12.5px] text-white">This audio couldn't be played in your browser. Download the original to listen locally.</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="flex size-10 items-center justify-center rounded-full bg-white text-black hover:bg-white/90">
          {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
        </button>
        <Tooltip content="Back to start">
          <button type="button" aria-label="Back to start" onClick={() => seek(0)} className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10">
            <RotateCcw className="size-4" />
          </button>
        </Tooltip>
        <span className="font-mono text-[12.5px] tabular-nums" aria-live="off">
          {formatTimecode(time)} <span className="text-white/50">/ {formatTimecode(duration)}</span>
        </span>
        <span className="flex-1" />
        <Tooltip content={loop ? "Looping — click to play once" : "Loop"} shortcut="L">
          <button type="button" aria-label="Loop" aria-pressed={loop} onClick={() => setLoop((l) => !l)} className={cn("flex size-8 items-center justify-center rounded-md hover:bg-white/10", loop ? "text-accent" : "text-white/80")}>
            <Repeat className="size-4" />
          </button>
        </Tooltip>
        <Select variant="media" aria-label="Playback speed" value={String(rate)} onValueChange={(v) => setRate(Number(v))} className="h-8" options={RATES.map((r) => ({ value: String(r), label: `${r}×` }))} />
        <div className="flex items-center gap-1">
          <Tooltip content={muted ? "Unmute" : "Mute"} shortcut="M">
            <button type="button" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={() => setMuted((m) => !m)} className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10">
              {muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
          </Tooltip>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => {
              setVolume(Number(e.target.value));
              if (Number(e.target.value) > 0) setMuted(false);
            }}
            className="w-20 accent-[var(--accent)]"
          />
        </div>
        {downloadUrl ? (
          <Tooltip content="Download original">
            <a href={downloadUrl} aria-label="Download original" className="flex size-8 items-center justify-center rounded-md text-white/80 hover:bg-white/10">
              <Download className="size-4" />
            </a>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});
