import type { Readable } from "node:stream";

export interface SignedUrlOptions {
  /** When set, the response forces a download with this filename. */
  downloadName?: string;
  contentType?: string;
}

export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

/**
 * Private object storage. Objects are never publicly readable; browsers only
 * receive short-lived signed URLs. Implementations: local disk and S3-compatible.
 */
export interface StorageDriver {
  readonly name: "local" | "s3";
  /** URL the browser uploads the original file to (direct-to-storage for S3/R2). */
  /** `size`: the announced byte size; drivers that can (S3) make the upload fail for any other size. */
  createUploadTarget(key: string, options: { contentType: string; attachmentId: string; size: number }): Promise<UploadTarget>;
  signedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  stat(key: string): Promise<{ size: number } | null>;
  readHead(key: string, bytes: number): Promise<Buffer>;
  /** Makes the object available as a local file for processing; returns the path and a cleanup fn. */
  materialize(key: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
  delete(key: string): Promise<void>;
  createReadStream?(key: string, range?: { start: number; end: number }): Readable;
}

export const HOUR_MS = 60 * 60 * 1000;

/**
 * Signed URLs expire 2–3h after issue but stay byte-identical within the hour,
 * so browsers can cache thumbnails across board refreshes.
 */
export function bucketedExpiry(): { issuedAt: number; expiresAt: number } {
  const issuedAt = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  return { issuedAt, expiresAt: issuedAt + 3 * HOUR_MS };
}
