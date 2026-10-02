/**
 * Each studio may keep STUDIO_STORAGE_LIMIT_GB of uploaded originals. Usage counts every stored
 * original once (duplicated cards share files), including archived ones — archiving keeps the
 * file; deleting a card or project permanently frees it. Unfinished uploads hold their space
 * until they complete or are abandoned (then they no longer count, and cleanup removes them).
 * Derived previews (thumbnails, transcodes) are not counted.
 */
import { sql } from "drizzle-orm";
import { requireStudio } from "../access";
import { now } from "../clock";
import { db, type Executor } from "../db";
import { env } from "../env";
import { AppError } from "../errors";
import type { Actor } from "./context";

/** Uploads not finished within this window are abandoned (media recovery deletes them). */
export const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000;

export function studioStorageLimitBytes(): number {
  return Math.floor(env.STUDIO_STORAGE_LIMIT_GB * 1024 ** 3);
}

export async function studioStorageUsed(studioId: string, ex: Executor = db): Promise<number> {
  const abandonedBefore = new Date(now().getTime() - ABANDONED_UPLOAD_MS);
  const rows = await ex.execute<{ used: string | number | null }>(sql`
    select coalesce(sum(size_bytes), 0) as used from (
      select distinct on (a.storage_key) a.size_bytes
      from attachments a
      inner join projects p on p.id = a.project_id
      where p.studio_id = ${studioId}
        and a.status <> 'FAILED'
        and (a.status <> 'PENDING' or a.created_at > ${abandonedBefore.toISOString()}::timestamptz)
    ) files
  `);
  return Number(rows[0]?.used ?? 0);
}

function formatGb(bytes: number) {
  const gb = bytes / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

/**
 * Reserves `bytes` for a new upload inside the caller's transaction. Uploads to one studio take
 * turns here, so several started at once can't jointly exceed the limit.
 */
export async function reserveStudioStorage(tx: Executor, studioId: string, bytes: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`storage:${studioId}`}, 0))`);
  const used = await studioStorageUsed(studioId, tx);
  const limit = studioStorageLimitBytes();
  if (used + bytes > limit) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `This studio's storage is full (${formatGb(used)} of ${formatGb(limit)} used). Ask an owner or admin to permanently delete files or projects you no longer need.`,
      { code: "STORAGE_FULL", usedBytes: used, limitBytes: limit },
    );
  }
}

/** Storage usage for the studio settings page (owners and admins). */
export async function getStudioStorage(actor: Actor, studioId: string) {
  const access = await requireStudio(actor.userId, studioId, "studio.update");
  return { usedBytes: await studioStorageUsed(access.studioId), limitBytes: studioStorageLimitBytes() };
}
