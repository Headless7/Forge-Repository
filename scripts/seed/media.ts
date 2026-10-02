/**
 * Generates believable placeholder media for the demo seed: short VFX/animation
 * clips (SVG frames rendered by sharp, encoded by ffmpeg) and UI/model/map images.
 * Each version differs visibly so review feedback ("reduce camera shake",
 * "increase glow") corresponds to what you actually see.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";

const W = 960;
const H = 540;
const FPS = 24;

// Deterministic pseudo-random so seeds are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

function hud(label: string, version: string, t: number, seconds: number) {
  const time = (t * seconds).toFixed(2).padStart(5, "0");
  return `
  <g font-family="${FONT}">
    <rect x="16" y="14" width="${label.length * 8.6 + 90}" height="28" rx="6" fill="#000" opacity="0.45"/>
    <text x="28" y="33" font-size="14" font-weight="700" fill="#fff">${label}</text>
    <text x="${label.length * 8.6 + 40}" y="33" font-size="13" fill="#c4b5fd">${version}</text>
    <text x="${W - 90}" y="${H - 20}" font-size="13" fill="#ffffff" opacity="0.6">00:${time}</text>
  </g>`;
}

function arena(horizon = 350) {
  let grid = "";
  for (let i = -12; i <= 12; i++) {
    grid += `<line x1="${W / 2 + i * 22}" y1="${horizon}" x2="${W / 2 + i * 150}" y2="${H}" stroke="#6d5bd0" stroke-opacity="0.18"/>`;
  }
  for (let j = 0; j < 8; j++) {
    const y = horizon + Math.pow(j / 8, 1.8) * (H - horizon);
    grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#6d5bd0" stroke-opacity="0.14"/>`;
  }
  let skyline = "";
  const r = rng(7);
  for (let x = 0; x < W; x += 38) {
    const h = 30 + r() * 90;
    skyline += `<rect x="${x}" y="${horizon - h}" width="34" height="${h}" fill="#0d0b1e"/>`;
  }
  return `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#07060f"/><stop offset="1" stop-color="#1b1535"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${skyline}
  <rect y="${horizon}" width="${W}" height="${H - horizon}" fill="#0a0916"/>
  ${grid}`;
}

export interface HollowPurpleOptions {
  label: string;
  version: string;
  seconds: number;
  glow: number;
  shake: number;
  impact: number;
  blueTint: number;
}

/** Blue + red orbs converge into a purple sphere that fires a beam. */
function hollowPurpleFrame(t: number, o: HollowPurpleOptions, random: () => number) {
  const merge = ease((t - 0.1) / 0.35);
  const fire = ease((t - 0.55) / 0.3);
  const cx = W / 2;
  const cy = 250;
  const bx = lerp(180, cx, merge);
  const rx = lerp(W - 180, cx, merge);
  const orbY = cy + Math.sin(t * 20) * 6 * (1 - merge);
  const flash = t > 0.45 && t < 0.62 ? Math.sin(((t - 0.45) / 0.17) * Math.PI) : 0;
  const shakeAmp = t > 0.45 ? o.shake * Math.max(0, 1 - (t - 0.45) * 1.6) : 0;
  const sx = (random() - 0.5) * 2 * shakeAmp;
  const sy = (random() - 0.5) * 2 * shakeAmp;
  const sphereR = t < 0.45 ? 0 : lerp(20, 58, ease((t - 0.45) / 0.15)) * (1 + o.impact * 0.25 * flash);
  const beamLen = fire * (W + 200);
  let particles = "";
  for (let i = 0; i < 28; i++) {
    const a = random() * Math.PI * 2;
    const d = (t > 0.45 ? (t - 0.45) * 900 * (0.4 + random()) : 30 + random() * 40) * (o.impact * 0.7 + 0.3);
    const px = (t > 0.45 ? cx : i % 2 ? bx : rx) + Math.cos(a) * d;
    const py = (t > 0.45 ? cy : orbY) + Math.sin(a) * d * 0.6;
    particles += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(1 + random() * 2.5).toFixed(1)}" fill="${i % 3 ? "#e9d5ff" : "#93c5fd"}" opacity="${(0.4 + random() * 0.6).toFixed(2)}"/>`;
  }
  const glow = 18 * o.glow;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  ${arena()}
  <defs>
    <radialGradient id="blue"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8" stop-opacity="0"/></radialGradient>
    <radialGradient id="red"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#f87171"/><stop offset="1" stop-color="#b91c1c" stop-opacity="0"/></radialGradient>
    <radialGradient id="purple"><stop offset="0" stop-color="#ffffff"/><stop offset="0.3" stop-color="#e9d5ff"/><stop offset="0.6" stop-color="#a855f7"/><stop offset="1" stop-color="#581c87" stop-opacity="0"/></radialGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f5f3ff"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></linearGradient>
    <filter id="g" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${glow}"/></filter>
    <filter id="g2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
  </defs>
  <g transform="translate(${sx.toFixed(1)} ${sy.toFixed(1)})">
    ${t < 0.5 ? `<circle cx="${bx}" cy="${orbY}" r="${60 * o.glow}" fill="url(#blue)" filter="url(#g)" opacity="${0.55 + 0.35 * o.blueTint}"/><circle cx="${bx}" cy="${orbY}" r="22" fill="url(#blue)"/>` : ""}
    ${t < 0.5 ? `<circle cx="${rx}" cy="${orbY}" r="${60 * o.glow}" fill="url(#red)" filter="url(#g)" opacity="0.8"/><circle cx="${rx}" cy="${orbY}" r="22" fill="url(#red)"/>` : ""}
    ${sphereR > 0 ? `<circle cx="${cx}" cy="${cy}" r="${sphereR * 2.4 * o.glow}" fill="url(#purple)" filter="url(#g)"/><circle cx="${cx}" cy="${cy}" r="${sphereR}" fill="url(#purple)"/>` : ""}
    ${fire > 0 ? `<rect x="${cx}" y="${cy - sphereR * 0.8}" width="${beamLen}" height="${sphereR * 1.6}" fill="url(#beam)" filter="url(#g2)" opacity="0.9"/>` : ""}
    ${flash > 0 ? `<circle cx="${cx}" cy="${cy}" r="${120 + 260 * flash * o.impact}" fill="none" stroke="#e9d5ff" stroke-width="${3 + 6 * flash}" opacity="${0.6 * flash}"/>` : ""}
    ${particles}
  </g>
  ${flash > 0 ? `<rect width="${W}" height="${H}" fill="#f5f3ff" opacity="${(0.35 * flash * o.impact).toFixed(2)}"/>` : ""}
  ${hud(o.label, o.version, t, o.seconds)}
