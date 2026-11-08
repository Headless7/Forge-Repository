/**
 * Scoped API tokens, shared by the server (validation) and the client (the admin screen).
 *
 * A token acts as the member it was issued for and may only call the procedures listed here, inside
 * the projects it was scoped to. The server additionally requires each of these procedures to declare
 * a `scope` resolver in the router; anything else is never reachable with a token.
 */
export const API_TOKEN_PROCEDURE_NAMES = ["forum.list", "forum.get", "item.get", "item.activity", "project.access", "item.triage"] as const;
export type ApiTokenProcedure = (typeof API_TOKEN_PROCEDURE_NAMES)[number];

export const API_TOKEN_PROCEDURES: Record<ApiTokenProcedure, { group: "read" | "write"; description: string }> = {
  "forum.list": { group: "read", description: "List a project's forums (Bugs, QA, custom trackers)." },
  "forum.get": { group: "read", description: "One forum: its items, including resolved ones, and its tags." },
  "item.get": { group: "read", description: "One item with its description, attachments and comments." },
  "item.activity": { group: "read", description: "An item's history." },
  "project.access": { group: "read", description: "The project's people and their ids (no emails)." },
  "item.triage": { group: "write", description: "Set an item's assignee and tags. Nothing else: no status, title or deletion." },
};

export function isApiTokenProcedure(name: string): name is ApiTokenProcedure {
  return (API_TOKEN_PROCEDURE_NAMES as readonly string[]).includes(name);
}

/** Raw tokens start with this so secret scanners recognise them; the rest is 256 random bits. */
export const API_TOKEN_PREFIX = "forge_";

export const API_TOKEN_EXPIRY_OPTIONS = [30, 90, 180, 365] as const;
export const API_TOKEN_MAX_DAYS = 365;

export type ApiTokenStatus = "active" | "expired" | "revoked";

export function apiTokenStatus(token: { expiresAt: string | Date; revokedAt: string | Date | null }, at: Date = new Date()): ApiTokenStatus {
  if (token.revokedAt) return "revoked";
  return new Date(token.expiresAt).getTime() <= at.getTime() ? "expired" : "active";
}
