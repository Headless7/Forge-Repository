"use client";

import { Bell, Menu, Search } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { syncDevicePush } from "@/lib/push-client";
import { rpc, errorMessage } from "@/lib/rpc-client";
import type { TutorialStateDTO } from "@/lib/tutorial";
import type { ProjectListItemDTO, StudioSummaryDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RealtimeProvider } from "../realtime";
import { TutorialProvider } from "../tutorial/tutorial";
import { UploadProvider } from "../upload/upload-manager";
import { Button } from "../ui/button";
import { Dialog, SheetContent } from "../ui/dialog";
import { CreateProjectDialog } from "./create-project-dialog";
import { NotificationsSheet, useUnreadCount } from "./notifications";
import { SearchDialog } from "./search-dialog";
import { ShellContext, makeCan, type ShellStudio, type ShellUser } from "./shell-context";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Sidebar, useProjects } from "./sidebar";

const COLLAPSE_KEY = "forge:sidebar-collapsed";

/**
 * Device notifications in the open app: clicking one opens its link in this tab (the service
 * worker asks), and a subscription this browser holds for someone else or an ended sign-in is
 * detached on load — so on a shared computer nobody gets another person's notifications.
 */
function usePushBridge() {
  const router = useRouter();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === "forge:navigate" && typeof data.url === "string" && data.url.startsWith("/")) router.push(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    void syncDevicePush().catch(() => {});
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);
}

function VerifyBanner({ email }: { email: string }) {
  const [hidden, setHidden] = useState(false);
  const [sending, setSending] = useState(false);
  if (hidden) return null;
  return (
    <div className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-[12.5px]">
      <span className="flex-1">
        Confirm your email address — we sent a link to <strong>{email}</strong>.
      </span>
      <Button
        size="xs"
        variant="ghost"
        loading={sending}
        onClick={async () => {
          setSending(true);
          try {
            await rpc("account.resendVerification", {});
            toast.success("Confirmation email sent.");
          } catch (error) {
            toast.error(errorMessage(error));
          } finally {
            setSending(false);
          }
        }}
      >
        Resend
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setHidden(true)} aria-label="Dismiss">
        Dismiss
      </Button>
    </div>
  );
}

export function AppShell({
  user,
  studio,
  studios,
  projects: initialProjects,
  unreadCount: initialUnread,
  tutorial,
  children,
}: {
  user: ShellUser;
  studio: ShellStudio;
  studios: StudioSummaryDTO[];
  projects: ProjectListItemDTO[];
  unreadCount: number;
  tutorial: TutorialStateDTO;
  children: ReactNode;
}) {
  const params = useParams<{ project?: string }>();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const projects = useProjects(studio.id, initialProjects).data;
  const unread = useUnreadCount(initialUnread).data;
  usePushBridge();

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // storage unavailable (private mode) — keep default
    }
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // ignore
      }
      return !c;
    });
  }, []);

  const currentProject = useMemo(() => {
    const p = params.project ? projects.find((x) => x.slug === params.project) : undefined;
    return p ? { id: p.id, slug: p.slug, name: p.name } : null;
  }, [params.project, projects]);

  const value = useMemo(
    () => ({
      user,
      studio,
      studios,
      can: makeCan(studio.role),
      openSearch: () => setSearchOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
    }),
    [user, studio, studios],
  );

  useHotkeys({
    "/": (e) => {
      e.preventDefault();
      setSearchOpen(true);
    },
    "mod+k": (e) => {
      e.preventDefault();
      setSearchOpen(true);
    },
    "?": () => setShortcutsOpen(true),
  });

  const sidebarProps = {
    projects,
    unreadCount: unread,
    onOpenNotifications: () => {
      setMobileOpen(false);
      setNotificationsOpen(true);
    },
    onCreateProject: () => {
      setMobileOpen(false);
      setCreateOpen(true);
    },
  };

  return (
    <ShellContext.Provider value={value}>
      <RealtimeProvider>
        <UploadProvider>
        <TutorialProvider initial={tutorial}>
        <div className="flex h-dvh overflow-hidden">
          <aside className={cn("hidden shrink-0 transition-[width] duration-200 md:block", collapsed ? "w-14" : "w-60")}>
            <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} {...sidebarProps} />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-2 md:hidden">
              <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
                <Menu />
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {studio.iconEmoji} {currentProject?.name ?? studio.name}
              </span>
              <Button variant="ghost" size="icon" aria-label="Search" onClick={() => setSearchOpen(true)}>
                <Search />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Notifications" onClick={() => setNotificationsOpen(true)} className="relative">
                <Bell />
                {unread ? <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" /> : null}
              </Button>
            </header>
            {!user.emailVerified ? <VerifyBanner email={user.email} /> : null}
            <main className="relative min-h-0 flex-1">{children}</main>
          </div>
        </div>

        <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" title="Navigation" className="w-72">
            <Sidebar collapsed={false} mobile onNavigate={() => setMobileOpen(false)} {...sidebarProps} />
          </SheetContent>
        </Dialog>
        <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} studio={studio} currentProject={currentProject} />
        <NotificationsSheet open={notificationsOpen} onOpenChange={setNotificationsOpen} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} studio={studio} />
        </TutorialProvider>
        </UploadProvider>
      </RealtimeProvider>
    </ShellContext.Provider>
  );
}
