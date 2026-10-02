import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { now } from "../clock";
import { db } from "../db";
import { cardAssignees, cards, projects } from "../db/schema";
import { Effects } from "./effects";
import { notify } from "./notifications";

/** Notifies assignees once when a card becomes due within the next 24 hours. */
export async function runDueDateReminders(): Promise<number> {
  const current = now();
  const horizon = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  const due = await db
    .select({ card: cards, project: projects })
    .from(cards)
    .innerJoin(projects, eq(projects.id, cards.projectId))
    .where(
      and(
        isNull(cards.archivedAt),
        isNull(cards.dueReminderSentAt),
        ne(cards.state, "APPROVED"),
        gt(cards.dueAt, current),
        lte(cards.dueAt, horizon),
        isNull(projects.archivedAt),
      ),
    )
    .limit(500);

  const fx = new Effects();
  for (const { card, project } of due) {
    await db.transaction(async (tx) => {
      // Claim the reminder first so concurrent runners never double-notify.
      const [claimed] = await tx
        .update(cards)
        .set({ dueReminderSentAt: current })
        .where(and(eq(cards.id, card.id), isNull(cards.dueReminderSentAt)))
        .returning({ id: cards.id });
      if (!claimed) return;
      const assignees = await tx.select({ userId: cardAssignees.userId }).from(cardAssignees).where(eq(cardAssignees.cardId, card.id));
      fx.notify(
        await notify(tx, {
          recipientIds: assignees.map((a) => a.userId),
          actorId: null,
          type: "DUE_SOON",
          studioId: project.studioId,
          projectId: project.id,
          cardId: card.id,
          data: { cardKey: `${project.key}-${card.number}`, cardTitle: card.title, dueAt: card.dueAt!.toISOString(), projectName: project.name },
        }),
      );
    });
  }
  fx.flush();
  return due.length;
}