</svg>`;
}

/** Red cleaving slashes for the "Domain Expansion" clip. */
function slashFrame(t: number, o: { label: string; version: string; seconds: number }, random: () => number) {
  let slashes = "";
  const count = Math.floor(t * 18);
  const r = rng(99);
  for (let i = 0; i < count; i++) {
    const x = r() * W;
    const y = 60 + r() * (H - 160);
    const len = 120 + r() * 260;
    const a = -0.6 + r() * 1.2;
    const age = t * 18 - i;
    const op = Math.max(0, 1 - age / 5);
    slashes += `<line x1="${x}" y1="${y}" x2="${x + Math.cos(a) * len}" y2="${y + Math.sin(a) * len}" stroke="#fecaca" stroke-width="${2 + r() * 3}" opacity="${op.toFixed(2)}" filter="url(#glow)"/>`;
  }
  const pulse = 0.5 + 0.5 * Math.sin(t * 30);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="dome" cx="0.5" cy="0.9" r="0.9"><stop offset="0" stop-color="#7f1d1d"/><stop offset="0.6" stop-color="#1c0505"/><stop offset="1" stop-color="#050101"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#dome)"/>
  <g opacity="${0.5 + 0.2 * pulse}">
    <path d="M ${W / 2 - 140} 420 L ${W / 2 - 110} 250 L ${W / 2} 200 L ${W / 2 + 110} 250 L ${W / 2 + 140} 420 Z" fill="#2a0707" stroke="#991b1b"/>
    <rect x="${W / 2 - 170}" y="410" width="340" height="30" fill="#1f0505" stroke="#7f1d1d"/>
  </g>
  ${slashes}
  <rect width="${W}" height="${H}" fill="#ef4444" opacity="${(0.05 + 0.05 * random()).toFixed(3)}"/>
  ${hud(o.label, o.version, t, o.seconds)}
</svg>`;
}

