import { notFound } from "next/navigation";
import { StudioSettings } from "@/components/studio/studio-settings";
import { getStudioAccessBySlug } from "@/server/access";
import { requireSession } from "@/server/auth/current";
import { roleHas } from "@/lib/permissions";

export const metadata = { title: "Studio settings" };

export default async function StudioSettingsPage({ params }: { params: Promise<{ studio: string }> }) {
  const { studio } = await params;
  const session = await requireSession();
  const access = await getStudioAccessBySlug(session.user.id, studio);
  if (!access || !roleHas(access.role, "studio.update")) notFound();
  return <StudioSettings />;
}
