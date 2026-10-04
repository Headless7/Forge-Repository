import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/server/auth/current";
import { loadShell } from "@/server/shell";

export default async function StudioLayout({ children, params }: { children: ReactNode; params: Promise<{ studio: string }> }) {
  const { studio } = await params;
  const session = await requireSession();
  // Non-members get a 404 — the studio's existence isn't revealed.
  const shell = await loadShell(session, studio);
  if (!shell) notFound();
  return (
    <AppShell user={shell.user} studio={shell.studio} studios={shell.studios} projects={shell.projects} unreadCount={shell.unreadCount} tutorial={shell.tutorial}>
      {children}
    </AppShell>
  );
}
