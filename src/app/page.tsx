import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/current";
import { listStudiosForUser } from "@/server/services/studios";

/** Entry point: go straight to the user's most recent studio. */
export default async function RootPage() {
  const session = await requireSession();
  const studios = await listStudiosForUser(session.user.id);
  if (studios.length === 0) redirect("/onboarding");
  const last = studios.find((s) => s.id === session.user.lastStudioId) ?? studios[0]!;
  redirect(`/${last.slug}`);
}
