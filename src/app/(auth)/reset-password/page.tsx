import Link from "next/link";
import { AuthCard, ResetPasswordForm } from "@/components/auth/auth-forms";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <AuthCard title="Reset link missing" subtitle="Open the link from your email again, or request a new one.">
        <Link href="/forgot-password" className="text-[13px] font-medium text-accent hover:underline">
          Request a new link
        </Link>
      </AuthCard>
    );
  }
  return <ResetPasswordForm token={token} />;
}
