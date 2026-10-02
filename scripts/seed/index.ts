/**
 * Demo data for local evaluation. Everything is created through the real
 * services (with a pinned clock for realistic history), so the seed doubles as
 * an end-to-end exercise of the review workflow.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, lt } from "drizzle-orm";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/lib/demo-accounts";
import { hashPassword } from "@/server/auth/crypto";
import { pinClock } from "@/server/clock";
import { closeDb, db, rawSql } from "@/server/db";
import { attachments, cardViews, deliverables, notifications, studioMembers, users } from "@/server/db/schema";
import { mediaQueue } from "@/server/jobs/queue";
import * as board from "@/server/services/board";
import * as cards from "@/server/services/cards";
import * as checklists from "@/server/services/checklists";
import * as comments from "@/server/services/comments";
import * as deliverableService from "@/server/services/deliverables";
import type { Actor } from "@/server/services/context";
import * as labels from "@/server/services/labels";
import * as media from "@/server/services/media";
import * as production from "@/server/services/production";
import * as projects from "@/server/services/projects";
import * as reviews from "@/server/services/reviews";
import * as roblox from "@/server/services/roblox";
import * as studios from "@/server/services/studios";
import { storage } from "@/server/storage";
import { log, runMigrations } from "../lib/bootstrap";
import { requireEnv } from "../lib/env";
import * as gen from "./media";
import { generateRobloxDemo, RESOURCE_IDS } from "./roblox";

const MEDIA_DIR = path.resolve(".data/seed-media");

/** A moment `days` ago at hh:mm local time. Negative days are in the future. */
function T(days: number, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function resetDatabase() {
  log("Resetting database …");
  const sql = rawSql();
  await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await closeDb();
  await runMigrations(requireEnv("DATABASE_URL"));
  fs.rmSync(path.resolve(process.env.STORAGE_LOCAL_DIR ?? ".data/storage"), { recursive: true, force: true });
}

async function generateMedia() {
  const file = (name: string) => path.join(MEDIA_DIR, name);
  const jobs: Array<[string, () => Promise<void>]> = [
    ["hp_v1.mp4", () => gen.renderHollowPurple(file("hp_v1.mp4"), { label: "GOJO · HOLLOW PURPLE", version: "V1", seconds: 5, glow: 1.35, shake: 24, impact: 0.45, blueTint: 1 })],
    ["hp_v2.mp4", () => gen.renderHollowPurple(file("hp_v2.mp4"), { label: "GOJO · HOLLOW PURPLE", version: "V2", seconds: 5, glow: 1.0, shake: 10, impact: 0.9, blueTint: 0.4 })],
    ["gu_v1.mp4", () => gen.renderHollowPurple(file("gu_v1.mp4"), { label: "GOJO · ULTIMATE", version: "V1", seconds: 4, glow: 1.6, shake: 30, impact: 0.3, blueTint: 1 })],
    ["gu_v2.mp4", () => gen.renderHollowPurple(file("gu_v2.mp4"), { label: "GOJO · ULTIMATE", version: "V2", seconds: 4, glow: 1.3, shake: 20, impact: 0.5, blueTint: 0.8 })],
    ["gu_v3.mp4", () => gen.renderHollowPurple(file("gu_v3.mp4"), { label: "GOJO · ULTIMATE", version: "V3", seconds: 4, glow: 1.1, shake: 12, impact: 0.8, blueTint: 0.5 })],
    ["gu_v4.mp4", () => gen.renderHollowPurple(file("gu_v4.mp4"), { label: "GOJO · ULTIMATE", version: "V4", seconds: 4, glow: 1.0, shake: 6, impact: 1, blueTint: 0.3 })],
    ["sukuna_domain_v1.mp4", () => gen.renderSlashes(file("sukuna_domain_v1.mp4"), { label: "SUKUNA · MALEVOLENT SHRINE", version: "V1", seconds: 5 })],
    ["sukuna_ult_v1.mp4", () => gen.renderMannequin(file("sukuna_ult_v1.mp4"), { label: "SUKUNA · ULTIMATE", version: "V1", seconds: 5, mode: "ultimate", clip: true })],
    ["sukuna_idle_v1.mp4", () => gen.renderMannequin(file("sukuna_idle_v1.mp4"), { label: "SUKUNA · IDLE", version: "V1", seconds: 4, mode: "idle", clip: false })],
    ["battlepass_v1.png", () => gen.renderBattlepass(file("battlepass_v1.png"), { version: "V1", tight: true })],
    ["battlepass_v2.png", () => gen.renderBattlepass(file("battlepass_v2.png"), { version: "V2", tight: false })],
    ["battlepass_v3.png", () => gen.renderBattlepass(file("battlepass_v3.png"), { version: "V3", tight: false })],
    ["shop_v1.png", () => gen.renderShop(file("shop_v1.png"), { version: "V1" })],
    ["tower_v1.png", () => gen.renderTowerModel(file("tower_v1.png"), { version: "V1", hue: "#a855f7" })],
    ["sukuna_unit_v1.png", () => gen.renderUnitModel(file("sukuna_unit_v1.png"), { version: "V1" })],
    ["lobby_v1.png", () => gen.renderLobbyMap(file("lobby_v1.png"), { version: "V1" })],
    ["gear5_thumb.png", () => gen.renderThumbnail(file("gear5_thumb.png"), { title: "GEAR 5", subtitle: "Transformation VFX preview", hue: "#f59e0b" })],
    ["opr_thumb.png", () => gen.renderThumbnail(file("opr_thumb.png"), { title: "UPDATE 2", subtitle: "Marineford arrives", hue: "#2563eb" })],
    ["marineford.png", () => gen.renderLobbyMap(file("marineford.png"), { version: "blockout" })],
    ["skyforge_ui.png", () => gen.renderShop(file("skyforge_ui.png"), { version: "Skyforge dock UI" })],
  ];
  const missing = jobs.filter(([name]) => !fs.existsSync(file(name)));
  if (missing.length === 0) return file;
  log(`Rendering ${missing.length} demo media files (first run only, ~1 minute) …`);
  // Two at a time keeps the machine responsive.
  for (let i = 0; i < missing.length; i += 2) {
    await Promise.all(missing.slice(i, i + 2).map(([, run]) => run()));
  }
  return file;
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".rbxm": "application/octet-stream",
  ".obj": "text/plain",
};

export async function seed({ reset = false }: { reset?: boolean } = {}) {
  if (reset) await resetDatabase();
  const mediaFile = await generateMedia();
  const robloxFile = await generateRobloxDemo(path.join(MEDIA_DIR, "roblox"));
  const file = (name: string) => (fs.existsSync(robloxFile(name)) ? robloxFile(name) : mediaFile(name));
  log("Creating demo studio …");

  // ── Users ────────────────────────────────────────────────────────────────
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const u: Record<string, { id: string }> = {};
  for (const account of DEMO_ACCOUNTS) {
    const [row] = await db
      .insert(users)
      .values({
        email: account.email,
        username: account.username,
        displayName: account.name,
        passwordHash,
        emailVerifiedAt: T(30),
        avatarColor: ["#7c6cf2", "#3b82f6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"][Object.keys(u).length % 9]!,
        createdAt: T(30),
      })
      .returning({ id: users.id });
    u[account.username] = row!;
  }
  const A = (username: string): Actor => ({ userId: u[username]!.id });
  const as = async <R>(username: string, when: Date, fn: (actor: Actor) => Promise<R>): Promise<R> => {
    pinClock(when);
    return fn(A(username));
  };

  const upload = async (actor: Actor, cardId: string, name: string, purpose: "version" | "attachment" | "comment" | "resource", versionId?: string) => {
    const source = file(name);
    const size = fs.statSync(source).size;
    const contentType = MIME[path.extname(name)] ?? "application/octet-stream";
    const intent = await media.createUpload(actor, { cardId, filename: name, size, contentType, purpose, versionId });
    const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
    await storage().putFile(row!.storageKey, source, contentType);
    return media.completeUpload(actor, { attachmentId: intent.attachmentId });
  };
  const newVersion = async (username: string, when: Date, cardId: string, name: string, notes: string) =>
    as(username, when, async (actor) => {
      const version = await media.createVersion(actor, { cardId, notes });
      const attachment = await upload(actor, cardId, name, "version", version.id);
      return { version, attachment };
    });
  /** A new revision of one deliverable of a multi-deliverable card. */
  const newRevision = async (username: string, when: Date, cardId: string, deliverableId: string, name: string, notes: string) =>
    as(username, when, async (actor) => {
      const version = await media.createVersion(actor, { deliverableId, notes });
      const attachment = await upload(actor, cardId, name, "version", version.id);
      return { version, attachment };
    });
  /** Uploads a stand-in file and maps a Roblox content id to it, as an artist does from the preview. */
  const provideResource = async (username: string, when: Date, cardId: string, contentId: string, kind: "mesh" | "texture", name: string) =>
    as(username, when, async (actor) => {
      const attachment = await upload(actor, cardId, name, "resource");
      return roblox.resolveResource(actor, { cardId, contentId, kind, attachmentId: attachment.id });
    });
  /** The only deliverable of a simple card. */
  const primary = async (cardId: string) => {
    const [row] = await db.select({ id: deliverables.id }).from(deliverables).where(eq(deliverables.cardId, cardId));
    return row!.id;
  };

  // ── Studio & membership ──────────────────────────────────────────────────
  const studio = await as("giorgos", T(28), (a) => studios.createStudio(a, { name: "Nightfall Studios", iconEmoji: "🌙" }));
  await as("giorgos", T(28), (a) => studios.updateStudio(a, { studioId: studio.id, slug: "nightfall" }));
  for (const account of DEMO_ACCOUNTS) {
    if (account.username === "giorgos" || account.username === "omar") {
      if (account.username === "giorgos") {
        await db.update(studioMembers).set({ title: account.title }).where(and(eq(studioMembers.studioId, studio.id), eq(studioMembers.userId, u.giorgos!.id)));
      }
      continue;
    }
    await db.insert(studioMembers).values({ studioId: studio.id, userId: u[account.username]!.id, role: account.role, title: account.title, createdAt: T(27) });
    await db.update(users).set({ lastStudioId: studio.id }).where(eq(users.id, u[account.username]!.id));
  }

  // ── Universal Tower Defense ──────────────────────────────────────────────
  const utd = await as("giorgos", T(27), (a) =>
    projects.createProject(a, {
      studioId: studio.id,
      name: "Universal Tower Defense",
      key: "UTD",
      icon: "🗼",
      color: "#a78bfa",
      description: "Anime tower defense — Update 6.0 ships the Jujutsu banner, Infinite Mode and the new battle pass.",
      template: "empty",
    }),
  );
  await as("giorgos", T(27), (a) =>
    projects.updateProject(a, { projectId: utd.id, settings: { defaultReviewerIds: [u.giorgos!.id], allowSelfApproval: false, requireFeedbackForChanges: true } }),
  );
  const columnSpecs = [
    { name: "VFX", icon: "sparkles", color: "#a78bfa", mode: "VISUAL" },
    { name: "Animations", icon: "person-standing", color: "#60a5fa", mode: "VISUAL" },
    { name: "Models", icon: "box", color: "#22d3ee", mode: "VISUAL" },
    { name: "UI", icon: "layout-panel-top", color: "#f472b6", mode: "VISUAL" },
    { name: "Scripting", icon: "code", color: "#34d399", mode: "COMPACT" },
    { name: "Maps", icon: "map", color: "#a3e635", mode: "VISUAL" },
    { name: "Balancing", icon: "scale", color: "#facc15", mode: "COMPACT" },
  ] as const;
  const col: Record<string, string> = {};
  for (const spec of columnSpecs) {
    const created = await as("giorgos", T(27), (a) =>
      board.createColumn(a, { projectId: utd.id, name: spec.name, icon: spec.icon, color: spec.color, defaultCardMode: spec.mode }),
    );
    col[spec.name] = created.id;
  }
  const label: Record<string, string> = {};
  for (const [name, color] of [
    ["Unit", "#a78bfa"],
    ["Mythic", "#facc15"],
    ["Boss", "#f87171"],
    ["Event", "#fb923c"],
    ["Bug", "#ef4444"],
    ["Polish", "#22d3ee"],
    ["Gameplay", "#34d399"],
  ] as const) {
    label[name] = (await as("giorgos", T(27), (a) => labels.createLabel(a, { projectId: utd.id, name, color }))).id;
  }
  const u60 = await as("giorgos", T(27), (a) => labels.createMilestone(a, { projectId: utd.id, name: "Update 6.0", description: "Jujutsu banner, Infinite Mode, Season 6 pass", dueAt: T(-10, 18).toISOString() }));
  const halloween = await as("giorgos", T(27), (a) => labels.createMilestone(a, { projectId: utd.id, name: "Halloween Event", dueAt: T(-25, 18).toISOString() }));
  await as("giorgos", T(27), (a) => labels.createMilestone(a, { projectId: utd.id, name: "Update 6.5", dueAt: T(-45, 18).toISOString() }));

  const card = (username: string, when: Date, input: Omit<cards.CreateCardInput, "projectId">) =>
    as(username, when, (a) => cards.createCard(a, { projectId: utd.id, ...input }));

  // ── Gojo Hollow Purple VFX — two review rounds, changes requested ─────────
  const hp = await card("giorgos", T(9, 9), {
    columnId: col.VFX!,
    title: "Gojo Hollow Purple VFX",
    description:
      "Gojo's **Hollow Purple** for the Mythic unit ultimate.\n\n- Blue (attraction) and red (repulsion) orbs converge\n- Collision flash → purple sphere → beam\n- Must read clearly at 1080p *and* on mobile\n\nReference: https://www.youtube.com/results?search_query=hollow+purple",
    priority: "HIGH",
    dueAt: T(-3, 18).toISOString(),
    milestoneId: u60.id,
    assigneeIds: [u.james!.id],
    labelIds: [label.Unit!, label.Mythic!],
  });
  const hpV1 = await newVersion("james", T(8, 15), hp.id, "hp_v1.mp4", "First pass — timing blocked in, particles are placeholder.");
  await as("james", T(8, 15, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(hp.id) }));
  await as("giorgos", T(7, 11), (a) =>
    comments.createComment(a, { cardId: hp.id, kind: "FEEDBACK", body: "Increase the impact here — the collision needs more weight.", attachmentId: hpV1.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 2620 } }),
  );
  await as("giorgos", T(7, 11, 3), (a) =>
    comments.createComment(a, { cardId: hp.id, kind: "FEEDBACK", body: "Camera shake is too strong, it's hard to read the beam.", attachmentId: hpV1.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 3100 } }),
  );
  await as("giorgos", T(7, 11, 6), async (a) =>
    reviews.requestChanges(a, { deliverableId: await primary(hp.id), note: "Good start. Main issue is readability at the collision.", items: ["Reduce the blue glow on the left orb.", "Increase distortion at the end."] }),
  );
  const hpDetail1 = await as("james", T(7, 12), (a) => cards.getCardDetail(a, hp.id));
  const impactFeedback = hpDetail1.comments.find((c) => c.body.startsWith("Increase the impact"))!;
  await as("james", T(7, 13), (a) => comments.createComment(a, { cardId: hp.id, parentId: impactFeedback.id, body: "On it — pushing the shockwave radius up and adding a white core frame." }));
  await as("giorgos", T(7, 13, 20), (a) => comments.toggleReaction(a, { commentId: impactFeedback.id, emoji: "👍" }));
  const hpV2 = await newVersion("james", T(5, 16), hp.id, "hp_v2.mp4", "Bigger impact, shake reduced ~60%, blue glow toned down.");
  for (const c of hpDetail1.comments.filter((c) => c.kind === "FEEDBACK" && !c.body.startsWith("Increase distortion"))) {
    await as("james", T(5, 16, 10), (a) => comments.setFeedbackResolved(a, { commentId: c.id, resolved: true }));
  }
  await as("james", T(5, 16, 12), async (a) => reviews.submitForReview(a, { deliverableId: await primary(hp.id), note: "Ready for another look!" }));
  await as("giorgos", T(4, 10), (a) =>
    comments.createComment(a, { cardId: hp.id, kind: "FEEDBACK", body: "Much better! The flash still washes out the whole frame — keep it local to the sphere.", attachmentId: hpV2.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 2580 } }),
  );
  await as("giorgos", T(4, 10, 4), async (a) => reviews.requestChanges(a, { deliverableId: await primary(hp.id), items: ["Let the beam linger ~0.3s longer before it fades."] }));
  await as("james", T(4, 11), (a) => comments.createComment(a, { cardId: hp.id, body: "@giorgos should the flash still hit the UI layer or stay world-space only?" }));
  await as("giorgos", T(4, 11, 30), (a) => comments.createComment(a, { cardId: hp.id, body: "World-space only. UI should never flash." }));

  // ── Gojo Ultimate VFX — four versions, approved on V4 ─────────────────────
  const gu = await card("giorgos", T(20), { columnId: col.VFX!, title: "Gojo Ultimate VFX", priority: "NORMAL", milestoneId: u60.id, assigneeIds: [u.james!.id], labelIds: [label.Unit!] });
  const guNotes = ["Initial submission.", "Tighter timing, less shake.", "New sphere shader, beam trail.", "Final polish pass — color graded."];
  const guFeedback = [
    ["Orbs spawn too far apart, the build-up drags.", "Shake is way too strong.", "Glow radius is huge, hides the silhouette.", "Needs a clear impact frame.", "Beam feels thin."],
    ["Better pacing.", "Shake still a bit much at 2s.", "Beam trail should taper."],
    ["Almost there — slightly less bloom.", "Sphere could be 10% bigger.", "Nice beam!"],
  ];
  for (let v = 0; v < 4; v++) {
    const day = 19 - v * 3;
    const version = await newVersion("james", T(day, 14), gu.id, `gu_v${v + 1}.mp4`, guNotes[v]!);
    await as("james", T(day, 14, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(gu.id) }));
    if (v < 3) {
      for (const [i, body] of guFeedback[v]!.entries()) {
        await as("giorgos", T(day - 1, 10, i * 2), (a) =>
          comments.createComment(a, { cardId: gu.id, kind: "FEEDBACK", body, attachmentId: version.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 600 + i * 700 } }),
        );
      }
      await as("giorgos", T(day - 1, 10, 30), async (a) => reviews.requestChanges(a, { deliverableId: await primary(gu.id) }));
      const detail = await as("james", T(day - 1, 15), (a) => cards.getCardDetail(a, gu.id));
      for (const c of detail.comments.filter((c) => c.kind === "FEEDBACK" && !c.resolvedAt)) {
        await as("james", T(day - 1, 15, 5), (a) => comments.setFeedbackResolved(a, { commentId: c.id, resolved: true }));
      }
    } else {
      await as("giorgos", T(day - 1, 9), async (a) => reviews.approve(a, { deliverableId: await primary(gu.id), note: "Ship it. Great iteration on this one." }));
    }
  }

  // ── Sukuna Domain Expansion VFX — waiting for review ──────────────────────
  const sd = await card("giorgos", T(6), { columnId: col.VFX!, title: "Sukuna Domain Expansion VFX", priority: "HIGH", milestoneId: u60.id, assigneeIds: [u.james!.id], labelIds: [label.Boss!] });
  await newVersion("james", T(1, 17), sd.id, "sukuna_domain_v1.mp4", "Malevolent Shrine — slash density ramps over 5s.");
  await as("james", T(1, 17, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(sd.id), note: "Slash count is driven by a curve — easy to tweak." }));

  await card("giorgos", T(3), { columnId: col.VFX!, title: "Kaiju Stomp Impact VFX", dueAt: T(-6, 18).toISOString(), milestoneId: halloween.id, assigneeIds: [u.james!.id], labelIds: [label.Event!] });

  // ── Animations ────────────────────────────────────────────────────────────
  const su = await card("giorgos", T(10), { columnId: col.Animations!, title: "Sukuna Ultimate Animation", priority: "HIGH", milestoneId: u60.id, assigneeIds: [u.alex!.id], labelIds: [label.Unit!] });
  const suV1 = await newVersion("alex", T(3, 14), su.id, "sukuna_ult_v1.mp4", "Ultimate raise + slash windup.");
  await as("alex", T(3, 14, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(su.id) }));
  await as("giorgos", T(2, 10), (a) =>
    comments.createComment(a, { cardId: su.id, kind: "FEEDBACK", body: "The character's arm clips through the weapon here.", attachmentId: suV1.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 2470, x: 0.47, y: 0.42 } }),
  );
  await as("giorgos", T(2, 10, 3), async (a) => reviews.requestChanges(a, { deliverableId: await primary(su.id), items: ["Hold the raised pose 4–5 frames longer before the release."] }));

  const si = await card("giorgos", T(12), { columnId: col.Animations!, title: "Sukuna Idle Animation", milestoneId: u60.id, assigneeIds: [u.alex!.id], labelIds: [label.Unit!] });
  await newVersion("alex", T(4, 11), si.id, "sukuna_idle_v1.mp4", "Loopable idle, 2 breaths per cycle.");
  await as("alex", T(4, 11, 3), async (a) => reviews.submitForReview(a, { deliverableId: await primary(si.id) }));
  await as("giorgos", T(0, 9, 12), async (a) => reviews.approve(a, { deliverableId: await primary(si.id), note: "Loops cleanly 👌" }));

  await card("lena", T(2), { columnId: col.Animations!, title: "Tower Placement Animation", milestoneId: u60.id, assigneeIds: [u.alex!.id], labelIds: [label.Polish!] });

  // ── Models ────────────────────────────────────────────────────────────────
  const unit = await card("giorgos", T(8), { columnId: col.Models!, title: "Sukuna Unit Model", milestoneId: u60.id, assigneeIds: [u.mike!.id], labelIds: [label.Unit!] });
  await newVersion("mike", T(2, 16), unit.id, "sukuna_unit_v1.png", "Rig check in T-pose.");
  await as("mike", T(2, 16, 10), (a) => checklists.createChecklist(a, { cardId: unit.id, title: "Animations", items: ["Idle", "Attack 1", "Attack 2", "Ultimate", "Evolution"] }));
  await as("mike", T(2, 16, 12), (a) => checklists.createChecklist(a, { cardId: unit.id, title: "Model", items: ["Base mesh", "UVs", "Textures", "LODs"] }));
  const unitDetail = await as("mike", T(1, 12), (a) => cards.getCardDetail(a, unit.id));
  for (const item of [...unitDetail.checklists[0]!.items.slice(0, 3), ...unitDetail.checklists[1]!.items.slice(0, 2)]) {
    await as("mike", T(1, 12), (a) => checklists.updateChecklistItem(a, { itemId: item.id, isDone: true }));
  }

  const tower = await card("giorgos", T(7), { columnId: col.Models!, title: "Cursed Shrine Tower Model", milestoneId: u60.id, assigneeIds: [u.mike!.id], labelIds: [label.Boss!] });
  await newVersion("mike", T(1, 10), tower.id, "tower_v1.png", "Turnaround at 3/4 view. 4.8k tris.");
  await as("mike", T(1, 10, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(tower.id) }));

  // ── UI ────────────────────────────────────────────────────────────────────
  const bp = await card("giorgos", T(11), { columnId: col.UI!, title: "Battlepass UI", priority: "HIGH", milestoneId: u60.id, assigneeIds: [u.sofia!.id], labelIds: [label.Event!] });
  const bpV1 = await newVersion("sofia", T(6, 13), bp.id, "battlepass_v1.png", "Season 6 layout, first pass.");
  await as("sofia", T(6, 13, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(bp.id) }));
  await as("giorgos", T(5, 9), (a) =>
    comments.createComment(a, { cardId: bp.id, kind: "FEEDBACK", body: "Increase spacing here — the tier cards feel cramped.", attachmentId: bpV1.attachment.id, annotation: { type: "POINT", x: 0.188, y: 0.5 } }),
  );
  await as("giorgos", T(5, 9, 2), (a) =>
    comments.createComment(a, { cardId: bp.id, kind: "FEEDBACK", body: "Button text overflows — widen the button or shorten the copy.", attachmentId: bpV1.attachment.id, annotation: { type: "POINT", x: 0.91, y: 0.82 } }),
  );
  await as("giorgos", T(5, 9, 3), async (a) => reviews.requestChanges(a, { deliverableId: await primary(bp.id) }));
  const bpDetail = await as("sofia", T(5, 10), (a) => cards.getCardDetail(a, bp.id));
  await as("sofia", T(5, 10), (a) => comments.createComment(a, { cardId: bp.id, parentId: bpDetail.comments.find((c) => c.body.startsWith("Increase spacing"))!.id, body: "Bumping the gap from 12px to 24px across all tiers." }));
  await newVersion("sofia", T(3, 15), bp.id, "battlepass_v2.png", "Spacing fixed, wider premium button.");
  for (const c of bpDetail.comments.filter((c) => c.kind === "FEEDBACK")) {
    await as("sofia", T(3, 15, 3), (a) => comments.setFeedbackResolved(a, { commentId: c.id, resolved: true }));
  }
  await as("sofia", T(3, 15, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(bp.id) }));
  await as("giorgos", T(0, 8, 45), async (a) => reviews.approve(a, { deliverableId: await primary(bp.id), note: "Looks great." }));

  const shop = await card("lena", T(5), { columnId: col.UI!, title: "Shop UI Redesign", milestoneId: u60.id, assigneeIds: [u.sofia!.id], labelIds: [label.Polish!] });
  await as("lena", T(5), (a) => cards.setReviewers(a, { cardId: shop.id, add: [u.lena!.id] }));
  await newVersion("sofia", T(0, 9, 30), shop.id, "shop_v1.png", "Grid layout with featured row.");
  await as("sofia", T(0, 9, 35), async (a) => reviews.submitForReview(a, { deliverableId: await primary(shop.id) }));

  await card("giorgos", T(1), { columnId: col.UI!, title: "Daily Rewards Popup", milestoneId: halloween.id, assigneeIds: [u.sofia!.id], priority: "LOW" });

  // ── Scripting ─────────────────────────────────────────────────────────────
  const trading = await card("giorgos", T(14), {
    columnId: col.Scripting!,
    title: "Trading System",
    description: "Player-to-player unit trading with escrow.\n\n- Both players must confirm twice\n- Server validates ownership on every step\n- Every trade is written to an audit log",
    priority: "HIGH",
    milestoneId: u60.id,
    assigneeIds: [u.kenji!.id, u.giorgos!.id],
    labelIds: [label.Gameplay!],
  });
  await as("kenji", T(13), (a) => checklists.createChecklist(a, { cardId: trading.id, title: "Implementation", items: ["Trade request remote", "Escrow validation", "Anti-dupe checks", "DataStore write", "Audit logging"] }));
  const tradingDetail = await as("kenji", T(9), (a) => cards.getCardDetail(a, trading.id));
  for (const item of tradingDetail.checklists[0]!.items.slice(0, 2)) {
    await as("kenji", T(9), (a) => checklists.updateChecklistItem(a, { itemId: item.id, isDone: true }));
  }
  await as("kenji", T(9, 12), (a) => reviews.setCardState(a, { cardId: trading.id, state: "IN_PROGRESS" }));
  await as("kenji", T(6, 14), (a) => comments.createComment(a, { cardId: trading.id, body: "Escrow is in. Should we lock trading during raids?" }));
  await as("giorgos", T(6, 15), (a) => comments.createComment(a, { cardId: trading.id, body: "Yes — disable trade requests while a match is active." }));
  await as("lena", T(2, 11), (a) => comments.createComment(a, { cardId: trading.id, body: "@kenji can we get this into the Update 6.0 build by Friday?" }));

  const infinite = await card("giorgos", T(10), { columnId: col.Scripting!, title: "Infinite Mode", description: "Endless waves with scaling modifiers every 10 waves. Leaderboard resets weekly.", milestoneId: u60.id, assigneeIds: [u.kenji!.id], labelIds: [label.Gameplay!] });
  await as("kenji", T(1, 18), async (a) => reviews.submitForReview(a, { deliverableId: await primary(infinite.id), note: "Branch: feature/infinite-mode — test place is up." }));

  const exploit = await card("lena", T(3), { columnId: col.Scripting!, title: "Fix unit stacking exploit", priority: "URGENT", milestoneId: u60.id, assigneeIds: [u.kenji!.id], labelIds: [label.Bug!] });
  await as("kenji", T(2, 12), async (a) => reviews.submitForReview(a, { deliverableId: await primary(exploit.id) }));
  await as("giorgos", T(1, 9), async (a) => reviews.requestChanges(a, { deliverableId: await primary(exploit.id), items: ["Still reproducible when placing during the wave transition.", "Add a server-side placement cooldown check."] }));

  const datastore = await card("giorgos", T(16), { columnId: col.Scripting!, title: "DataStore session locking", milestoneId: u60.id, assigneeIds: [u.kenji!.id] });
  await as("kenji", T(11), async (a) => reviews.submitForReview(a, { deliverableId: await primary(datastore.id) }));
  await as("giorgos", T(10), async (a) => reviews.approve(a, { deliverableId: await primary(datastore.id) }));

  // ── Maps ──────────────────────────────────────────────────────────────────
  const lobby = await card("giorgos", T(6), { columnId: col.Maps!, title: "Lobby Map Update", milestoneId: u60.id, assigneeIds: [u.mike!.id] });
  await newVersion("mike", T(1, 15), lobby.id, "lobby_v1.png", "New plaza layout with four portals.");
  await card("giorgos", T(2), { columnId: col.Maps!, title: "Halloween Event Map", dueAt: T(-5, 18).toISOString(), milestoneId: halloween.id, assigneeIds: [u.mike!.id], labelIds: [label.Event!] });

  // ── Balancing ─────────────────────────────────────────────────────────────
  const gb = await card("giorgos", T(4), {
    columnId: col.Balancing!,
    title: "Gojo Balance Changes",
    description: "Gojo is at 71% pick rate in wave 30+. Target ~45%.",
    dueAt: T(0, 20).toISOString(),
    milestoneId: u60.id,
    assigneeIds: [u.kenji!.id],
    labelIds: [label.Unit!],
  });
  await as("kenji", T(3), (a) => checklists.createChecklist(a, { cardId: gb.id, title: "Changes", items: ["Ultimate cooldown 18s → 22s", "Infinity range -10%", "Retest wave 40 clear rate"] }));
  await as("kenji", T(3), (a) => reviews.setCardState(a, { cardId: gb.id, state: "IN_PROGRESS" }));
  const waves = await card("lena", T(9), { columnId: col.Balancing!, title: "Wave 40–60 Difficulty Pass", priority: "HIGH", dueAt: T(2, 18).toISOString(), milestoneId: u60.id, assigneeIds: [u.kenji!.id] });
  await as("kenji", T(5), (a) => reviews.setCardState(a, { cardId: waves.id, state: "IN_PROGRESS" }));
  await card("lena", T(1), { columnId: col.Balancing!, title: "Mythic unit drop rates", priority: "LOW", milestoneId: halloween.id });

  // ── Shrine Guardian boss kit — one card, several connected deliverables ───
  const kit = await card("giorgos", T(9, 10), {
    columnId: col.Models!,
    title: "Shrine Guardian Boss Kit",
    description:
      "Everything the Halloween boss needs to ship. The rig drives the slash animation; the VFX and SFX are timed to the animation's **Hit** marker.\n\nOpen a deliverable to review its files — each one has its own revisions and feedback.",
    priority: "HIGH",
    dueAt: T(-8, 18).toISOString(),
    milestoneId: halloween.id,
    assigneeIds: [u.mike!.id, u.alex!.id, u.james!.id],
    labelIds: [label.Boss!, label.Event!],
  });
  const rigD = await primary(kit.id);
  await as("giorgos", T(9, 10, 1), (a) => deliverableService.updateDeliverable(a, { deliverableId: rigD, name: "Guardian rig", assetType: "Rig", ownerId: u.mike!.id }));
  const addDeliverable = async (when: Date, input: Omit<Parameters<typeof deliverableService.createDeliverable>[1], "cardId">) => {
    const detail = await as("giorgos", when, (a) => deliverableService.createDeliverable(a, { cardId: kit.id, ...input }));
    return detail.deliverables.find((d) => d.name === input.name)!.id;
  };
  const animD = await addDeliverable(T(9, 10, 2), { name: "Cursed Slash animation", assetType: "Animation", ownerId: u.alex!.id, canvasX: 320, canvasY: 0, linkFrom: { id: rigD, type: "DEPENDENCY" } });
  const vfxD = await addDeliverable(T(9, 10, 3), { name: "Cursed energy burst VFX", assetType: "VFX", ownerId: u.james!.id, canvasX: 640, canvasY: -60, linkFrom: { id: animD, type: "DEPENDENCY" } });
  const sfxD = await addDeliverable(T(9, 10, 4), { name: "Slash SFX", assetType: "Audio", ownerId: u.alex!.id, canvasX: 640, canvasY: 170, linkFrom: { id: animD, type: "DEPENDENCY" } });
  const ambD = await addDeliverable(T(9, 10, 5), { name: "Shrine ambience loop", assetType: "Audio", required: false, canvasX: 960, canvasY: 170 });
  const propD = await addDeliverable(T(9, 10, 6), { name: "Shrine tower prop", assetType: "Model", ownerId: u.mike!.id, canvasX: 0, canvasY: 230 });
  await as("giorgos", T(9, 10, 8), (a) => deliverableService.linkDeliverables(a, { cardId: kit.id, fromId: sfxD, toId: vfxD, type: "ASSOCIATION", note: "Burst and impact sound fire on the same frame." }));
  await as("giorgos", T(9, 10, 9), (a) => deliverableService.linkDeliverables(a, { cardId: kit.id, fromId: propD, toId: vfxD, type: "ASSOCIATION", note: "The burst spawns at the shrine orb." }));
  await as("giorgos", T(9, 10, 10), (a) => deliverableService.linkDeliverables(a, { cardId: kit.id, fromId: ambD, toId: propD, type: "ASSOCIATION" }));

  // Rig: approved first — the animation depends on it.
  const rigV1 = await newRevision("mike", T(8, 11), kit.id, rigD, "guardian_rig.rbxm", "R6 rig with Motor6D joints + an idle in AnimSaves.");
  await provideResource("mike", T(8, 11, 5), kit.id, RESOURCE_IDS.face, "texture", "tex_face.png");
  await as("mike", T(8, 11, 10), async (a) => reviews.submitForReview(a, { deliverableId: rigD }));
  await as("giorgos", T(7, 10), async (a) => reviews.approve(a, { deliverableId: rigD, note: "Joint pivots look right." }));

  // Animation: changes requested on V1 (timestamped on the animation timeline), V2 waiting for review.
  const animV1 = await newRevision("alex", T(6, 14), kit.id, animD, "cursed_slash_v1.rbxm", "Windup → slash → recover, 1.4s.");
  await as("alex", T(6, 14, 2), (a) => roblox.setPreviewConfig(a, { attachmentId: animV1.attachment.id, rigAttachmentId: rigV1.attachment.id }));
  await as("alex", T(6, 14, 5), async (a) => reviews.submitForReview(a, { deliverableId: animD }));
  await as("giorgos", T(5, 11), (a) =>
    comments.createComment(a, { cardId: kit.id, kind: "FEEDBACK", body: "The slash lands too early — hold the windup a few frames longer.", attachmentId: animV1.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 550 } }),
  );
  await as("giorgos", T(5, 11, 2), (a) =>
    comments.createComment(a, { cardId: kit.id, kind: "FEEDBACK", body: "Follow-through snaps back; ease it out.", attachmentId: animV1.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 820 } }),
  );
  await as("giorgos", T(5, 11, 4), async (a) => reviews.requestChanges(a, { deliverableId: animD, note: "Timing pass needed before VFX/SFX can sync." }));
  const animV2 = await newRevision("alex", T(2, 15), kit.id, animD, "cursed_slash_v2.rbxm", "Longer windup, elastic follow-through, 1.6s.");
  await as("alex", T(2, 15, 2), (a) => roblox.setPreviewConfig(a, { attachmentId: animV2.attachment.id, rigAttachmentId: rigV1.attachment.id }));
  const animDetail = await as("alex", T(2, 15, 3), (a) => cards.getCardDetail(a, kit.id));
  for (const c of animDetail.comments.filter((c) => c.deliverableId === animD && c.kind === "FEEDBACK")) {
    await as("alex", T(2, 15, 4), (a) => comments.setFeedbackResolved(a, { commentId: c.id, resolved: true }));
  }
  await as("alex", T(2, 15, 6), async (a) => reviews.submitForReview(a, { deliverableId: animD, note: "Hit marker moved to 0.58s." }));

  // VFX: uploaded, most textures provided, not submitted yet.
  await newRevision("james", T(1, 16), kit.id, vfxD, "cursed_burst_vfx.rbxm", "Core glow, sparks, shockwave + flipbook burst, tether beam, blade trail.");
  await provideResource("james", T(1, 16, 5), kit.id, RESOURCE_IDS.sparks, "texture", "tex_sparks.png");
  await provideResource("james", T(1, 16, 6), kit.id, RESOURCE_IDS.ring, "texture", "tex_ring.png");
  await provideResource("james", T(1, 16, 7), kit.id, RESOURCE_IDS.burstSheet, "texture", "tex_burst_sheet.png");
  await provideResource("james", T(1, 16, 8), kit.id, RESOURCE_IDS.beam, "texture", "tex_beam.png");
  await as("james", T(1, 16, 20), (a) =>
    comments.createComment(a, { cardId: kit.id, deliverableId: vfxD, body: "Shockwave and burst are EmitCount emitters — use Emit in the preview. Core glow texture still needs uploading." }),
  );

  // SFX: timestamp feedback on V1, V2 waiting for review.
  const sfxV1 = await newRevision("alex", T(3, 12), kit.id, sfxD, "slash_sfx_v1.mp3", "Whoosh + low impact.");
  await as("alex", T(3, 12, 5), async (a) => reviews.submitForReview(a, { deliverableId: sfxD }));
  await as("giorgos", T(2, 10), (a) =>
    comments.createComment(a, { cardId: kit.id, kind: "FEEDBACK", body: "Impact hits ~60 ms after the animation's Hit marker — pull it earlier.", attachmentId: sfxV1.attachment.id, annotation: { type: "TIMESTAMP", timestampMs: 520 } }),
  );
  await as("giorgos", T(2, 10, 3), async (a) => reviews.requestChanges(a, { deliverableId: sfxD }));
  await newRevision("alex", T(1, 11), kit.id, sfxD, "slash_sfx_v2.mp3", "Impact moved to 0.46s, longer tail.");
  await as("alex", T(1, 11, 4), async (a) => reviews.submitForReview(a, { deliverableId: sfxD }));

  // Ambience (optional) approved; tower prop approved with its crystal mesh + sigil provided.
  await newRevision("alex", T(5, 10), kit.id, ambD, "shrine_ambience.ogg", "8s seamless loop.");
  await as("alex", T(5, 10, 3), async (a) => reviews.submitForReview(a, { deliverableId: ambD }));
  await as("giorgos", T(4, 9), async (a) => reviews.approve(a, { deliverableId: ambD }));
  await newRevision("mike", T(4, 15), kit.id, propD, "shrine_tower.rbxm", "Blockout with neon rings, crystal and orb light.");
  await provideResource("mike", T(4, 15, 4), kit.id, RESOURCE_IDS.crystalMesh, "mesh", "crystal.obj");
  await provideResource("mike", T(4, 15, 5), kit.id, RESOURCE_IDS.sigil, "texture", "tex_sigil.png");
  await as("mike", T(4, 15, 8), async (a) => reviews.submitForReview(a, { deliverableId: propD }));
  await as("giorgos", T(3, 9), async (a) => reviews.approve(a, { deliverableId: propD, note: "Skull ornament mesh can come later." }));
  await as("lena", T(1, 9), (a) => comments.createComment(a, { cardId: kit.id, body: "@alex @james let's lock the slash timing first — VFX and SFX both sync to the Hit marker." }));

  // ── Production stages: completion follows approvals; Published is tracking only ─
  await as("kenji", T(9, 12), (a) => production.moveProduction(a, { cardId: datastore.id, status: "COMPLETED" }));
  await as("giorgos", T(1, 10), (a) => production.moveProduction(a, { cardId: gu.id, status: "PUBLISHED", note: "Live since the 5.9 hotfix." }));
  await as("giorgos", T(0, 9, 20), (a) => production.moveProduction(a, { cardId: si.id, status: "COMPLETED" }));
  await as("giorgos", T(0, 8, 50), (a) => production.moveProduction(a, { cardId: bp.id, status: "PUBLISHED", note: "Season 6 pass is live." }));
  // A revision after publication: the published record (V2) stays; V3 shows as a pending change.
  await newVersion("sofia", T(0, 9, 40), bp.id, "battlepass_v3.png", "Premium banner glow tweak for the mid-season refresh.");

  // ── One Piece RPG ─────────────────────────────────────────────────────────
  const opr = await as("giorgos", T(20), (a) =>
    projects.createProject(a, { studioId: studio.id, name: "One Piece RPG", key: "OPR", icon: "🏴‍☠️", color: "#60a5fa", description: "Open-world pirate RPG.", template: "roblox" }),
  );
  const oprBoard = await as("giorgos", T(20), (a) => board.getBoard(a, opr.id));
  const oc = Object.fromEntries(oprBoard.columns.map((c) => [c.name, c.id]));
  const gear5 = await as("giorgos", T(6), (a) => cards.createCard(a, { projectId: opr.id, columnId: oc.VFX!, title: "Gear 5 Transformation VFX", assigneeIds: [u.james!.id], priority: "HIGH" }));
  await newVersion("james", T(2, 12), gear5.id, "gear5_thumb.png", "Key frame for the transformation.");
  await as("james", T(2, 12, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(gear5.id) }));
  await as("giorgos", T(12), (a) => cards.createCard(a, { projectId: opr.id, columnId: oc.Scripting!, title: "Devil Fruit Inventory", assigneeIds: [u.kenji!.id] }));
  const marine = await as("giorgos", T(9), (a) => cards.createCard(a, { projectId: opr.id, columnId: oc.Maps!, title: "Marineford Map Blockout", assigneeIds: [u.mike!.id] }));
  await newVersion("mike", T(4, 10), marine.id, "marineford.png", "Greybox blockout.");
  const thumb = await as("giorgos", T(15), (a) => cards.createCard(a, { projectId: opr.id, columnId: oc.Marketing!, title: "Game Thumbnail — Update 2", assigneeIds: [u.sofia!.id] }));
  await newVersion("sofia", T(12, 10), thumb.id, "opr_thumb.png", "Final thumbnail.");
  await as("sofia", T(12, 10, 5), async (a) => reviews.submitForReview(a, { deliverableId: await primary(thumb.id) }));
  await as("giorgos", T(11), async (a) => reviews.approve(a, { deliverableId: await primary(thumb.id) }));
  await as("giorgos", T(10), (a) => production.moveProduction(a, { cardId: thumb.id, status: "PUBLISHED" }));

  // ── Prototype Project ─────────────────────────────────────────────────────
  const proto = await as("giorgos", T(5), (a) =>
    projects.createProject(a, { studioId: studio.id, name: "Prototype Project", key: "PP", icon: "🧪", color: "#34d399", description: "Quick experiments before greenlighting.", template: "empty" }),
  );
  const ideas = await as("giorgos", T(5), (a) => board.createColumn(a, { projectId: proto.id, name: "Ideas", icon: "flask-conical", color: "#34d399", defaultCardMode: "COMPACT" }));
  const testing = await as("giorgos", T(5), (a) => board.createColumn(a, { projectId: proto.id, name: "Playtesting", icon: "gamepad-2", color: "#60a5fa", defaultCardMode: "COMPACT" }));
  await as("giorgos", T(5), (a) => cards.createCard(a, { projectId: proto.id, columnId: ideas.id, title: "Co-op boss raid prototype" }));
  await as("giorgos", T(4), (a) => cards.createCard(a, { projectId: proto.id, columnId: testing.id, title: "Movement feel test (dash + double jump)", assigneeIds: [u.kenji!.id] }));

  // ── Second studio (isolation demo) ────────────────────────────────────────
  const ember = await as("omar", T(15), (a) => studios.createStudio(a, { name: "Emberlight Games", iconEmoji: "🔥" }));
  await as("omar", T(15), (a) => studios.updateStudio(a, { studioId: ember.id, slug: "emberlight" }));
  const sky = await as("omar", T(15), (a) =>
    projects.createProject(a, { studioId: ember.id, name: "Skyforge Tycoon", key: "SKY", icon: "☁️", color: "#22d3ee", template: "roblox" }),
  );
  const skyBoard = await as("omar", T(15), (a) => board.getBoard(a, sky.id));
  const skyUi = await as("omar", T(10), (a) => cards.createCard(a, { projectId: sky.id, columnId: skyBoard.columns.find((c) => c.name === "UI")!.id, title: "Airship Dock UI", assigneeIds: [u.omar!.id] }));
  await newVersion("omar", T(9), skyUi.id, "skyforge_ui.png", "Dock screen");
  await as("omar", T(8), (a) => cards.createCard(a, { projectId: sky.id, columnId: skyBoard.columns.find((c) => c.name === "Maps")!.id, title: "Cloud Island Map" }));

  // ── Read state: older notifications read, some cards recently viewed ──────
  pinClock(null);
  await db.update(notifications).set({ readAt: T(0, 7) }).where(lt(notifications.createdAt, T(2, 0)));
  const viewedByGiorgos = [gu.id, datastore.id, trading.id, lobby.id, si.id, bp.id];
  await db.insert(cardViews).values(viewedByGiorgos.map((cardId, i) => ({ userId: u.giorgos!.id, cardId, lastViewedAt: T(0, 9 - i) }))).onConflictDoNothing();
  const viewedByJames = [hp.id, gu.id, sd.id];
  await db.insert(cardViews).values(viewedByJames.map((cardId, i) => ({ userId: u.james!.id, cardId, lastViewedAt: T(3, 12 - i) }))).onConflictDoNothing();
  await db.update(users).set({ lastStudioId: studio.id }).where(inArray(users.id, Object.values(u).map((x) => x.id).filter((id) => id !== u.omar!.id)));
  await db.update(users).set({ lastStudioId: ember.id }).where(eq(users.id, u.omar!.id));

  log("Waiting for background media processing (video previews, audio waveforms, Roblox manifests) …");
  await mediaQueue.onIdle();
  log(`Seed complete. Sign in as giorgos@nightfall.gg / ${DEMO_PASSWORD} (or any demo account).`);
}
