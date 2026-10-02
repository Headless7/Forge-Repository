import { requireSession } from "@/server/auth/current";
import { listStudiosForUser } from "@/server/services/studios";
import { OnboardingForm } from "@/components/auth/onboarding-form";

export const metadata = { title: "Create your studio" };

export default async function OnboardingPage() {
  const session = await requireSession();
  const studios = await listStudiosForUser(session.user.id);
  return <OnboardingForm displayName={session.user.displayName} existing={studios.map((s) => ({ slug: s.slug, name: s.name }))} />;
}