/** A simple rigged mannequin — idle bob or ultimate spin/raise. */
function mannequinFrame(t: number, o: { label: string; version: string; seconds: number; mode: "idle" | "ultimate"; clip: boolean }) {
  const cx = W / 2;
  const phase = t * Math.PI * 2 * (o.mode === "idle" ? 2 : 1);
  const bob = Math.sin(phase) * (o.mode === "idle" ? 6 : 3);
  const raise = o.mode === "ultimate" ? ease((t - 0.3) / 0.4) : 0;
  const hipY = 330 + bob;
  const shoulderY = hipY - 110;
  const headY = shoulderY - 40;
  const armL = o.mode === "idle" ? 0.25 + Math.sin(phase) * 0.08 : lerp(0.3, -2.6, raise);
  const armR = o.mode === "idle" ? -0.25 - Math.sin(phase) * 0.08 : lerp(-0.3, -2.2 + (o.clip ? 0.9 : 0), raise);
  const limb = (x: number, y: number, a: number, len: number) => [x + Math.sin(a) * len, y + Math.cos(a) * len];
  const [elx, ely] = limb(cx - 34, shoulderY, armL, 60);
  const [hlx, hly] = limb(elx!, ely!, armL * 0.8, 55);
  const [erx, ery] = limb(cx + 34, shoulderY, armR, 60);
  const [hrx, hry] = limb(erx!, ery!, armR * 0.8, 55);
  const weaponAngle = -0.9 + raise * 0.4;
  const aura = o.mode === "ultimate" ? `<circle cx="${cx}" cy="${shoulderY}" r="${120 + raise * 80}" fill="#dc2626" opacity="${0.12 + raise * 0.2}" filter="url(#b)"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#0b1220"/></linearGradient>
    <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="${cx}" cy="470" rx="160" ry="22" fill="#000" opacity="0.35"/>
  <line x1="0" y1="470" x2="${W}" y2="470" stroke="#334155"/>
  ${aura}
  <g stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="${cx - 20}" y1="${hipY}" x2="${cx - 30}" y2="468" stroke="#cbd5e1" stroke-width="18"/>
    <line x1="${cx + 20}" y1="${hipY}" x2="${cx + 30}" y2="468" stroke="#cbd5e1" stroke-width="18"/>
    <path d="M ${cx - 40} ${shoulderY} L ${cx + 40} ${shoulderY} L ${cx + 26} ${hipY} L ${cx - 26} ${hipY} Z" fill="#e2e8f0" stroke="#94a3b8" stroke-width="3"/>
    <polyline points="${cx - 34},${shoulderY} ${elx},${ely} ${hlx},${hly}" stroke="#e2e8f0" stroke-width="14"/>
    <polyline points="${cx + 34},${shoulderY} ${erx},${ery} ${hrx},${hry}" stroke="#e2e8f0" stroke-width="14"/>
    <line x1="${hrx}" y1="${hry}" x2="${hrx! + Math.cos(weaponAngle) * 140}" y2="${hry! + Math.sin(weaponAngle) * 140}" stroke="#fca5a5" stroke-width="6"/>
  </g>
  <circle cx="${cx}" cy="${headY}" r="26" fill="#e2e8f0" stroke="#94a3b8" stroke-width="3"/>
  ${hud(o.label, o.version, t, o.seconds)}
</svg>`;
}

