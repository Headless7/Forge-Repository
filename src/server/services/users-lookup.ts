import { inArray } from "drizzle-orm";
import type { UserDTO } from "@/lib/types";
import { db, type Executor } from "../db";
import { users } from "../db/schema";
import { storage } from "../storage";

export type UserRow = typeof users.$inferSelect;
type UserLike = Pick<UserRow, "id" | "username" | "displayName" | "avatarKey" | "avatarColor">;

export async function loadUsers(ids: Iterable<string>, ex: Executor = db): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await ex.select().from(users).where(inArray(users.id, unique));
  return new Map(rows.map((u) => [u.id, u]));
}

export async function avatarUrl(avatarKey: string | null): Promise<string | null> {
  return avatarKey ? storage().signedUrl(avatarKey) : null;
}

export async function toUserDTO(user: UserLike): Promise<UserDTO> {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: await avatarUrl(user.avatarKey),
    avatarColor: user.avatarColor,
  };
}
