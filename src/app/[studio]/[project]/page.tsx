import type { Metadata } from "next";
import { BoardRoute } from "@/components/board/board-route";
import { requireSession } from "@/server/auth/current";
import { getProjectAccessBySlug } from "@/server/access";

type Params = Promise<{ studio: string; project: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { studio, project } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  return { title: access ? access.project.name : "Not found" };
}

/** The project's default board (the first in its board switcher). */
export default async function ProjectBoardPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { studio, project } = await params;
  return <BoardRoute studio={studio} project={project} boardNumber={null} search={await searchParams} />;
}
