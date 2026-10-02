import Link from "next/link";
import { AuthCard } from "@/components/auth/auth-forms";
import { AcceptInvitation } from "@/components/auth/accept-invitation";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS, isRole } from "@/lib/permissions";
import { getSession } from "@/server/auth/current";
import { previewInvitation } from "@/server/services/studios";

export const metadata = { title: "Invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [invite, session] = await Promise.all([previewInvitation(token), getSession()]);

  if (!invite) {
    return <AuthCard title="Invitation not found" subtitle="This link is invalid. Ask a studio admin to send you a new invitation." />;
  }
  if (invite.status !== "pending") {
    const reason = { expired: "This invitation has expired.", revoked: "This invitation was revoked.", accepted: "This invitation has already been used." }[invite.status];
    return (
      <AuthCard title={`Join ${invite.studioName}`} subtitle={`${reason} Ask a studio admin for a new link.`}>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/">Go to Forge</Link>
        </Button>
      </AuthCard>
    );
  }

  const role = isRole(invite.role) ? ROLE_LABELS[invite.role] : invite.role;
  const subtitle = `${invite.inviterName ?? "A teammate"} invited ${invite.email} to join as ${role}.`;

  if (!session) {
    return (
      <AuthCard title={`Join ${invite.studioName}`} subtitle={subtitle}>
        <div className="grid gap-2">
          <Button asChild variant="primary" size="lg">
            <Link href={`/sign-up?invite=${encodeURIComponent(token)}`}>Create account & join</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>I already have an account</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${invite.studioName}`} subtitle={subtitle}>
      <AcceptInvitation token={token} invitedEmail={invite.email} currentEmail={session.user.email} />
    </AuthCard>
  );
}
