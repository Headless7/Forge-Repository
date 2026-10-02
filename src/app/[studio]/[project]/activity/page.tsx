import { notFound } from "next/navigation";
import { ProjectActivity } from "@/components/project/project-activity";
import { getProjectAccessBySlug } from "@/server/access";
import { requireSession } from "@/server/auth/current";
import { listProjectActivity } from "@/server/services/activity";
import { listProjectMembers } from "@/server/services/members-query";

export const metadata = { title: "Activity" };

export default async function ProjectActivityPage({ params }: { params: Promise<{ studio: string; project: string }> }) {
  const { studio, project } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  if (!access) notFound();
  const [events, members] = await Promise.all([listProjectActivity([access.project.id], { limit: 40 }), listProjectMembers(access.project)]);
  return (
    <ProjectActivity
      projectId={access.project.id}
      projectName={access.project.name}
      projectIcon={access.project.icon}
      studioSlug={studio}
      projectSlug={project}
      members={members}
      initial={events}
    />
  );
}
