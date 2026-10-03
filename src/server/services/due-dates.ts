/**
 * Deadline reminders for cards and deliverables, sent by the server on a schedule — nobody needs
 * the site open. Each person hears once per deadline and kind: the dedupe key includes the
 * deadline, so moving it earns a fresh reminder, while repeated runs (retries, several workers,
 * catching up after downtime) never repeat one. Approved or archived work and archived projects
 * get none (nor do cards on an archived column or board), and recipients are worked out when
 * sending, so reassignment is respected.
 */
import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { now } from "../clock";
import { db } from "../db";
import { boardColumns, boards, cards, deliverables, projects } from "../db/schema";
import { Effects } from "./effects";
import { notify } from "./notifications";
import { loadCardWork, type CardWork } from "./workflow";

const SOON_MS = 24 * 60 * 60 * 1000;
/** Overdue notices only for deadlines missed in the last week: a long outage mustn't flood people about old work. */
const OVERDUE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export async function runDueDateReminders(at: Date = now()): Promise<number> {
  const soon = new Date(at.getTime() + SOON_MS);
  const since = new Date(at.getTime() - OVERDUE_LOOKBACK_MS);
  const fx = new Effects();
  const works = new Map<string, CardWork>();
  const workOf = async (cardId: string) => works.get(cardId) ?? works.set(cardId, await loadCardWork(db, cardId)).get(cardId)!;
  let sent = 0;

  const dueCards = await db
    .select({ card: cards, project: projects })
    .from(cards)
    .innerJoin(projects, eq(projects.id, cards.projectId))
    // Archived work (card, its column or board, the project) gets no reminders.
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(
      and(
        isNull(cards.archivedAt),
        isNull(boardColumns.archivedAt),
        isNull(boards.archivedAt),
        isNull(projects.archivedAt),
        ne(cards.state, "APPROVED"),
        gt(cards.dueAt, since),
        lte(cards.dueAt, soon),
      ),
    )
    .limit(500);
  for (const { card, project } of dueCards) {
    const due = card.dueAt!;
    const kind = due.getTime() > at.getTime() ? "DUE_SOON" : "OVERDUE";
    const work = await workOf(card.id);
    // The card's assignees, plus whoever works on unfinished deliverables that follow the card's deadline.
    const inheriting = work.deliverables.filter((d) => !d.archived && !d.dueAt && d.state !== "APPROVED").flatMap((d) => work.teams.get(d.id)?.ids ?? []);
    const notified = await notify(db, {
      recipientIds: [...work.assigneeIds, ...inheriting],
      actorId: null,
      type: kind,
      studioId: project.studioId,
      projectId: project.id,
      cardId: card.id,
      data: { cardKey: `${project.key}-${card.number}`, cardTitle: card.title, projectName: project.name, dueAt: due.toISOString() },
      dedupeKey: `${kind}:card:${card.id}:${due.toISOString()}`,
    });
    sent += notified.length;
    fx.notify(notified);
  }

  const dueDeliverables = await db
    .select({ d: deliverables, card: cards, project: projects })
    .from(deliverables)
    .innerJoin(cards, eq(cards.id, deliverables.cardId))
    .innerJoin(projects, eq(projects.id, deliverables.projectId))
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(
      and(
        isNull(deliverables.archivedAt),
        isNull(cards.archivedAt),
        isNull(boardColumns.archivedAt),
        isNull(boards.archivedAt),
        isNull(projects.archivedAt),
        ne(deliverables.state, "APPROVED"),
        gt(deliverables.dueAt, since),
        lte(deliverables.dueAt, soon),
      ),
    )
    .limit(500);
  for (const { d, card, project } of dueDeliverables) {
    const due = d.dueAt!;
    const kind = due.getTime() > at.getTime() ? "DUE_SOON" : "OVERDUE";
    const work = await workOf(card.id);
    const multi = work.deliverables.filter((x) => !x.archived).length > 1;
    const notified = await notify(db, {
      recipientIds: work.teams.get(d.id)?.ids ?? [],
      actorId: null,
      type: kind,
      studioId: project.studioId,
      projectId: project.id,
      cardId: card.id,
      deliverableId: d.id,
      data: {
        cardKey: `${project.key}-${card.number}`,
        cardTitle: card.title,
        projectName: project.name,
        deliverable: multi ? d.name : undefined,
        deliverableNumber: d.number,
        dueAt: due.toISOString(),
      },
      dedupeKey: `${kind}:deliverable:${d.id}:${due.toISOString()}`,
    });
    sent += notified.length;
    fx.notify(notified);
  }

  fx.flush();
  return sent;
}
