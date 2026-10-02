import { SecurityPage } from "@/components/account/account-pages";
import { actorFor, requireSession } from "@/server/auth/current";
import { getProfile } from "@/server/services/accounts";

export const metadata = { title: "Password & security" };

export default async function AccountSecurityPage() {
  const session = await requireSession();
  return <SecurityPage initial={await getProfile(actorFor(session))} />;
}
