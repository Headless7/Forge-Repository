import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Role } from "@/lib/permissions";
import { db } from "@/server/db";
import { generateToken, hashToken } from "@/server/auth/crypto";
import { attachments, deliverables, invitations, studioMembers, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import * as board from "@/server/services/board";
import type { Actor } from "@/server/services/context";
import * as media from "@/server/services/media";
import * as projects from "@/server/services/projects";
import * as studios from "@/server/services/studios";
import { storage } from "@/server/storage";

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface TestUser {
  id: string;
  username: string;
  email: string;
  actor: Actor;
}

export async function createUser(name: string): Promise<TestUser> {
  const tag = uid();
  const username = `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}_${tag}`.slice(0, 24);
  const email = `${username}@test.dev`;
  const [row] = await db.insert(users).values({ email, username, displayName: name, emailVerifiedAt: new Date() }).returning();
  return { id: row!.id, username, email, actor: { userId: row!.id } };
}

/** A pending invitation for `email` (Forge sign-up needs one), returning its token. */
export async function pendingInvite(email: string): Promise<string> {
  const inviter = await createUser("Inviter");
  const studio = await studios.provisionStudio(inviter.actor, { name: `Invites ${uid()}` });
  const token = generateToken();
  await db.insert(invitations).values({
    studioId: studio.id,
    email: email.toLowerCase(),
    role: "MEMBER",
    tokenHash: hashToken(token),
    invitedById: inviter.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return token;
}

export interface Fixture {
  owner: TestUser;
  admin: TestUser;
  manager: TestUser;
  member: TestUser;
  member2: TestUser;
  viewer: TestUser;
  outsider: TestUser;
  studioId: string;
  otherStudioId: string;
  projectId: string;
  otherProjectId: string;
  columns: { vfx: string; ui: string };
  otherColumnId: string;
}

/** A studio with one member per role, a project with two columns, and a separate studio for isolation tests. */
export async function setupStudio(): Promise<Fixture> {
  const [owner, admin, manager, member, member2, viewer, outsider] = await Promise.all([
    createUser("Owner"),
    createUser("Admin"),
    createUser("Manager"),
    createUser("Member"),
    createUser("Member Two"),
    createUser("Viewer"),
    createUser("Outsider"),
  ]);
  const studio = await studios.provisionStudio(owner.actor, { name: `Studio ${uid()}` });
  const roles: Array<[TestUser, Role]> = [
    [admin, "ADMIN"],
    [manager, "MANAGER"],
    [member, "MEMBER"],
    [member2, "MEMBER"],
    [viewer, "VIEWER"],
  ];
  for (const [user, role] of roles) await db.insert(studioMembers).values({ studioId: studio.id, userId: user.id, role });
  const project = await projects.createProject(owner.actor, { studioId: studio.id, name: `Project ${uid()}`, template: "empty" });
  const vfx = await board.createColumn(owner.actor, { projectId: project.id, name: "VFX", defaultCardMode: "VISUAL" });
  const ui = await board.createColumn(owner.actor, { projectId: project.id, name: "UI" });

  const other = await studios.provisionStudio(outsider.actor, { name: `Other ${uid()}` });
  const otherProject = await projects.createProject(outsider.actor, { studioId: other.id, name: `Other ${uid()}`, template: "empty" });
  const otherColumn = await board.createColumn(outsider.actor, { projectId: otherProject.id, name: "Backlog" });

  return {
    owner,
    admin,
    manager,
    member,
    member2,
    viewer,
    outsider,
    studioId: studio.id,
    otherStudioId: other.id,
    projectId: project.id,
    otherProjectId: otherProject.id,
    columns: { vfx: vfx.id, ui: ui.id },
    otherColumnId: otherColumn.id,
  };
}

/** The deliverable every card starts with. */
export async function primaryDeliverable(cardId: string): Promise<string> {
  const rows = await db.select({ id: deliverables.id }).from(deliverables).where(eq(deliverables.cardId, cardId)).orderBy(deliverables.number);
  return rows[0]!.id;
}

export async function expectAppError(promise: Promise<unknown>, code: AppError["code"]) {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

export async function pngBuffer(width = 320, height = 180, color = "#7c6cf2") {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

const FIXTURES = path.resolve(".data/test-fixtures");

/** A short H.264 clip (generated once, cached). */
export function mp4Buffer(seconds = 2): Buffer {
  const file = path.join(FIXTURES, `clip-${seconds}s.mp4`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    const result = spawnSync(ffmpegPath!, ["-y", "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=24`, "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("ffmpeg failed to create the test clip");
  }
  return fs.readFileSync(file);
}

/** Runs the real upload lifecycle: create intent → write object → complete. */
export async function upload(
  actor: Actor,
  cardId: string,
  file: { name: string; type: string; buffer: Buffer },
  purpose: "version" | "attachment" | "comment" | "resource" | "cover" = "attachment",
  versionId?: string,
  deliverableId?: string,
) {
  const intent = await media.createUpload(actor, { cardId, filename: file.name, size: file.buffer.length, contentType: file.type, purpose, versionId, deliverableId });
  const [row] = await db.select().from(attachments).where(eq(attachments.id, intent.attachmentId));
  await storage().put(row!.storageKey, file.buffer, file.type);
  return media.completeUpload(actor, { attachmentId: intent.attachmentId });
}