async function encode(file: string, seconds: number, frame: (t: number, random: () => number) => string, seed = 1) {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary missing");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const total = Math.round(seconds * FPS);
  const child = spawn(
    ffmpegPath,
    ["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.slice(-300)}`))));
  });
  const random = rng(seed);
  for (let i = 0; i < total; i++) {
    const raw = await sharp(Buffer.from(frame(i / (total - 1), random))).removeAlpha().raw().toBuffer();
    if (!child.stdin.write(raw)) await new Promise((r) => child.stdin.once("drain", r));
  }
  child.stdin.end();
  await done;
}

export function renderHollowPurple(file: string, o: HollowPurpleOptions) {
  return encode(file, o.seconds, (t, r) => hollowPurpleFrame(t, o, r), o.label.length + Math.round(o.shake));
}

export function renderSlashes(file: string, o: { label: string; version: string; seconds: number }) {
  return encode(file, o.seconds, (t, r) => slashFrame(t, o, r), 42);
}

export function renderMannequin(file: string, o: { label: string; version: string; seconds: number; mode: "idle" | "ultimate"; clip: boolean }) {
  return encode(file, o.seconds, (t) => mannequinFrame(t, o), 3);
}

// ── Still images ────────────────────────────────────────────────────────────

async function png(file: string, svg: string, width = 1600, height = 900) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(svg)).resize(width, height).png({ compressionLevel: 8 }).toFile(file);
}

