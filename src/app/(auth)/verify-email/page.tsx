import { VerifyEmail } from "@/components/auth/auth-forms";

export const metadata = { title: "Confirm email" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const { token, next } = await searchParams;
  return <VerifyEmail token={token ?? null} next={next ?? null} />;
}
