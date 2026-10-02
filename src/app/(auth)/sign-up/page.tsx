import { redirect } from "next/navigation";
import { SignUpForm } from "@/components/auth/auth-forms";
import { getSession } from "@/server/auth/current";
import { env } from "@/server/env";
import { previewInvitation } from "@/server/services/studios";

export const metadata = { title: "Create account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  if (await getSession()) redirect(params.invite ? `/invite/${params.invite}` : "/");
  const preview = params.invite ? await previewInvitation(params.invite) : null;
  const invite =
    preview && preview.status === "pending" && params.invite
      ? { token: params.invite, email: preview.email, studioName: preview.studioName }
      : null;
  return (
    <SignUpForm
      next={params.next}
      invite={invite}
      providers={{ discord: Boolean(env.DISCORD_CLIENT_ID), google: Boolean(env.GOOGLE_CLIENT_ID) }}
    />
  );
}
