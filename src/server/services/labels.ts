import { and, asc, eq, max } from "drizzle-orm";
import type { LabelDTO, MilestoneDTO } from "@/lib/types";
import { requireProject } from "../access";
import { now } from "../clock";
import { db } from "../db";
import { labels, milestones } from "../db/schema";
import { invalid, isUniqueViolation, notFound } from "../errors";
import { milestoneToDTO } from "./board";
import type { Actor } from "./context";
import { Effects } from "./effects";

// ── Labels ──────────────────────────────────────────────────────────────────

export async function createLabel(actor: Actor, input: { projectId: string; name: string; color: string }): Promise<LabelDTO> {
  await requireProject(actor.userId, input.projectId, "label.manage");
  try {
    const [row] = await db.insert(labels).values({ projectId: input.projectId, name: input.name.trim(), color: input.color }).returning();
    new Effects().project(input.projectId).flush(actor.clientId);
    return { id: row!.id, name: row!.name, color: row!.color };
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid(`A label called "${input.name.trim()}" already exists.`);
    throw error;
  }
}

async function loadLabel(labelId: string) {
  const [label] = await db.select().from(labels).where(eq(labels.id, labelId));
  if (!label) throw notFound("Label");
  return label;
}

export async function updateLabel(actor: Actor, input: { labelId: string; name?: string; color?: string }): Promise<LabelDTO> {
  const label = await loadLabel(input.labelId);
  await requireProject(actor.userId, label.projectId, "label.manage");
  try {
    const [row] = await db
      .update(labels)
      .set({ ...(input.name ? { name: input.name.trim() } : {}), ...(input.color ? { color: input.color } : {}) })
      .where(eq(labels.id, label.id))
      .returning();
    new Effects().project(label.projectId).flush(actor.clientId);
    return { id: row!.id, name: row!.name, color: row!.color };
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid("Another label already uses that name.");
    throw error;
  }
}

export async function deleteLabel(actor: Actor, input: { labelId: string }) {
  const label = await loadLabel(input.labelId);
  await requireProject(actor.userId, label.projectId, "label.manage");
  await db.delete(labels).where(eq(labels.id, label.id));
  new Effects().project(label.projectId).flush(actor.clientId);
  return { ok: true };
}

// ── Milestones ──────────────────────────────────────────────────────────────

export async function listMilestones(actor: Actor, projectId: string): Promise<MilestoneDTO[]> {
  await requireProject(actor.userId, projectId, "project.view");
  const rows = await db.select().from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.position));
  return rows.map(milestoneToDTO);
}

export async function createMilestone(
  actor: Actor,
  input: { projectId: string; name: string; description?: string; dueAt?: string | null },
): Promise<MilestoneDTO> {
  await requireProject(actor.userId, input.projectId, "milestone.manage");
  const [agg] = await db.select({ value: max(milestones.position) }).from(milestones).where(eq(milestones.projectId, input.projectId));
  const [row] = await db
    .insert(milestones)
    .values({
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      position: (agg?.value ?? 0) + 1024,
    })
    .returning();
  new Effects().project(input.projectId).flush(actor.clientId);
  return milestoneToDTO(row!);
}

export async function updateMilestone(
  actor: Actor,
  input: {
    milestoneId: string;
    name?: string;
    description?: string;
    dueAt?: string | null;
    released?: boolean;
    archived?: boolean;
  },
): Promise<MilestoneDTO> {
  const [milestone] = await db.select().from(milestones).where(eq(milestones.id, input.milestoneId));
  if (!milestone) throw notFound("Milestone");
  await requireProject(actor.userId, milestone.projectId, "milestone.manage");
  const patch: Partial<typeof milestones.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description.trim();
  if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
  if (input.released !== undefined) patch.releasedAt = input.released ? now() : null;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? now() : null;
  const [row] = await db.update(milestones).set(patch).where(and(eq(milestones.id, milestone.id))).returning();
  new Effects().project(milestone.projectId).flush(actor.clientId);
  return milestoneToDTO(row!);
}
