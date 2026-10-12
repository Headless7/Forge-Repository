import path from "node:path";
import { env } from "../env";
import { LocalStorageDriver } from "./local";
import { S3StorageDriver } from "./s3";
import type { StorageDriver } from "./types";

const g = globalThis as unknown as { __forgeStorage?: StorageDriver };

export function storage(): StorageDriver {
  if (g.__forgeStorage) return g.__forgeStorage;
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_BUCKET) throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET");
    g.__forgeStorage = new S3StorageDriver({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  } else {
    g.__forgeStorage = new LocalStorageDriver(path.resolve(env.STORAGE_LOCAL_DIR));
  }
  return g.__forgeStorage;
}

/** Object key layout: studios/<studio>/projects/<project>/cards/<card>/<attachment>/<name> */
export function attachmentKey(parts: {
  studioId: string;
  projectId: string;
  cardId: string;
  attachmentId: string;
  name: string;
}) {
  return `studios/${parts.studioId}/projects/${parts.projectId}/cards/${parts.cardId}/${parts.attachmentId}/${parts.name}`;
}

/** Files on a bug report: studios/<studio>/projects/<project>/bugs/<bug>/<attachment>/<name> */
export function bugAttachmentKey(parts: { studioId: string; projectId: string; bugId: string; attachmentId: string; name: string }) {
  return `studios/${parts.studioId}/projects/${parts.projectId}/bugs/${parts.bugId}/${parts.attachmentId}/${parts.name}`;
}

export function avatarKey(userId: string, version: string) {
  return `avatars/${userId}/${version}.webp`;
}

/** A board's uploaded background image (inside its project, so the project's cleanup covers it). */
export function boardBackgroundKey(parts: { studioId: string; projectId: string; boardId: string; version: string }) {
  return `studios/${parts.studioId}/projects/${parts.projectId}/boards/${parts.boardId}/background-${parts.version}.webp`;
}

export type { StorageDriver } from "./types";
