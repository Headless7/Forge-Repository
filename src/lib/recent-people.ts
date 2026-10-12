/**
 * The people you assigned most recently, remembered in this browser per project and category, so
 * the scripters you keep giving scripting tasks to sit at the top of the picker. Nothing is shared
 * or saved on the server; a cleared browser just starts over.
 */
const LIMIT = 5;
const PREFIX = "forge:recent-people:";

export function recentPeopleKey(projectId: string, scope: string): string {
  return `${PREFIX}${projectId}:${scope}`;
}

export function getRecentPeople(key: string | undefined): string[] {
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

/** Moves `userId` to the front and keeps the last five. */
export function rememberPerson(key: string | undefined, userId: string): void {
  if (!key) return;
  try {
    const next = [userId, ...getRecentPeople(key).filter((id) => id !== userId)].slice(0, LIMIT);
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Private windows and blocked storage: no recents, nothing else changes.
  }
}