export function renderBattlepass(file: string, o: { version: string; tight: boolean }) {
  const tiers = Array.from({ length: 6 }, (_, i) => {
    const x = 70 + i * (o.tight ? 238 : 244);
    const colors = ["#a78bfa", "#60a5fa", "#34d399", "#facc15", "#f472b6", "#fb923c"];
    const owned = i < 3;
    return `<g>
      <rect x="${x}" y="300" width="${o.tight ? 226 : 220}" height="300" rx="14" fill="#141225" stroke="${owned ? colors[i] : "#2e2a4a"}" stroke-width="3"/>
      <rect x="${x + 20}" y="330" width="${o.tight ? 186 : 180}" height="150" rx="10" fill="${colors[i]}" opacity="0.18"/>
      <circle cx="${x + (o.tight ? 113 : 110)}" cy="405" r="44" fill="${colors[i]}" opacity="0.85"/>
      <text x="${x + 20}" y="520" font-family="${FONT}" font-size="22" font-weight="700" fill="#fff">Tier ${40 + i}</text>
      <text x="${x + 20}" y="552" font-family="${FONT}" font-size="17" fill="#a1a1aa">${["Mythic Aura", "500 Gems", "Gojo Skin", "Emote Pack", "2x XP Boost", "Title Card"][i]}</text>
      ${owned ? `<text x="${x + 20}" y="585" font-family="${FONT}" font-size="15" font-weight="700" fill="${colors[i]}">CLAIMED</text>` : ""}
    </g>`;
  }).join("");
  return png(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f0c1f"/><stop offset="1" stop-color="#1e1440"/></linearGradient></defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    <text x="70" y="120" font-family="${FONT}" font-size="54" font-weight="800" fill="#fff">BATTLE PASS</text>
    <text x="70" y="165" font-family="${FONT}" font-size="24" fill="#c4b5fd">Season 6 · Cursed Energy</text>
    <rect x="70" y="210" width="1460" height="26" rx="13" fill="#221c3d"/>
    <rect x="70" y="210" width="${o.tight ? 820 : 760}" height="26" rx="13" fill="#8b5cf6"/>
    <text x="1380" y="120" font-family="${FONT}" font-size="22" fill="#e9d5ff">42 days left</text>
    ${tiers}
    <rect x="${o.tight ? 1300 : 1200}" y="700" width="${o.tight ? 230 : 330}" height="72" rx="14" fill="#8b5cf6"/>
    <text x="${o.tight ? 1330 : 1245}" y="746" font-family="${FONT}" font-size="26" font-weight="800" fill="#fff">UNLOCK PREMIUM</text>
    <text x="70" y="760" font-family="${FONT}" font-size="20" fill="#71717a">${o.version}</text>
  </svg>`,
  );
}

export function renderShop(file: string, o: { version: string }) {
  const items = Array.from({ length: 8 }, (_, i) => {
    const x = 80 + (i % 4) * 370;
    const y = 250 + Math.floor(i / 4) * 300;
    const c = ["#f472b6", "#60a5fa", "#facc15", "#34d399"][i % 4];
    return `<rect x="${x}" y="${y}" width="340" height="270" rx="16" fill="#18181b" stroke="#27272a" stroke-width="2"/>
      <rect x="${x + 20}" y="${y + 20}" width="300" height="160" rx="12" fill="${c}" opacity="0.16"/>
      <polygon points="${x + 170},${y + 50} ${x + 210},${y + 100} ${x + 170},${y + 150} ${x + 130},${y + 100}" fill="${c}"/>
      <text x="${x + 20}" y="${y + 215}" font-family="${FONT}" font-size="22" font-weight="700" fill="#fafafa">${["Crimson Katana", "Frost Aura", "Golden Tower", "Jade Dragon", "Void Cape", "Sun Crest", "Neon Trail", "Shadow Pet"][i]}</text>
      <text x="${x + 20}" y="${y + 248}" font-family="${FONT}" font-size="19" fill="#facc15">◆ ${[450, 800, 1200, 300, 950, 600, 250, 1500][i]}</text>`;
  }).join("");
  return png(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <rect width="1600" height="900" fill="#0c0c10"/>
    <rect x="0" y="0" width="1600" height="170" fill="#131318"/>
    <text x="80" y="110" font-family="${FONT}" font-size="52" font-weight="800" fill="#fafafa">SHOP</text>
    <text x="260" y="108" font-family="${FONT}" font-size="22" fill="#a1a1aa">Featured · Units · Cosmetics · Gamepasses</text>
    <rect x="1280" y="62" width="240" height="56" rx="28" fill="#27272a"/>
    <text x="1310" y="99" font-family="${FONT}" font-size="24" font-weight="700" fill="#facc15">◆ 12,480</text>
    ${items}
    <text x="80" y="880" font-family="${FONT}" font-size="18" fill="#52525b">${o.version}</text>
  </svg>`,
  );
}

export function renderTowerModel(file: string, o: { version: string; hue: string }) {
  const floors = Array.from({ length: 5 }, (_, i) => {
    const y = 640 - i * 95;
    const w = 300 - i * 40;
    return `<polygon points="${800 - w},${y} ${800},${y + 60} ${800 + w},${y} ${800},${y - 60}" fill="${o.hue}" opacity="${0.35 + i * 0.1}"/>
      <polygon points="${800 - w},${y} ${800},${y + 60} ${800},${y + 150} ${800 - w},${y + 90}" fill="#1e1b2e"/>
      <polygon points="${800 + w},${y} ${800},${y + 60} ${800},${y + 150} ${800 + w},${y + 90}" fill="#2b2640"/>`;
  }).join("");
  return png(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><radialGradient id="bg" cx="0.5" cy="0.4" r="0.8"><stop offset="0" stop-color="#2a2540"/><stop offset="1" stop-color="#0c0b12"/></radialGradient>
    <filter id="b"><feGaussianBlur stdDeviation="18"/></filter></defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    <ellipse cx="800" cy="790" rx="420" ry="60" fill="#000" opacity="0.45"/>
    ${floors}
    <circle cx="800" cy="170" r="40" fill="${o.hue}" filter="url(#b)"/>
    <circle cx="800" cy="170" r="16" fill="#fff"/>
    <text x="40" y="60" font-family="${FONT}" font-size="26" font-weight="700" fill="#e4e4e7">Cursed Shrine Tower — turnaround 3/4</text>
    <text x="40" y="95" font-family="${FONT}" font-size="18" fill="#a1a1aa">${o.version} · 4,812 tris · 2 materials</text>
  </svg>`,
  );
}

export function renderUnitModel(file: string, o: { version: string }) {
  return png(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1917"/><stop offset="1" stop-color="#0c0a09"/></linearGradient></defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    <ellipse cx="800" cy="800" rx="260" ry="40" fill="#000" opacity="0.5"/>
    <g fill="#e7e5e4" stroke="#a8a29e" stroke-width="4">
      <rect x="740" y="330" width="120" height="220" rx="18"/>
      <circle cx="800" cy="270" r="58"/>
      <rect x="560" y="345" width="185" height="44" rx="20"/>
      <rect x="855" y="345" width="185" height="44" rx="20"/>
      <rect x="752" y="545" width="44" height="240" rx="18"/>
      <rect x="804" y="545" width="44" height="240" rx="18"/>
    </g>
    <path d="M 760 250 q 40 -30 80 0" stroke="#ef4444" stroke-width="6" fill="none"/>
    <text x="40" y="60" font-family="${FONT}" font-size="26" font-weight="700" fill="#f5f5f4">Sukuna Unit — T-pose, rig check</text>
    <text x="40" y="95" font-family="${FONT}" font-size="18" fill="#a8a29e">${o.version} · R15 rig · 23 bones</text>
  </svg>`,
  );
}

