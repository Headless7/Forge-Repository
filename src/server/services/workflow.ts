/**
 * Routing rules for production notifications: who works on each deliverable, and how a change
 * ripples through dependencies. Dependency rules follow `blockedBy`: a deliverable waits while
 * any active prerequisite isn't approved.
 */
import { eq } from "drizzle-orm";
import { blockedBy, deliverableTeam } from "@/lib/deliverables";
import { loadContributors } from "../access";
import type { Executor } from "../db";
import { cardAssignees, deliverableLinks, deliverables } from "../db/schema";
import type { NotificationBatch } from "./notifications";

export async function cardAssigneeIds(ex: Executor, cardId: string): Promise<string[]> {
  return (await ex.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, cardId))).map((r) => r.userId);
}

export interface CardWork {
  /** Active and archived deliverables of the card. */
  deliverables: Array<{ id: string; number: number; name: string; state: string; archived: boolean; dueAt: Date | null; ownerId: string | null; reviewerId: string | null }>;
  /** Who works on each deliverable (its own team, or the card's assignees when it inherits). */
  teams: Map<string, { ids: string[]; inherited: boolean }>;
  /** For each active deliverable, the unapproved prerequisites it waits on. */
  blocked: Map<string, string[]>;
  assigneeIds: string[];
}

export async function loadCardWork(ex: Executor, cardId: string): Promise<CardWork> {
  const [rows, links, assigneeIds] = await Promise.all([
    ex.select().from(deliverables).where(eq(deliverables.cardId, cardId)),
    ex.select().from(deliverableLinks).where(eq(deliverableLinks.cardId, cardId)),
    cardAssigneeIds(ex, cardId),
  ]);
  const contributors = await loadContributors(ex, rows.map((r) => r.id));
  const list = rows.map((r) => ({ id: r.id, number: r.number, name: r.name, state: r.state, archived: Boolean(r.archivedAt), dueAt: r.dueAt, ownerId: r.ownerId, reviewerId: r.reviewerId }));
  const teams = new Map(rows.map((r) => [r.id, deliverableTeam({ ownerId: r.ownerId, contributorIds: contributors.get(r.id) ?? [] }, assigneeIds)]));
  const blocked = blockedBy(
    rows.map((r) => ({ id: r.id, state: r.state, archived: Boolean(r.archivedAt) })),
    links.map((l) => ({ fromId: l.fromId, toId: l.toId, type: l.type })),
  );
  return { deliverables: list, teams, blocked, assigneeIds };
}

export interface DependencyChange {
  deliverableId: string;
  kind: "UNBLOCKED" | "BLOCKED" | "PREREQUISITE_APPROVED";
  prerequisiteId: string;
  remaining: number;
}

/**
 * Compares the card before and after a change. `approvedId`: the deliverable just approved, to
 * tell "one prerequisite approved, more remain" from "all prerequisites satisfied".
 */
export function dependencyChanges(before: CardWork, after: CardWork, approvedId?: string, ignore: string[] = []): DependencyChange[] {
  const changes: DependencyChange[] = [];
  for (const d of after.deliverables) {
    if (d.archived || ignore.includes(d.id)) continue;
    const was = before.blocked.get(d.id) ?? [];
    const now = after.blocked.get(d.id) ?? [];
    if (was.length && !now.length) {
      changes.push({ deliverableId: d.id, kind: "UNBLOCKED", prerequisiteId: approvedId && was.includes(approvedId) ? approvedId : was[0]!, remaining: 0 });
    } else if (!was.length && now.length) {
      changes.push({ deliverableId: d.id, kind: "BLOCKED", prerequisiteId: now.find((id) => !was.includes(id)) ?? now[0]!, remaining: now.length });
    } else if (approvedId && was.includes(approvedId) && !now.includes(approvedId) && now.length) {
      changes.push({ deliverableId: d.id, kind: "PREREQUISITE_APPROVED", prerequisiteId: approvedId, remaining: now.length });
    }
  }
  return changes;
}

/** Tells the people working on each affected deliverable. */
export function addDependencyNotifications(
  batch: NotificationBatch,
  after: CardWork,
  changes: DependencyChange[],
  base: { actorId: string | null; studioId: string; projectId: string; cardId: string; cardData: Record<string, unknown> },
) {
  const byId = new Map(after.deliverables.map((d) => [d.id, d]));
  const multi = after.deliverables.filter((d) => !d.archived).length > 1;
  for (const change of changes) {
    const d = byId.get(change.deliverableId);
    const prerequisite = byId.get(change.prerequisiteId);
    if (!d) continue;
    batch.add(
      {
      recipientIds: after.teams.get(d.id)?.ids ?? [],
      actorId: base.actorId,
      type: change.kind,
      studioId: base.studioId,
      projectId: base.projectId,
      cardId: base.cardId,
      deliverableId: d.id,
      data: {
        ...base.cardData,
        deliverable: multi ? d.name : undefined,
        deliverableNumber: d.number,
        prerequisite: prerequisite ? `${prerequisite.name}` : undefined,
        remaining: change.remaining,
      },
      },
      { separate: true },
    );
  }
}
