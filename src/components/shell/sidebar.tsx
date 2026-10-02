"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Check,
  ChevronsUpDown,
  House,
  Keyboard,
  KeyRound,
  SquareKanban,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Sun,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { qk, useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import type { ProjectListItemDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { Kbd } from "../ui/controls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "../ui/menu";
import { useShell } from "./shell-context";

function NavItem({
  href,
  icon,
  label,
  active,
  collapsed,
  badge,
  onClick,
  indent,
}: {
  href?: string;
  icon: ReactNode;
  label: string;
  active?: boolean;
  collapsed: boolean;
  badge?: ReactNode;
  onClick?: () => void;
  indent?: boolean;
}) {
  const className = cn(
    "group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
    active ? "bg-surface-4 text-fg" : "text-fg-muted hover:bg-surface-3 hover:text-fg",
    collapsed && "justify-center px-0",
    indent && !collapsed && "h-7 pl-8 text-[12.5px]",
  );
  const content = (
    <>
      {icon}
      {collapsed ? null : <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!collapsed && badge ? badge : null}
    </>
  );
  const node = href ? (
    <Link href={href} className={className} aria-current={active ? "page" : undefined} onClick={onClick}>
      {content}
    </Link>
  ) : (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {node}
    </Tooltip>
  ) : (
    node
  );
}

export function useProjects(studioId: string, initial: ProjectListItemDTO[]) {
  return useQuery({
    queryKey: qk.projects(studioId),
    queryFn: () => rpc("project.list", { studioId }),
    initialData: initial,
    staleTime: 30_000,
  });
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  projects,
  unreadCount,
  onOpenNotifications,
  onCreateProject,
  onNavigate,
  mobile,
}: {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  projects: ProjectListItemDTO[];
  unreadCount: number;
  onOpenNotifications: () => void;
  onCreateProject: () => void;
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  const { user, studio, studios, can, openSearch, openShortcuts } = useShell();
  const pathname = usePathname();
  const params = useParams<{ studio?: string; project?: string }>();
  const router = useRouter();
  const base = `/${studio.slug}`;
  const activeProject = params.project ? projects.find((p) => p.slug === params.project) : undefined;

  const theme = useRpcMutation("account.update", {
    onSuccess: (profile) => {
      const value = profile.theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : profile.theme;
      document.documentElement.dataset.theme = value;
      router.refresh();
    },
  });

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <nav aria-label="Main" className={cn("flex h-full flex-col bg-surface", !mobile && "border-r border-border")}>
      {/* Studio switcher */}
      <div className={cn("flex items-center gap-1 p-2", collapsed && "flex-col")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md p-1.5 text-left hover:bg-surface-3", collapsed && "justify-center")}
              aria-label="Switch studio"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-4 text-base">{studio.iconEmoji ?? "◆"}</span>
              {collapsed ? null : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{studio.name}</span>
                    <span className="block truncate text-[11px] text-fg-subtle">{studio.role.charAt(0) + studio.role.slice(1).toLowerCase()}</span>
                  </span>
                  <ChevronsUpDown className="size-3.5 text-fg-subtle" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>Studios</DropdownMenuLabel>
            {studios.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => router.push(`/${s.slug}`)}>
                <span className="text-base">{s.iconEmoji ?? "◆"}</span>
                <span className="flex-1 truncate">{s.name}</span>
                {s.id === studio.id ? <Check className="!text-accent" /> : null}
              </DropdownMenuItem>
            ))}
            {user.platformAdmin ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => router.push("/onboarding")}>
                  <Plus /> Create a studio
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push("/admin/keys")}>
                  <KeyRound /> Activation keys
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {onToggleCollapsed ? (
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
            <button type="button" onClick={onToggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="flex size-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-3 hover:text-fg">
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </Tooltip>
        ) : null}
      </div>

      <div className="px-2">
        {collapsed ? (
          <NavItem icon={<Search />} label="Search" collapsed onClick={openSearch} />
        ) : (
          <button
            type="button"
            onClick={openSearch}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-fg-subtle transition-colors hover:border-border-strong hover:text-fg-muted"
          >
            <Search className="size-4" />
            <span className="flex-1 text-left">Search</span>
            <Kbd>/</Kbd>
          </button>
        )}
      </div>

      <div className="scrollbar-thin mt-2 flex-1 overflow-y-auto px-2 pb-2">
        <div className="grid gap-0.5">
          <NavItem href={base} icon={<House />} label="Home" active={pathname === base} collapsed={collapsed} onClick={onNavigate} />
          <NavItem
            icon={<Bell />}
            label="Notifications"
            collapsed={collapsed}
            onClick={onOpenNotifications}
            badge={unreadCount ? <span className="rounded-full bg-accent px-1.5 text-[10.5px] font-semibold leading-4 text-accent-fg">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
          />
        </div>

        <div className={cn("mb-1 mt-4 flex items-center justify-between px-2", collapsed && "justify-center px-0")}>
          {collapsed ? <span className="h-px w-6 bg-border" /> : <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Projects</span>}
          {!collapsed && can("project.create") ? (
            <Tooltip content="New project">
              <button type="button" onClick={onCreateProject} aria-label="New project" className="flex size-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg">
                <Plus className="size-3.5" />
              </button>
            </Tooltip>
          ) : null}
        </div>
        <div className="grid gap-0.5">
          {projects.length === 0 && !collapsed ? <p className="px-2 py-1 text-[12px] text-fg-subtle">No projects yet.</p> : null}
          {projects.map((p) => {
            const href = `${base}/${p.slug}`;
            const isActive = activeProject?.id === p.id;
            return (
              <div key={p.id}>
                <NavItem
                  href={href}
                  icon={<span className="flex size-4 items-center justify-center text-[14px] leading-none">{p.icon}</span>}
                  label={p.name}
                  active={isActive && pathname === href}
                  collapsed={collapsed}
                  onClick={onNavigate}
                  badge={
                    p.counts.needsReview ? (
                      <Tooltip content={`${p.counts.needsReview} waiting for review`}>
                        <span className="rounded bg-state-review/15 px-1.5 text-[10.5px] font-semibold leading-4 text-state-review">{p.counts.needsReview}</span>
                      </Tooltip>
                    ) : null
                  }
                />
                {isActive && !collapsed ? (
                  <div className="my-0.5 grid gap-0.5">
                    <NavItem href={href} icon={<SquareKanban />} label="Board" active={pathname === href} collapsed={false} indent onClick={onNavigate} />
                    <NavItem href={`${href}/activity`} icon={<Activity />} label="Activity" active={pathname === `${href}/activity`} collapsed={false} indent onClick={onNavigate} />
                    <NavItem href={`${href}/settings#members`} icon={<Users />} label="Members" collapsed={false} indent onClick={onNavigate} />
                    <NavItem href={`${href}/settings`} icon={<Settings />} label="Settings" active={pathname === `${href}/settings`} collapsed={false} indent onClick={onNavigate} />
                  </div>
                ) : null}
              </div>
            );
          })}
          {collapsed && can("project.create") ? <NavItem icon={<Plus />} label="New project" collapsed onClick={onCreateProject} /> : null}
        </div>
      </div>

      <div className="grid gap-0.5 border-t border-border p-2">
        <NavItem href={`${base}/members`} icon={<Users />} label="Members" active={pathname === `${base}/members`} collapsed={collapsed} onClick={onNavigate} />
        {can("studio.update") ? (
          <NavItem href={`${base}/settings`} icon={<Settings />} label="Studio settings" active={pathname === `${base}/settings`} collapsed={collapsed} onClick={onNavigate} />
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn("mt-1 flex items-center gap-2 rounded-md p-1.5 text-left hover:bg-surface-3", collapsed && "justify-center")} aria-label="Account menu">
              <UserAvatar user={user} size="md" />
              {collapsed ? null : (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{user.displayName}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">@{user.username}</span>
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuItem onSelect={() => router.push("/account/profile")}>
              <User /> Profile
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => router.push("/account/notifications")}>
              <Bell /> Notification settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => router.push("/account/security")}>
              <Settings /> Password & security
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={user.theme} onValueChange={(v) => theme.mutate({ theme: v as "dark" | "light" | "system" })}>
              <DropdownMenuRadioItem value="dark">
                <Moon /> Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor /> System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openShortcuts} shortcut="?">
              <Keyboard /> Keyboard shortcuts
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