export function renderLobbyMap(file: string, o: { version: string }) {
  const r = rng(11);
  let trees = "";
  for (let i = 0; i < 60; i++) {
    const x = r() * 1600;
    const y = r() * 900;
    if (Math.abs(x - 800) < 260 && Math.abs(y - 450) < 200) continue;
    trees += `<circle cx="${x}" cy="${y}" r="${10 + r() * 14}" fill="#166534" opacity="${0.6 + r() * 0.4}"/>`;
  }
  return png(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <rect width="1600" height="900" fill="#14532d"/>
    ${trees}
    <path d="M 0 450 L 1600 450" stroke="#a8a29e" stroke-width="60"/>
    <path d="M 800 0 L 800 900" stroke="#a8a29e" stroke-width="60"/>
    <circle cx="800" cy="450" r="170" fill="#78716c" stroke="#d6d3d1" stroke-width="8"/>
    <circle cx="800" cy="450" r="60" fill="#38bdf8" opacity="0.8"/>
    ${[[380, 220], [1220, 220], [380, 680], [1220, 680]].map(([x, y], i) => `<rect x="${x! - 110}" y="${y! - 80}" width="220" height="160" rx="10" fill="#44403c" stroke="#e7e5e4" stroke-width="4"/><text x="${x! - 80}" y="${y! + 8}" font-family="${FONT}" font-size="24" font-weight="700" fill="#fafaf9">${["PLAY", "SHOP", "SUMMON", "TRADE"][i]}</text>`).join("")}
    <text x="30" y="870" font-family="${FONT}" font-size="20" fill="#dcfce7">Lobby — top-down · ${o.version}</text>
  </svg>`,
  );
}

export function renderThumbnail(file: string, o: { title: string; subtitle: string; hue: string }) {
  return png(
    file,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><radialGradient id="bg" cx="0.7" cy="0.4" r="0.9"><stop offset="0" stop-color="${o.hue}"/><stop offset="1" stop-color="#050505"/></radialGradient>
    <filter id="b"><feGaussianBlur stdDeviation="40"/></filter></defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    <circle cx="1150" cy="380" r="260" fill="${o.hue}" filter="url(#b)" opacity="0.8"/>
    <text x="90" y="420" font-family="${FONT}" font-size="120" font-weight="900" fill="#fff">${o.title}</text>
    <text x="96" y="500" font-family="${FONT}" font-size="46" font-weight="700" fill="#fde68a">${o.subtitle}</text>
  </svg>`,
  );
}
