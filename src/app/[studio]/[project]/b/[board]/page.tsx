import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BoardRoute } from "@/components/board/board-route";
import { requireSession } from "@/server/auth/current";
import { getProjectAccessBySlug } from "@/server/access";
import { findBoard } from "@/server/services/board";

type Params = Promise<{ studio: string; project: string; board: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

function boardNumber(value: string): number | null {
  return /^\d{1,9}$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { studio, project, board } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  const n = boardNumber(board);
  const row = access && n ? await findBoard(access.project.id, { number: n }) : null;
  return { title: access && row ? `${row.name} · ${access.project.name}` : "Not found" };
}

/** One board of a project, by its number — a stable address that survives renames and reordering. */
export default async function NumberedBoardPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { studio, project, board } = await params;
  const n = boardNumber(board);
  if (!n) notFound();
  return <BoardRoute studio={studio} project={project} boardNumber={n} search={await searchParams} />;
}
