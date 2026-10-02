import { notFound } from "next/navigation";
import { StudioHome } from "@/components/home/studio-home";
import { getStudioAccessBySlug } from "@/server/access";
import { actorFor, requireSession } from "@/server/auth/current";
import { getStudioHome } from "@/server/services/home";

export const metadata = { title: "Home" };

export default async function StudioHomePage({ params }: { params: Promise<{ studio: string }> }) {
  const { studio } = await params;
  const session = await requireSession();
  const access = await getStudioAccessBySlug(session.user.id, studio);
  if (!access) notFound();
  const home = await getStudioHome(actorFor(session), access.studioId);
  return <StudioHome initial={home} />;
}
