import { notFound } from "next/navigation";
import { ProjectSettings } from "@/components/project/project-settings";
import { actorFor, requireSession } from "@/server/auth/current";
import { getBoardBySlug } from "@/server/services/board";

export const metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({ params }: { params: Promise<{ studio: string; project: string }> }) {
  const { studio, project } = await params;
  const session = await requireSession();
  const board = await getBoardBySlug(actorFor(session), studio, project);
  if (!board) notFound();
  return <ProjectSettings initialBoard={board} studioSlug={studio} />;
}
