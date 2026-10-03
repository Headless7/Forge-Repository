/**
 * What's archived in a project (or a studio's archived projects), with sizes, for the archive
 * manager: restore individual items, or select them for permanent deletion (see purge.ts).
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AttachmentKind } from "@/lib/types";
import { requireProject, requireStudio } from "../access";
import { db } from "../db";
import { attachments, boardColumns, boards, cards, deliverables, projects, robloxResources } from "../db/schema";
import { forbidden } from "../errors";
import { columnToDTO } from "./board";
import { summarizeCards } from "./card-dto";
import type { Actor } from "./context";

/** Original-file bytes per group, counting a shared file once per group. */
async function bytesBy(column: typeof attachments.cardId | typeof attachments.deliverableId | typeof attachments.projectId, ids: string[]) {
  if (!ids.length) return new Map<string, { files: number; bytes: number }>();
  const rows = await db.execute<{ id: string; files: number; bytes: string | number }>(sql`
    select grp as id, count(*)::int as files, coalesce(sum(size_bytes), 0) as bytes from (
      select distinct on (${column}, ${attachments.storageKey}) ${column} as grp, ${attachments.sizeBytes} as size_bytes
      from ${attachments}
      where ${inArray(column, ids)} and ${attachments.status} <> 'FAILED'
    ) f group by grp
  `);
  return new Map(rows.map((r) => [r.id, { files: Number(r.files), bytes: Number(r.bytes) }]));
}

