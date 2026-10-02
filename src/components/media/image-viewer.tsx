"use client";

import { Check, Maximize, Minimize, Scan, ZoomIn, ZoomOut, MousePointerClick } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "../ui/menu";

export interface ImageMarker {
  id: string;
  number: number;
  x: number;
  y: number;
  resolved: boolean;
  label: string;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
  fit: boolean;
}

const MAX_SCALE = 8;

/**
 * Review-grade image viewer: wheel zoom around the cursor, drag to pan, fit /
 * actual size / fullscreen, and numbered feedback markers positioned from
 * normalised (0–1) coordinates so they stay glued to the pixels at any size.
 */
export function ImageViewer({
  src,
  alt,
  naturalWidth,
  naturalHeight,
  markers,
  activeMarkerId,
  pending,
  onPlace,
  onMarkerClick,
  className,
}: {
  src: string;
  alt: string;
  naturalWidth?: number | null;
  naturalHeight?: number | null;
  markers: ImageMarker[];
  activeMarkerId?: string | null;
  pending?: { x: number; y: number } | null;
  /** When set, clicking the image places a feedback pin. */
  onPlace?: (x: number, y: number) => void;
  onMarkerClick?: (id: string) => void;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: naturalWidth ?? 0, h: naturalHeight ?? 0 });
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0, fit: true });
  const [fullscreen, setFullscreen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  const fitView = useCallback((): View => {
    if (!natural.w || !natural.h || !size.w || !size.h) return { scale: 1, tx: 0, ty: 0, fit: true };
    const scale = Math.min(size.w / natural.w, size.h / natural.h);
    return { scale, tx: (size.w - natural.w * scale) / 2, ty: (size.h - natural.h * scale) / 2, fit: true };
  }, [natural, size]);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stay fitted while in fit mode (resize, fullscreen, image swap).
  useEffect(() => {
    setView((v) => (v.fit ? fitView() : v));
  }, [fitView]);

  useEffect(() => {
    setLoaded(false);
    setView((v) => ({ ...v, fit: true }));
  }, [src]);

  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) => {
      setView((v) => {
        const min = Math.min(fitView().scale, 1) * 0.5;
        const scale = Math.min(MAX_SCALE, Math.max(min, v.scale * factor));
        const cx = px ?? size.w / 2;
        const cy = py ?? size.h / 2;
        return { scale, tx: cx - ((cx - v.tx) * scale) / v.scale, ty: cy - ((cy - v.ty) * scale) / v.scale, fit: false };
      });
    },
    [fitView, size],
  );

  const actualSize = useCallback(() => {
    setView({ scale: 1, tx: (size.w - natural.w) / 2, ty: (size.h - natural.h) / 2, fit: false });
  }, [natural, size]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current?.parentElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Bring the selected marker into view when zoomed in.
  useEffect(() => {
    if (!activeMarkerId || view.fit) return;
    const marker = markers.find((m) => m.id === activeMarkerId);
    if (!marker) return;
    setView((v) => ({ ...v, tx: size.w / 2 - marker.x * natural.w * v.scale, ty: size.h / 2 - marker.y * natural.h * v.scale }));
    // Only re-centre when the selection changes, not on every resize/zoom.
  }, [activeMarkerId]);

  const toggleFullscreen = () => {
    const shell = container.current?.parentElement;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.requestFullscreen?.();
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy, fit: false }));
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !onPlace || !natural.w) return;
    const rect = container.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left - view.tx) / (natural.w * view.scale);
    const y = (e.clientY - rect.top - view.ty) / (natural.h * view.scale);
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onPlace(Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "0") setView(fitView());
    else if (e.key === "1") actualSize();
    else if (e.key === "+" || e.key === "=") zoomAt(1.25);
    else if (e.key === "-") zoomAt(0.8);
    else if (e.key.toLowerCase() === "f") toggleFullscreen();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const pos = (x: number, y: number) => ({ left: view.tx + x * natural.w * view.scale, top: view.ty + y * natural.h * view.scale });
  const percent = Math.round(view.scale * 100);

  return (
    <div className={cn("group/viewer relative h-full w-full overflow-hidden bg-black", fullscreen && "bg-black", className)}>
      <div
        ref={container}
        role="application"
        aria-label={`${alt}. ${onPlace ? "Click to pin feedback. " : ""}Scroll to zoom, drag to pan.`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => (view.fit ? actualSize() : setView(fitView()))}
        className={cn(
          "checkerboard absolute inset-0 touch-none select-none outline-none",
          onPlace ? "cursor-crosshair" : view.fit ? "cursor-default" : "cursor-grab active:cursor-grabbing",
        )}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            setLoaded(true);
          }}
          className={cn("absolute left-0 top-0 max-w-none origin-top-left transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
          style={{
            width: natural.w || undefined,
            height: natural.h || undefined,
            transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
            imageRendering: view.scale > 2 ? "pixelated" : "auto",
          }}
        />
        {!loaded ? <div className="absolute inset-0 animate-pulse bg-surface-3/40" /> : null}
        {loaded
          ? markers.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-label={`Feedback ${m.number}: ${m.label}`}
                title={m.label}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkerClick?.(m.id);
                }}
                className={cn(
                  "absolute z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-[12px] font-bold shadow-md transition-transform duration-150 hover:scale-110",
                  m.resolved ? "border-white/70 bg-state-approved/85 text-white" : "border-white bg-state-changes text-white",
                  m.id === activeMarkerId && "scale-125 animate-pulse-ring ring-2 ring-white",
                )}
                style={pos(m.x, m.y)}
              >
                {m.resolved ? <Check className="size-3.5" strokeWidth={3} /> : m.number}
              </button>
            ))
          : null}
        {loaded && pending ? (
          <span
            className="pointer-events-none absolute z-20 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-accent text-sm font-bold text-white shadow-lg animate-pulse-ring"
            style={pos(pending.x, pending.y)}
          >
            +
          </span>
        ) : null}
      </div>

      <div className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-white/10 bg-black/70 p-1 text-white opacity-90 backdrop-blur transition-opacity group-hover/viewer:opacity-100">
        {onPlace ? (
          <span className="flex items-center gap-1 px-1.5 text-[11px] text-white/80">
            <MousePointerClick className="size-3.5" /> Click to pin feedback
          </span>
        ) : null}
        <Tooltip content="Zoom out" shortcut="−">
          <button type="button" aria-label="Zoom out" onClick={() => zoomAt(0.8)} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
            <ZoomOut className="size-4" />
          </button>
        </Tooltip>
        <span className="w-11 text-center font-mono text-[11px] tabular-nums">{percent}%</span>
        <Tooltip content="Zoom in" shortcut="+">
          <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.25)} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
            <ZoomIn className="size-4" />
          </button>
        </Tooltip>
        <Tooltip content="Fit to screen" shortcut="0">
          <button type="button" aria-label="Fit to screen" onClick={() => setView(fitView())} className={cn("flex h-7 items-center justify-center rounded px-2 text-[11px] font-medium hover:bg-white/15", view.fit && "bg-white/15")}>
            <Scan className="mr-1 size-3.5" /> Fit
          </button>
        </Tooltip>
        <Tooltip content="Actual size" shortcut="1">
          <button type="button" aria-label="Actual size" onClick={actualSize} className={cn("flex h-7 items-center justify-center rounded px-2 text-[11px] font-medium hover:bg-white/15", !view.fit && Math.abs(view.scale - 1) < 0.001 && "bg-white/15")}>
            100%
          </button>
        </Tooltip>
        <Tooltip content={fullscreen ? "Exit fullscreen" : "Fullscreen"} shortcut="F">
          <button type="button" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen} className="flex size-7 items-center justify-center rounded hover:bg-white/15">
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </button>
        </Tooltip>
      </div>
      {natural.w ? (
        <span className="absolute right-2 top-2 z-20 rounded bg-black/60 px-1.5 font-mono text-[10px] text-white/80">
          {natural.w}×{natural.h}
        </span>
      ) : null}
    </div>
  );
}
