import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { hmac, safeEqual } from "../auth/crypto";
import { bucketedExpiry, type SignedUrlOptions, type StorageDriver, type UploadTarget } from "./types";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export function assertSafeKey(key: string) {
  if (!KEY_PATTERN.test(key) || key.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

function fileSignaturePayload(key: string, exp: number, download: string) {
  return `file:${key}:${exp}:${download}`;
}

export function verifyFileSignature(key: string, exp: number, download: string, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(hmac(fileSignaturePayload(key, exp, download)), sig);
}

function uploadSignaturePayload(attachmentId: string, exp: number) {
  return `upload:${attachmentId}:${exp}`;
}

export function verifyUploadSignature(attachmentId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(hmac(uploadSignaturePayload(attachmentId, exp)), sig);
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = "local" as const;
  constructor(private readonly baseDir: string) {}

  resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.baseDir, ...key.split("/"));
    if (!full.startsWith(path.resolve(this.baseDir) + path.sep)) throw new Error("Path escapes storage root");
    return full;
  }

  async createUploadTarget(_key: string, options: { contentType: string; attachmentId: string }): Promise<UploadTarget> {
    const exp = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
    const sig = hmac(uploadSignaturePayload(options.attachmentId, exp));
    return {
      url: `/api/uploads/${options.attachmentId}?exp=${exp}&sig=${sig}`,
      method: "PUT",
      headers: { "content-type": options.contentType },
    };
  }

  async signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(bucketedExpiry().expiresAt / 1000);
    const download = options.downloadName ?? "";
    const sig = hmac(fileSignaturePayload(key, exp, download));
    const params = new URLSearchParams({ exp: String(exp), sig });
    if (download) params.set("dl", download);
    return `/api/files/${key}?${params.toString()}`;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
  }

  async putFile(key: string, filePath: string): Promise<void> {
    const file = this.resolve(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.copyFile(filePath, file);
  }

  async stat(key: string) {
    try {
      const s = await fsp.stat(this.resolve(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async readHead(key: string, bytes: number): Promise<Buffer> {
    const handle = await fsp.open(this.resolve(key), "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async materialize(key: string) {
    return { path: this.resolve(key), cleanup: async () => {} };
  }

  async delete(key: string) {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    if (!prefix.endsWith("/")) throw new Error(`Not a folder prefix: ${prefix}`);
    await fsp.rm(this.resolve(prefix.slice(0, -1)), { recursive: true, force: true });
  }

  createReadStream(key: string, range?: { start: number; end: number }) {
    return fs.createReadStream(this.resolve(key), range);
  }
}
