import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { AccountNav } from "@/components/account/account-nav";
import { requireSession } from "@/server/auth/current";
import { loadShell } from "@/server/shell";

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const shell = await loadShell(session, null);
  if (!shell) redirect("/onboarding");
  return (
    <AppShell user={shell.user} studio={shell.studio} studios={shell.studios} projects={shell.projects} unreadCount={shell.unreadCount}>
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
          <p className="text-xs text-fg-subtle">
            <Link href={`/${shell.studio.slug}`} className="hover:text-fg">
              {shell.studio.name}
            </Link>{" "}
            / Account
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Account settings</h1>
          <AccountNav />
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </AppShell>
  );
}
