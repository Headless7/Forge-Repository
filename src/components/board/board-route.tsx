import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { actorFor, requireSession } from "@/server/auth/current";
import { boardOfCard, getBoardPage } from "@/server/services/board";
import { ArchivedBoardNotice } from "./archived-board-notice";
import { BoardView } from "./board-view";

type Search = Record<string, string | string[] | undefined>;

function queryString(search: Search) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * A board page: /studio/project (the default board) or /studio/project/b/<number>. A card link
 * (?card=KEY) on the wrong board — old project links, notifications, search — is redirected to the
 * board the card is on, keeping the rest of the URL (deliverable, revision, comment).
 */
export async function BoardRoute({ studio, project, boardNumber, search }: { studio: string; project: string; boardNumber: number | null; search: Search }) {
  const session = await requireSession();
  const page = await getBoardPage(actorFor(session), studio, project, boardNumber);
  // Unknown project/board and "no access" look identical from the outside.
  if (!page) notFound();
  if (page.status === "archived") {
    return <ArchivedBoardNotice studioSlug={studio} project={page.project} boardId={page.boardId} boardName={page.boardName} canRestore={page.canRestore} />;
  }
  const cardKey = typeof search.card === "string" ? search.card : null;
  if (cardKey) {
    const at = await boardOfCard(page.board.project.id, page.board.project.key, cardKey);
    if (at && !at.archived && at.number !== page.board.board.number) redirect(`/${studio}/${project}/b/${at.number}${queryString(search)}`);
  }
  return (
    <Suspense>
      <BoardView key={page.board.boardId} initialBoard={page.board} studioSlug={studio} />
    </Suspense>
  );
}
