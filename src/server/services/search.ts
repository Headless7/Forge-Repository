import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SearchResultDTO } from "@/lib/types";
import { getProjectAccess, requireProject, requireStudio } from "../access";
import { db } from "../db";
import { boardColumns, cardAssignees, cardLabels, cards, comments, labels, projects, users } from "../db/schema";
import { summarizeCards } from "./card-dto";
import type { Actor } from "./context";

function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Card search across one project (or every project the user can open in the studio). */
export async function searchCards(
  actor: Actor,
  input: { studioId: string; projectId?: string | null; q: string; limit?: number },
): Promise<SearchResultDTO[]> {
  const q = input.q.trim().slice(0, 100);
  if (!q) return [];

  let projectRows: Array<typeof projects.$inferSelect>;
  if (input.projectId) {
    const access = await requireProject(actor.userId, input.projectId, "project.view");
    projectRows = [access.project];
  } else {
    await requireStudio(actor.userId, input.studioId);
    const all = await db
      .select()
      .from(projects)
      .where(and(eq(projects.studioId, input.studioId), isNull(projects.archivedAt)));
    projectRows = [];
    for (const p of all) if (await getProjectAccess(actor.userId, p.id)) projectRows.push(p);
  }
  if (projectRows.length === 0) return [];
  const projectIds = projectRows.map((p) => p.id);
  const pattern = likePattern(q);

  const keyMatch = /^([A-Za-z0-9]{1,6})-(\d{1,7})$/.exec(q);
  const keyCondition = keyMatch
    ? and(
        eq(cards.number, Number(keyMatch[2])),
        inArray(
          cards.projectId,
          projectRows.filter((p) => p.key.toUpperCase() === keyMatch[1]!.toUpperCase()).map((p) => p.id).concat("00000000-0000-0000-0000-000000000000"),
        ),
      )
    : undefined;
  const numberOnly = /^#?(\d{1,7})$/.exec(q);

  const mLabel = sql<boolean>`exists (select 1 from ${cardLabels} inner join ${labels} on ${labels.id} = ${cardLabels.labelId} where ${cardLabels.cardId} = ${cards.id} and ${labels.name} ilike ${pattern})`;
  const mAssignee = sql<boolean>`exists (select 1 from ${cardAssignees} inner join ${users} on ${users.id} = ${cardAssignees.userId} where ${cardAssignees.cardId} = ${cards.id} and (${users.displayName} ilike ${pattern} or ${users.username} ilike ${pattern}))`;
  const commentHit = sql<string | null>`(select ${comments.body} from ${comments} where ${comments.cardId} = ${cards.id} and ${comments.deletedAt} is null and ${comments.body} ilike ${pattern} order by ${comments.createdAt} desc limit 1)`;

  const rows = await db
    .select({
      card: cards,
      columnName: boardColumns.name,
      mTitle: sql<boolean>`${cards.title} ilike ${pattern}`,
      mDescription: sql<boolean>`${cards.description} ilike ${pattern}`,
      mColumn: sql<boolean>`${boardColumns.name} ilike ${pattern}`,
      mLabel,
      mAssignee,
      commentHit,
    })
    .from(cards)
    .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
    .where(
      and(
        inArray(cards.projectId, projectIds),
        isNull(cards.archivedAt),
        isNull(boardColumns.archivedAt),
        or(
          sql`${cards.title} ilike ${pattern}`,
          sql`${cards.description} ilike ${pattern}`,
          sql`${boardColumns.name} ilike ${pattern}`,
          mLabel,
          mAssignee,
          sql`${commentHit} is not null`,
          ...(keyCondition ? [keyCondition] : []),
          ...(numberOnly ? [eq(cards.number, Number(numberOnly[1]))] : []),
        ),
      ),
    )
    .orderBy(desc(sql`${cards.title} ilike ${pattern}`), desc(cards.lastActivityAt))
    .limit(Math.min(input.limit ?? 25, 50));

  const keyMap = new Map(projectRows.map((p) => [p.id, p.key]));
  const summaries = await summarizeCards(rows.map((r) => r.card), actor.userId, keyMap);
  const projectMap = new Map(projectRows.map((p) => [p.id, p]));
  return rows.map((row, i) => {
    const project = projectMap.get(row.card.projectId)!;
    const matchedIn: SearchResultDTO["matchedIn"] = [];
    if (keyMatch || numberOnly) matchedIn.push("key");
    if (row.mTitle) matchedIn.push("title");
    if (row.mDescription) matchedIn.push("description");
    if (row.mColumn) matchedIn.push("column");
    if (row.mLabel) matchedIn.push("label");
    if (row.mAssignee) matchedIn.push("assignee");
    if (row.commentHit) matchedIn.push("comment");
    let snippet: string | null = null;
    const source = row.mDescription ? row.card.description : row.commentHit;
    if (source && !row.mTitle) {
      const index = source.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, index - 40);
      snippet = `${start > 0 ? "…" : ""}${source.slice(start, start + 140)}${source.length > start + 140 ? "…" : ""}`;
    }
    return {
      card: summaries[i]!,
      project: { id: project.id, slug: project.slug, name: project.name, icon: project.icon, key: project.key },
      columnName: row.columnName,
      matchedIn,
      snippet,
    };
  });
}