export async function listArchivedContent(actor: Actor, projectId: string) {
  const access = await requireProject(actor.userId, projectId, "project.view");
  const [boardRows, columnRows, cardRows, deliverableRows, attachmentRows] = await Promise.all([
    db.select().from(boards).where(eq(boards.projectId, projectId)),
    db.select().from(boardColumns).where(and(eq(boardColumns.projectId, projectId), isNotNull(boardColumns.archivedAt))).orderBy(desc(boardColumns.archivedAt)),
    db.select().from(cards).where(and(eq(cards.projectId, projectId), isNotNull(cards.archivedAt))).orderBy(desc(cards.archivedAt)).limit(500),
    // Archived deliverables of cards that are still active (an archived card already covers its own).
    db
      .select({ d: deliverables, cardNumber: cards.number, cardTitle: cards.title })
      .from(deliverables)
      .innerJoin(cards, eq(cards.id, deliverables.cardId))
      .where(and(eq(deliverables.projectId, projectId), isNotNull(deliverables.archivedAt), isNull(cards.archivedAt)))
      .orderBy(desc(deliverables.archivedAt))
      .limit(500),
    // Archived files whose card and deliverable are still active.
    db
      .select({ a: attachments, cardNumber: cards.number, cardTitle: cards.title, deliverableName: deliverables.name })
      .from(attachments)
      .innerJoin(cards, eq(cards.id, attachments.cardId))
      .leftJoin(deliverables, eq(deliverables.id, attachments.deliverableId))
      .where(and(eq(attachments.projectId, projectId), isNotNull(attachments.archivedAt), isNull(cards.archivedAt), isNull(deliverables.archivedAt)))
      .orderBy(desc(attachments.archivedAt))
      .limit(500),
  ]);

  const boardName = new Map(boardRows.map((b) => [b.id, b.name]));
  const archivedBoards = boardRows.filter((b) => b.archivedAt).sort((a, b) => b.archivedAt!.getTime() - a.archivedAt!.getTime());
  const boardCards = archivedBoards.length
    ? await db.select({ id: cards.id, boardId: cards.boardId }).from(cards).where(inArray(cards.boardId, archivedBoards.map((b) => b.id)))
    : [];
  const boardCardBytes = await bytesBy(attachments.cardId, boardCards.map((c) => c.id));
  const columnIds = columnRows.map((c) => c.id);
  const columnCards = columnIds.length
    ? await db
        .select({ columnId: cards.columnId, active: sql<number>`count(*) filter (where ${cards.archivedAt} is null)`.mapWith(Number), archived: sql<number>`count(*) filter (where ${cards.archivedAt} is not null)`.mapWith(Number) })
        .from(cards)
        .where(inArray(cards.columnId, columnIds))
        .groupBy(cards.columnId)
    : [];
  const columnCardMap = new Map(columnCards.map((c) => [c.columnId, c]));
  const columnCardIds = columnIds.length ? await db.select({ id: cards.id, columnId: cards.columnId }).from(cards).where(inArray(cards.columnId, columnIds)) : [];
  const cardBytes = await bytesBy(attachments.cardId, [...cardRows.map((c) => c.id), ...columnCardIds.map((c) => c.id)]);
  const deliverableBytes = await bytesBy(attachments.deliverableId, deliverableRows.map((r) => r.d.id));
  const resources = attachmentRows.length
    ? new Set((await db.select({ id: robloxResources.attachmentId }).from(robloxResources).where(inArray(robloxResources.attachmentId, attachmentRows.map((r) => r.a.id)))).map((r) => r.id))
    : new Set<string>();
  const key = (n: number) => `${access.project.key}-${n}`;

  return {
    /** Several boards: entries name theirs. */
    multipleBoards: boardRows.length > 1,
    boards: archivedBoards.map((b) => {
      const sizes = boardCards.filter((c) => c.boardId === b.id).map((c) => boardCardBytes.get(c.id) ?? { files: 0, bytes: 0 });
      return {
        id: b.id,
        number: b.number,
        name: b.name,
        description: b.description,
        archivedAt: b.archivedAt!.toISOString(),
        cards: boardCards.filter((c) => c.boardId === b.id).length,
        files: sizes.reduce((n, s) => n + s.files, 0),
        bytes: sizes.reduce((n, s) => n + s.bytes, 0),
      };
    }),
    columns: columnRows.map((c) => {
      const inColumn = columnCardIds.filter((x) => x.columnId === c.id);
      const sizes = inColumn.map((x) => cardBytes.get(x.id) ?? { files: 0, bytes: 0 });
      return {
        ...columnToDTO(c),
        boardName: boardName.get(c.boardId) ?? "",
        archivedAt: c.archivedAt!.toISOString(),
        activeCards: columnCardMap.get(c.id)?.active ?? 0,
        archivedCards: columnCardMap.get(c.id)?.archived ?? 0,
        files: sizes.reduce((n, s) => n + s.files, 0),
        bytes: sizes.reduce((n, s) => n + s.bytes, 0),
      };
    }),
    cards: (await summarizeCards(cardRows, actor.userId, new Map([[projectId, access.project.key]]))).map((card) => ({
      ...card,
      boardName: boardName.get(cardRows.find((r) => r.id === card.id)?.boardId ?? "") ?? "",
      archivedAt: cardRows.find((r) => r.id === card.id)?.archivedAt?.toISOString() ?? null,
      files: cardBytes.get(card.id)?.files ?? 0,
      bytes: cardBytes.get(card.id)?.bytes ?? 0,
    })),
    deliverables: deliverableRows.map(({ d, cardNumber, cardTitle }) => ({
      id: d.id,
      cardId: d.cardId,
      cardKey: key(cardNumber),
      cardTitle,
      number: d.number,
      name: d.name,
      state: d.state,
      archivedAt: d.archivedAt!.toISOString(),
      files: deliverableBytes.get(d.id)?.files ?? 0,
      bytes: deliverableBytes.get(d.id)?.bytes ?? 0,
    })),
    attachments: attachmentRows.map(({ a, cardNumber, cardTitle, deliverableName }) => ({
      id: a.id,
      cardId: a.cardId,
      cardKey: key(cardNumber),
      cardTitle,
      deliverableName,
      filename: a.filename,
      kind: a.kind as AttachmentKind,
      bytes: a.sizeBytes,
      archivedAt: a.archivedAt!.toISOString(),
      /** Backs a Roblox mesh/texture other models use — kept out of permanent deletion. */
      sharedResource: resources.has(a.id),
    })),
  };
}

/** A studio's archived projects, for the owner's archive manager in studio settings. */
export async function listArchivedProjects(actor: Actor, studioId: string) {
  const access = await requireStudio(actor.userId, studioId);
  if (access.role !== "OWNER") throw forbidden("Only the studio owner manages archived projects.");
  const rows = await db.select().from(projects).where(and(eq(projects.studioId, studioId), isNotNull(projects.archivedAt))).orderBy(desc(projects.archivedAt));
  const sizes = await bytesBy(attachments.projectId, rows.map((p) => p.id));
  const cardCounts = rows.length
    ? new Map(
        (await db.select({ projectId: cards.projectId, n: sql<number>`count(*)`.mapWith(Number) }).from(cards).where(inArray(cards.projectId, rows.map((p) => p.id))).groupBy(cards.projectId)).map((r) => [r.projectId, r.n]),
      )
    : new Map<string, number>();
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    icon: p.icon,
    key: p.key,
    archivedAt: p.archivedAt!.toISOString(),
    cards: cardCounts.get(p.id) ?? 0,
    files: sizes.get(p.id)?.files ?? 0,
    bytes: sizes.get(p.id)?.bytes ?? 0,
  }));
}
