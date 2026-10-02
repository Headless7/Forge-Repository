import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/auth-forms";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/lib/demo-accounts";
import { getSession } from "@/server/auth/current";
import { env } from "@/server/env";

export const metadata = { title: "Sign in" };

const DEMO_COLORS = ["#7c6cf2", "#3b82f6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  if (await getSession()) redirect(params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/");
  const demo =
    env.DEMO_MODE && env.NODE_ENV !== "production"
      ? { password: DEMO_PASSWORD, accounts: DEMO_ACCOUNTS.map((a, i) => ({ email: a.email, name: a.name, hint: a.hint, color: DEMO_COLORS[i % DEMO_COLORS.length]! })) }
      : null;
  return (
    <SignInForm
      next={params.next}
      error={params.error}
      expired={params.expired === "1"}
      providers={{ discord: Boolean(env.DISCORD_CLIENT_ID), google: Boolean(env.GOOGLE_CLIENT_ID) }}
      demo={demo}
    />
  );
}
