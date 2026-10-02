"use client";

import { createContext, useContext } from "react";
import { permissionsFor, roleHas, type Permission, type Role } from "@/lib/permissions";
import type { StudioSummaryDTO } from "@/lib/types";

export interface ShellUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  avatarColor: string;
  emailVerified: boolean;
  theme: "dark" | "light" | "system";
  /** Site operator: creates studios and issues activation keys. */
  platformAdmin: boolean;
}

export interface ShellStudio {
  id: string;
  slug: string;
  name: string;
  iconEmoji: string | null;
  role: Role;
}

export interface ShellContextValue {
  user: ShellUser;
  studio: ShellStudio;
  studios: StudioSummaryDTO[];
  can: (permission: Permission) => boolean;
  openSearch: () => void;
  openShortcuts: () => void;
}

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside <AppShell>");
  return ctx;
}

export function makeCan(role: Role) {
  const set = new Set(permissionsFor(role));
  return (permission: Permission) => set.has(permission) || roleHas(role, permission);
}
