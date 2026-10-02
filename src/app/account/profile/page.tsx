import { ProfilePage } from "@/components/account/account-pages";
import { actorFor, requireSession } from "@/server/auth/current";
import { getProfile } from "@/server/services/accounts";

export const metadata = { title: "Profile" };

export default async function AccountProfilePage() {
  const session = await requireSession();
  return <ProfilePage initial={await getProfile(actorFor(session))} />;
}
