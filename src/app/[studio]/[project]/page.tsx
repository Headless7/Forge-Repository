import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BoardView } from "@/components/board/board-view";
import { actorFor, requireSession } from "@/server/auth/current";
import { getProjectAccessBySlug } from "@/server/access";
import { getBoardBySlug } from "@/server/services/board";

type Params = Promise<{ studio: string; project: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { studio, project } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  return { title: access ? access.project.name : "Not found" };
}

export default async function BoardPage({ params }: { params: Params }) {
  const { studio, project } = await params;
  const session = await requireSession();
  const board = await getBoardBySlug(actorFor(session), studio, project);
  // Unknown project and "no access" look identical from the outside.
  if (!board) notFound();
  return (
    <Suspense>
      <BoardView initialBoard={board} studioSlug={studio} />
    </Suspense>
  );
}
