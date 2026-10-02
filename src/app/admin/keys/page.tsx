import { notFound } from "next/navigation";
import { ActivationKeysPage } from "@/components/admin/activation-keys";
import { requireSession } from "@/server/auth/current";
import { isPlatformAdmin } from "@/server/services/platform";

export const metadata = { title: "Activation keys" };

/** Site operators only; everyone else gets a 404 (the page's existence isn't revealed). */
export default async function AdminKeysPage() {
  const session = await requireSession();
  if (!isPlatformAdmin(session.user)) notFound();
  return <ActivationKeysPage />;
}
