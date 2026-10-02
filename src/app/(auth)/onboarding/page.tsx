import { requireSession } from "@/server/auth/current";
import { accessStatus } from "@/server/services/platform";
import { listStudiosForUser } from "@/server/services/studios";
import { OnboardingForm } from "@/components/auth/onboarding-form";

export const metadata = { title: "Studio access" };

export default async function OnboardingPage() {
  const session = await requireSession();
  const [studios, status] = await Promise.all([listStudiosForUser(session.user.id), accessStatus(session.user.id)]);
  return <OnboardingForm displayName={session.user.displayName} existing={studios.map((s) => ({ slug: s.slug, name: s.name }))} status={status} />;
}
