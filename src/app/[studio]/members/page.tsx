import { notFound } from "next/navigation";
import { MembersPage } from "@/components/studio/members-page";
import { getStudioAccessBySlug } from "@/server/access";
import { requireSession } from "@/server/auth/current";
import { listMembersFor } from "@/server/services/members-query";

export const metadata = { title: "Members" };

export default async function StudioMembersPage({ params }: { params: Promise<{ studio: string }> }) {
  const { studio } = await params;
  const session = await requireSession();
  const access = await getStudioAccessBySlug(session.user.id, studio);
  if (!access) notFound();
  // Project-only collaborators see just the people on their projects.
  return <MembersPage initialMembers={await listMembersFor(access)} />;
}
