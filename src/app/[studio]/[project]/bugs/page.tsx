import { notFound } from "next/navigation";
import { BugsPage } from "@/components/bugs/bugs-page";
import { getProjectAccessBySlug } from "@/server/access";
import { actorFor, requireSession } from "@/server/auth/current";
import { listBugs } from "@/server/services/bugs";
import { listProjectMembers } from "@/server/services/members-query";

export const metadata = { title: "Bugs" };

export default async function ProjectBugsPage({ params }: { params: Promise<{ studio: string; project: string }> }) {
  const { studio, project } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  if (!access) notFound();
  const [initial, members] = await Promise.all([listBugs(actorFor(session), access.project.id), listProjectMembers(access.project)]);
  return <BugsPage initial={initial} members={members} studioSlug={studio} projectSlug={project} />;
}
