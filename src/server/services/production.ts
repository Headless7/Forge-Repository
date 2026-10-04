import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { computeReadiness, PRODUCTION_META } from "@/lib/deliverables";
import { positionBetween, resolveInsertIndex, spacedPositions } from "@/lib/positions";
import type { ProductionSnapshotEntry, ProductionStatus } from "@/lib/types";
import { assertCard, requireCard, type CardAccess } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { assetVersions, cards, deliverables, productionEvents } from "../db/schema";
import { conflict, forbidden } from "../errors";
import { logActivity } from "./activity";
import { loadDeliverableFacts } from "./card-dto";
import { cardNotificationData, watcherIds } from "./cards";
import type { Actor } from "./context";
import { queueDiscordEvent } from "./discord";
import { Effects } from "./effects";
import { notify } from "./notifications";

export interface MoveProductionInput {
  cardId: string;
  status: ProductionStatus;
  afterCardId?: string | null;
  beforeCardId?: string | null;
  index?: number | null;
  note?: string;
}

async function stageCards(tx: Executor, projectId: string, status: ProductionStatus, excludeId: string) {
  return tx
    .select({ id: cards.id, position: cards.productionPosition })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.productionStatus, status), isNull(cards.archivedAt), ne(cards.id, excludeId)))
    .orderBy(asc(cards.productionPosition), asc(cards.createdAt));
}

/** What would be recorded if the card were completed/published right now. */
async function snapshotFor(tx: Executor, cardId: string): Promise<ProductionSnapshotEntry[]> {
  const rows = await tx
    .select({
      id: deliverables.id,
      name: deliverables.name,
      required: deliverables.required,
      approvedVersionId: deliverables.approvedVersionId,
      state: deliverables.state,
      versionNumber: assetVersions.versionNumber,
    })
    .from(deliverables)
    .leftJoin(assetVersions, eq(assetVersions.id, deliverables.approvedVersionId))
    .where(and(eq(deliverables.cardId, cardId), isNull(deliverables.archivedAt)))
    .orderBy(asc(deliverables.position));
  return rows.map((r) => ({
    deliverableId: r.id,
    name: r.name,
    required: r.required,
    // Only approved work is ever recorded — never an unreviewed upload.
    versionId: r.state === "APPROVED" ? r.approvedVersionId : null,
    versionNumber: r.state === "APPROVED" ? r.versionNumber : null,
  }));
}

async function readinessOf(ctx: CardAccess) {
  const facts = (await loadDeliverableFacts([ctx.card.id])).get(ctx.card.id)!;
  const versionRows = await db
    .select({ id: assetVersions.id, n: assetVersions.versionNumber })
    .from(assetVersions)
    .where(eq(assetVersions.cardId, ctx.card.id));
  return computeReadiness({
    deliverables: facts.facts,
    links: facts.links,
    snapshot: ctx.card.productionSnapshot,
    recorded: ctx.card.productionStatus !== "TODO",
    versionNumbers: new Map(versionRows.map((v) => [v.id, v.n])),
  });
}

function assertTransition(ctx: CardAccess, from: ProductionStatus, to: ProductionStatus) {
  if (from === to) {
    assertCard(ctx.perms, "canMove", "You don't have permission to reorder this card.");
    return;
  }
  if (to === "PUBLISHED" || from === "PUBLISHED") {
    if (!ctx.perms.canPublish) {
      throw forbidden(
        to === "PUBLISHED"
          ? "Only managers can mark work as Published."
          : "Only managers can take work out of Published.",
      );
    }
    return;
  }
  assertCard(ctx.perms, "canEdit", "You don't have permission to change this card's production stage.");
}

