import "server-only";
import type { ShellStudio, ShellUser } from "@/components/shell/shell-context";
import type { TutorialStateDTO } from "@/lib/tutorial";
import type { ProjectListItemDTO, StudioSummaryDTO } from "@/lib/types";
import { getStudioAccessBySlug } from "./access";
import type { ValidatedSession } from "./auth/session";
import { unreadCount } from "./services/notifications";
import { isPlatformAdmin } from "./services/platform";
import { listProjects } from "./services/projects";
import { listStudiosForUser, rememberStudio } from "./services/studios";
import { tutorialState } from "./services/tutorial";
import { avatarUrl } from "./services/users-lookup";

export interface ShellData {
  user: ShellUser;
  studio: ShellStudio;
  studios: StudioSummaryDTO[];
  projects: ProjectListItemDTO[];
  unreadCount: number;
  /** Loaded with the page so tips never flash or repeat before progress arrives. */
  tutorial: TutorialStateDTO;
}

/** Everything the app chrome needs. Returns null when the user can't access the studio. */
export async function loadShell(session: ValidatedSession, studioSlug: string | null): Promise<ShellData | null> {
  const studios = await listStudiosForUser(session.user.id);
  const target = studioSlug
    ? studios.find((s) => s.slug === studioSlug)
    : (studios.find((s) => s.id === session.user.lastStudioId) ?? studios[0]);
  if (!target) return null;
  const access = await getStudioAccessBySlug(session.user.id, target.slug);
  if (!access) return null;
  if (session.user.lastStudioId !== access.studioId) void rememberStudio(session.user.id, access.studioId).catch(() => {});

  const actor = { userId: session.user.id, sessionId: session.session.id };
  const [projects, unread, avatar, tutorial] = await Promise.all([
    listProjects(actor, access.studioId),
    unreadCount(session.user.id),
    avatarUrl(session.user.avatarKey),
    tutorialState(session.user.id),
  ]);
  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      username: session.user.username,
      displayName: session.user.displayName,
      avatarUrl: avatar,
      avatarColor: session.user.avatarColor,
      emailVerified: Boolean(session.user.emailVerifiedAt),
      theme: session.user.themePreference,
      platformAdmin: isPlatformAdmin(session.user),
    },
    studio: { id: access.studioId, slug: access.studioSlug, name: access.studioName, iconEmoji: target.iconEmoji, role: access.role },
    studios,
    projects,
    unreadCount: unread,
    tutorial,
  };
}
