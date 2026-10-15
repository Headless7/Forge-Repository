/**
 * Deliverable rules shared by the server (enforcement) and the UI (explanations).
 * A card's review state, readiness and progress are all derived from its deliverables.
 */
import { roleHas, type CardPermissions } from "./permissions";
import type {
  CardState,
  DeliverableLinkType,
  DeliverablePermissions,
  DeliverableProgressDTO,
  ProductionSnapshotEntry,
  ReadinessDTO,
} from "./types";

export interface DeliverableFacts {
  id: string;
  name: string;
  state: CardState;
  required: boolean;
  archived: boolean;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  hasFiles: boolean;
  versionCount: number;
}

export interface LinkFacts {
  fromId: string;
  toId: string;
  type: DeliverableLinkType;
}

/** The deliverables that count toward completion: required ones, or all when none are marked required. */
export function countedDeliverables<T extends Pick<DeliverableFacts, "required" | "archived">>(items: T[]): T[] {
  const active = items.filter((d) => !d.archived);
  const required = active.filter((d) => d.required);
  return required.length ? required : active;
}

/** Card-level review state: what needs attention first. */
export function rollupState(items: Array<Pick<DeliverableFacts, "state" | "required" | "archived">>): CardState {
  const active = items.filter((d) => !d.archived);
  if (!active.length) return "NOT_SUBMITTED";
  if (active.some((d) => d.state === "NEEDS_REVIEW")) return "NEEDS_REVIEW";
  if (active.some((d) => d.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (countedDeliverables(active).every((d) => d.state === "APPROVED")) return "APPROVED";
  if (active.some((d) => d.state === "IN_PROGRESS" || d.state === "APPROVED")) return "IN_PROGRESS";
  return "NOT_SUBMITTED";
}

/** For every deliverable, the prerequisites (dependency links) that aren't approved yet. */
export function blockedBy(items: Array<Pick<DeliverableFacts, "id" | "state" | "archived">>, links: LinkFacts[]): Map<string, string[]> {
  const byId = new Map(items.map((d) => [d.id, d]));
  const out = new Map<string, string[]>();
  for (const link of links) {
    if (link.type !== "DEPENDENCY") continue;
    const prerequisite = byId.get(link.fromId);
    const dependant = byId.get(link.toId);
    if (!prerequisite || !dependant || prerequisite.archived || dependant.archived) continue;
    if (prerequisite.state === "APPROVED") continue;
    out.set(link.toId, [...(out.get(link.toId) ?? []), link.fromId]);
  }
  return out;
}

/**
 * Adding a dependency `fromId → toId` ("toId requires fromId") creates a cycle when
 * `fromId` already (transitively) requires `toId`.
 */
export function wouldCreateCycle(links: LinkFacts[], fromId: string, toId: string): boolean {
  if (fromId === toId) return true;
  const requires = new Map<string, string[]>();
  for (const l of links) {
    if (l.type !== "DEPENDENCY") continue;
    requires.set(l.toId, [...(requires.get(l.toId) ?? []), l.fromId]);
  }
  // Walk everything `fromId` requires; reaching `toId` means toId → … → fromId → toId.
  const stack = [fromId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === toId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(requires.get(id) ?? []));
  }
  return false;
}

/**
 * Who works on a deliverable: its responsible person and contributors when any are set,
 * otherwise (inherited) the card's assignees.
 */
export function deliverableTeam(d: { ownerId: string | null; contributorIds?: readonly string[] }, cardAssigneeIds: readonly string[]): { ids: string[]; inherited: boolean } {
  const explicit = [d.ownerId, ...(d.contributorIds ?? [])].filter((id): id is string => Boolean(id));
  return explicit.length ? { ids: [...new Set(explicit)], inherited: false } : { ids: [...cardAssigneeIds], inherited: true };
}

/**
 * Deliverable-level rights on top of the card's. Being responsible for, or contributing to, one
 * deliverable lets you upload to it, submit it and resolve its feedback — nothing on the card's
 * other deliverables. Self-approval is judged by who works on this deliverable.
 */
export function deliverablePermissions(input: {
  card: CardPermissions;
  role: string;
  userId: string;
  ownerId: string | null;
  contributorIds?: readonly string[];
  /** The viewer is one of the card's assignees. */
  cardAssignee?: boolean;
  allowSelfApproval: boolean;
  readOnly: boolean;
}): DeliverablePermissions {
  if (input.readOnly) return { canEdit: false, canUpload: false, canSubmit: false, canReview: false, canResolveFeedback: false };
  const works = input.ownerId === input.userId || (input.contributorIds ?? []).includes(input.userId);
  const explicit = Boolean(input.ownerId) || (input.contributorIds?.length ?? 0) > 0;
  const responsibleForWork = explicit ? works : Boolean(input.cardAssignee);
  return {
    canEdit: input.card.canEdit,
    canUpload: input.card.canUpload || (works && roleHas(input.role, "attachment.upload")),
    canSubmit: input.card.canSubmit || (works && roleHas(input.role, "card.submit")),
    canReview: roleHas(input.role, "card.review") && (input.allowSelfApproval || !responsibleForWork),
    canResolveFeedback: input.card.canResolveFeedback || works,
  };
}

const STATE_REASON: Record<CardState, string> = {
  NOT_SUBMITTED: "Not started",
  IN_PROGRESS: "In progress — not submitted for review",
  NEEDS_REVIEW: "Waiting for review",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED: "Approved",
};

/** A deliverable shared from another card that this card needs approved before it can be completed. */
export interface SharedFacts extends DeliverableFacts {
  /** Its own card's key ("UTD-3"). */
  cardKey: string;
}

export function computeReadiness(input: {
  deliverables: DeliverableFacts[];
  links: LinkFacts[];
  snapshot: ProductionSnapshotEntry[];
  recorded: boolean;
  /** Revision numbers by id, for this card's deliverables and the shared ones. */
  versionNumbers: Map<string, number>;
  /** Shared deliverables this card needs (see canvas links). They never count toward its own progress. */
  shared?: SharedFacts[];
}): ReadinessDTO {
  const counted = countedDeliverables(input.deliverables);
  const shared = (input.shared ?? []).filter((d) => !d.archived);
  const blockers: ReadinessDTO["blockers"] = [];
  if (!counted.length) blockers.push({ deliverableId: "", name: "Deliverables", reason: "Add at least one deliverable" });
  const v = (id: string | null) => (id ? input.versionNumbers.get(id) : undefined);
  const reasonFor = (d: DeliverableFacts) => {
    if (d.state === "NOT_SUBMITTED" && !d.hasFiles) return "No files uploaded yet";
    if (d.state === "IN_PROGRESS" && v(d.currentVersionId)) return `V${v(d.currentVersionId)} in progress — not submitted for review`;
    if (d.state === "NEEDS_REVIEW" && v(d.currentVersionId)) return `V${v(d.currentVersionId)} is waiting for review`;
    if (d.state === "CHANGES_REQUESTED" && v(d.currentVersionId)) return `Changes requested on V${v(d.currentVersionId)}`;
    return STATE_REASON[d.state];
  };

  for (const d of counted) {
    if (d.state === "APPROVED") continue;
    blockers.push({ deliverableId: d.id, name: d.name, reason: reasonFor(d) });
  }
  for (const d of shared) {
    if (d.state === "APPROVED") continue;
    blockers.push({ deliverableId: d.id, name: d.name, reason: `Shared from ${d.cardKey}, needed here — ${reasonFor(d).replace(/^[A-Z](?![A-Z0-9])/, (c) => c.toLowerCase())}`, sharedFrom: d.cardKey });
  }
  // A counted deliverable can't be done while something it requires isn't approved.
  const blocked = blockedBy(input.deliverables, input.links);
  const byId = new Map(input.deliverables.map((d) => [d.id, d]));
  for (const d of counted) {
    for (const prerequisiteId of blocked.get(d.id) ?? []) {
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite || counted.includes(prerequisite)) continue; // already listed on its own
      blockers.push({ deliverableId: prerequisite.id, name: prerequisite.name, reason: `Required by ${d.name} — ${STATE_REASON[prerequisite.state].toLowerCase()}` });
    }
  }

  const pendingChanges: ReadinessDTO["pendingChanges"] = [];
  if (input.recorded) {
    const recordedIds = new Set(input.snapshot.map((s) => s.deliverableId));
    const sharedById = new Map((input.shared ?? []).map((d) => [d.id, d]));
    for (const entry of input.snapshot) {
      if (entry.sharedFrom) {
        // Shared work this card needed when it was recorded: flag a newer revision of it (if it's still needed here).
        const d = sharedById.get(entry.deliverableId);
        if (!d || !entry.versionId) continue;
        const where = { deliverableId: d.id, name: d.name, sharedFrom: d.cardKey };
        if (d.archived) pendingChanges.push({ ...where, detail: `Archived on ${d.cardKey} since it was recorded` });
        else if (d.currentVersionId && d.currentVersionId !== entry.versionId) {
          const now = v(d.currentVersionId);
          pendingChanges.push({ ...where, detail: `${now ? `V${now}` : "A new revision"} on ${d.cardKey} is ${d.state === "APPROVED" ? "approved but not yet recorded" : STATE_REASON[d.state].toLowerCase()} · V${entry.versionNumber ?? "?"} is recorded` });
        } else if (d.state !== "APPROVED") pendingChanges.push({ ...where, detail: `Reopened on ${d.cardKey} (${STATE_REASON[d.state].toLowerCase()}) · V${entry.versionNumber ?? "?"} is recorded` });
        continue;
      }
      const d = byId.get(entry.deliverableId);
      if (!d) continue;
      if (!entry.versionId) {
        // Not part of the record (an optional deliverable that wasn't approved). Its own
        // progress isn't a change to what was recorded — only newly approved work is worth flagging.
        const now = v(d.currentVersionId);
        if (!d.archived && d.state === "APPROVED" && now) pendingChanges.push({ deliverableId: d.id, name: d.name, detail: `V${now} is approved but not yet recorded` });
        continue;
      }
      if (d.archived) {
        pendingChanges.push({ deliverableId: d.id, name: entry.name, detail: "Archived since it was recorded" });
        continue;
      }
      const recordedV = entry.versionNumber ? `V${entry.versionNumber}` : "no files";
      if (d.currentVersionId && d.currentVersionId !== entry.versionId) {
        const now = v(d.currentVersionId);
        pendingChanges.push({
          deliverableId: d.id,
          name: d.name,
          detail: `${now ? `V${now}` : "A new revision"} is ${d.state === "APPROVED" ? "approved but not yet recorded" : STATE_REASON[d.state].toLowerCase()} · ${recordedV} is recorded`,
        });
      } else if (d.state !== "APPROVED") {
        pendingChanges.push({ deliverableId: d.id, name: d.name, detail: `Reopened (${STATE_REASON[d.state].toLowerCase()}) · ${recordedV} is recorded` });
      }
    }
    for (const d of counted) {
      if (!recordedIds.has(d.id)) pendingChanges.push({ deliverableId: d.id, name: d.name, detail: "Added after this was recorded" });
    }
    for (const d of shared) {
      if (!recordedIds.has(d.id)) pendingChanges.push({ deliverableId: d.id, name: d.name, detail: `Shared from ${d.cardKey} and needed here since this was recorded`, sharedFrom: d.cardKey });
    }
  }
  return { ready: blockers.length === 0, blockers, pendingChanges };
}

export function computeProgress(items: DeliverableFacts[], links: LinkFacts[]): DeliverableProgressDTO {
  const active = items.filter((d) => !d.archived);
  const counted = new Set(countedDeliverables(active));
  const blocked = blockedBy(active, links);
  return {
    total: active.length,
    required: counted.size,
    withFiles: active.filter((d) => d.hasFiles).length,
    inReview: active.filter((d) => d.state === "NEEDS_REVIEW").length,
    changesRequested: active.filter((d) => d.state === "CHANGES_REQUESTED").length,
    inProgress: active.filter((d) => d.state === "IN_PROGRESS").length,
    notStarted: active.filter((d) => d.state === "NOT_SUBMITTED").length,
    approved: active.filter((d) => d.state === "APPROVED").length,
    approvedRequired: [...counted].filter((d) => d.state === "APPROVED").length,
    blocked: active.filter((d) => (blocked.get(d.id) ?? []).length > 0).length,
  };
}

export const PRODUCTION_META = {
  TODO: { label: "To-do", description: "Still being produced or reviewed." },
  COMPLETED: { label: "Completed", description: "Required work approved — ready for release." },
  PUBLISHED: { label: "Published", description: "Marked as released / in use. A tracking state — nothing is deployed." },
} as const;