export async function moveProduction(
  actor: Actor,
  input: MoveProductionInput,
): Promise<{ id: string; productionStatus: ProductionStatus; productionPosition: number }> {
  const ctx = await requireCard(actor.userId, input.cardId);
  const from = ctx.card.productionStatus;
  const to = input.status;
  assertTransition(ctx, from, to);

  if (to !== "TODO" && from !== to) {
    const readiness = await readinessOf(ctx);
    if (!readiness.ready) {
      const lines = readiness.blockers.slice(0, 6).map((b) => `${b.name}: ${b.reason}`);
      throw conflict(
        `${ctx.card.title} can't be marked ${PRODUCTION_META[to].label} yet — ${readiness.blockers.length} required deliverable${readiness.blockers.length === 1 ? " isn't" : "s aren't"} approved. ${lines.join("; ")}${readiness.blockers.length > 6 ? "; …" : ""}`,
        { blockers: readiness.blockers },
      );
    }
  }

  const fx = new Effects();
  const result = await db.transaction(async (tx) => {
    let list = await stageCards(tx, ctx.card.projectId, to, ctx.card.id);
    const index = resolveInsertIndex(list, { afterId: input.afterCardId, beforeId: input.beforeCardId, index: input.index ?? (from === to ? null : 0) });
    let position = positionBetween(list[index - 1]?.position, list[index]?.position);
    if (position === null) {
      const spaced = spacedPositions(list.length);
      for (let i = 0; i < list.length; i++) await tx.update(cards).set({ productionPosition: spaced[i]! }).where(eq(cards.id, list[i]!.id));
      list = await stageCards(tx, ctx.card.projectId, to, ctx.card.id);
      position = positionBetween(list[index - 1]?.position, list[index]?.position)!;
    }

    if (from === to) {
      await tx.update(cards).set({ productionPosition: position, revision: sql`${cards.revision} + 1` }).where(eq(cards.id, ctx.card.id));
      fx.card(ctx.card.projectId, ctx.card.id);
      return { id: ctx.card.id, productionStatus: to, productionPosition: position };
    }

    const at = now();
    const patch: Partial<typeof cards.$inferInsert> = {
      productionStatus: to,
      productionPosition: position,
      revision: sql`${cards.revision} + 1` as never,
      lastActivityAt: at,
      lastActivityById: actor.userId,
    };
    let snapshot: ProductionSnapshotEntry[] = [];
    if (to === "COMPLETED" || to === "PUBLISHED") {
      snapshot = await snapshotFor(tx, ctx.card.id);
      patch.productionSnapshot = snapshot;
      if (to === "COMPLETED" || from === "TODO") {
        patch.completedAt = at;
        patch.completedById = actor.userId;
      }
      if (to === "PUBLISHED") {
        patch.publishedAt = at;
        patch.publishedById = actor.userId;
      } else {
        patch.publishedAt = null;
        patch.publishedById = null;
      }
    } else {
      // Back to To-do: the earlier record stays in production_events; approvals are untouched.
      patch.completedAt = null;
      patch.completedById = null;
      patch.publishedAt = null;
      patch.publishedById = null;
    }
    await tx.update(cards).set(patch).where(eq(cards.id, ctx.card.id));
    const [recorded] = await tx
      .insert(productionEvents)
      .values({
        cardId: ctx.card.id,
        actorId: actor.userId,
        fromStatus: from,
        toStatus: to,
        note: input.note?.trim() ?? "",
        snapshot,
        createdAt: at,
      })
      .returning({ id: productionEvents.id });
    if (to === "COMPLETED" || to === "PUBLISHED") {
      fx.discord(
        await queueDiscordEvent(
          tx,
          { type: to, projectId: ctx.card.projectId, boardId: ctx.card.boardId, cardId: ctx.card.id, actorId: actor.userId, at: at.toISOString() },
          `production:${recorded!.id}`,
        ),
      );
    }
    await logActivity(tx, {
      studioId: ctx.access.studioId,
      projectId: ctx.card.projectId,
      cardId: ctx.card.id,
      actorId: actor.userId,
      type: "production.changed",
      data: {
        from,
        to,
        included: snapshot.filter((s) => s.versionNumber).map((s) => `${s.name} V${s.versionNumber}`),
      },
    });
    fx.notify(
      await notify(tx, {
        recipientIds: await watcherIds(tx, ctx.card.id),
        actorId: actor.userId,
        type: "WATCHED_CARD",
        studioId: ctx.access.studioId,
        projectId: ctx.card.projectId,
        cardId: ctx.card.id,
        data: { ...cardNotificationData(ctx.access, ctx.card), change: `marked it ${PRODUCTION_META[to].label}` },
      }),
    );
    fx.card(ctx.card.projectId, ctx.card.id);
    return { id: ctx.card.id, productionStatus: to, productionPosition: position };
  });
  fx.flush(actor.clientId);
  return result;
}

/** Next position at the end (or top) of a production stage — used when creating cards. */
export async function nextProductionPosition(projectId: string, status: ProductionStatus, ex: Executor, where: "top" | "bottom" = "bottom") {
  const [agg] = await ex
    .select({
      min: sql<number | null>`min(${cards.productionPosition})`,
      max: sql<number | null>`max(${cards.productionPosition})`,
    })
    .from(cards)
    .where(and(eq(cards.projectId, projectId), eq(cards.productionStatus, status), isNull(cards.archivedAt)));
  const min = agg?.min == null ? null : Number(agg.min);
  const max = agg?.max == null ? null : Number(agg.max);
  return where === "top" ? positionBetween(null, min)! : positionBetween(max, null)!;
}

