import { notFound } from "next/navigation";
import { ProjectDashboard } from "@/components/dashboard/project-dashboard";
import { roleHas } from "@/lib/permissions";
import { getProjectAccessBySlug } from "@/server/access";
import { requireSession } from "@/server/auth/current";

export const metadata = { title: "Dashboard" };

export default async function ProjectDashboardPage({ params }: { params: Promise<{ studio: string; project: string }> }) {
  const { studio, project } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  if (!access) notFound();
  if (!roleHas(access.role, "reports.view")) {
    return <p className="mx-auto max-w-md px-6 py-16 text-center text-[13px] text-fg-muted">This project&apos;s dashboard is for its Managers, Admins and the Owner.</p>;
  }
  return <ProjectDashboard projectId={access.project.id} studioSlug={studio} projectSlug={project} projectName={access.project.name} projectIcon={access.project.icon} />;
}
