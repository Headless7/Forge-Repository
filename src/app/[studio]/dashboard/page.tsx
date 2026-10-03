import { StudioDashboard } from "@/components/dashboard/studio-dashboard";
import { roleHas } from "@/lib/permissions";
import { getStudioAccessBySlug } from "@/server/access";
import { requireSession } from "@/server/auth/current";
import { notFound } from "next/navigation";

export const metadata = { title: "Studio dashboard" };

export default async function StudioDashboardPage({ params }: { params: Promise<{ studio: string }> }) {
  const { studio } = await params;
  const session = await requireSession();
  const access = await getStudioAccessBySlug(session.user.id, studio);
  if (!access) notFound();
  if (!roleHas(access.role, "reports.view")) {
    return <p className="mx-auto max-w-md px-6 py-16 text-center text-[13px] text-fg-muted">The studio dashboard is for Managers, Admins and the Owner.</p>;
  }
  return <StudioDashboard />;
}
