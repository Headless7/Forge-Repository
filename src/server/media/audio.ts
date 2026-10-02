import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runFfmpeg } from "./ffmpeg";
import { runtimePath } from "../runtime-path";

export interface AudioProbe {
  durationMs: number | null;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
}

/** Parses `ffmpeg -i` diagnostics for the first audio stream. */
export async function probeAudio(file: string): Promise<AudioProbe> {
  const { stderr } = await runFfmpeg(["-i", file], 60_000);
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const line = /Stream #\d+:\d+[^:]*: Audio: ([^\n]+)/.exec(stderr)?.[1] ?? null;
  const bitrate = line ? /(\d+)\s*kb\/s/.exec(line) : null;
  const overall = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr);
  const channelsText = line ? /(\d+(?:\.\d+)?)\s*channels|\b(mono|stereo|5\.1|7\.1)\b/.exec(line) : null;
  const channels = channelsText
    ? channelsText[1]
      ? Math.round(Number(channelsText[1]))
      : ({ mono: 1, stereo: 2, "5.1": 6, "7.1": 8 } as Record<string, number>)[channelsText[2]!] ?? null
    : null;
  return {
    durationMs: duration ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000) : null,
    codec: line ? line.split(/[\s,(]/)[0]! : null,
    sampleRate: line ? Number(/(\d+)\s*Hz/.exec(line)?.[1] ?? NaN) || null : null,
    channels,
    bitrateKbps: bitrate ? Number(bitrate[1]) : overall ? Number(overall[1]) : null,
  };
}

export interface Peaks {
  v: 1;
  /** Peak amplitude (0–1) per bucket, mixed down to mono. */
  peaks: number[];
  durationMs: number;
}

const SAMPLE_RATE = 8000;

/** Decodes to 8 kHz mono PCM and reduces it to `buckets` peak values. */
export async function computePeaks(file: string, dir: string, buckets = 1200): Promise<Peaks> {
  const raw = runtimePath(dir, "pcm.raw");
  const { code, stderr } = await runFfmpeg(["-y", "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", raw], 5 * 60 * 1000);
  if (code !== 0) throw new Error(`Audio decode failed: ${stderr.slice(-300)}`);
  const buffer = await fsp.readFile(raw);
  const samples = Math.floor(buffer.length / 2);
  const per = Math.max(1, Math.ceil(samples / buckets));
  const peaks: number[] = [];
  let loudest = 0;
  for (let b = 0; b * per < samples; b++) {
    let peak = 0;
    const end = Math.min(samples, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = Math.abs(buffer.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    const n = peak / 32768;
    loudest = Math.max(loudest, n);
    peaks.push(n);
  }
  return {
    v: 1,
    // Keep true amplitude (no normalisation) but round for a compact payload.
    peaks: peaks.map((p) => Math.round(p * 1000) / 1000),
    durationMs: Math.round((samples / SAMPLE_RATE) * 1000),
  };
}

/** Board/list thumbnail: the waveform drawn as bars. */
export async function renderWaveformThumb(peaks: number[], width = 960, height = 320): Promise<Buffer> {
  const bars = 160;
  const step = peaks.length / bars;
  const loudest = Math.max(0.05, ...peaks);
  const barWidth = width / bars;
  const rects: string[] = [];
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) peak = Math.max(peak, peaks[j] ?? 0);
    const h = Math.max(4, (peak / loudest) * (height * 0.78));
    rects.push(
      `<rect x="${(i * barWidth + barWidth * 0.18).toFixed(1)}" y="${((height - h) / 2).toFixed(1)}" width="${(barWidth * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="${(barWidth * 0.3).toFixed(1)}" fill="url(#g)"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#3fb6ff"/></linearGradient></defs>
<rect width="100%" height="100%" fill="#15161c"/>${rects.join("")}</svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
}

/** Browser-compatibility copy for Ogg (Safari lacks Vorbis on some versions). The original stays the reference. */
export async function transcodeAudioToM4a(file: string, output: string) {
  const { code, stderr } = await runFfmpeg(["-y", "-i", file, "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output]);
  if (code !== 0) throw new Error(`Audio transcode failed: ${stderr.slice(-300)}`);
}
