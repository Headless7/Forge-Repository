import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { bucketedExpiry, type SignedUrlOptions, type StorageDriver, type UploadTarget } from "./types";
import { runtimePath, tempPrefix } from "../runtime-path";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** S3-compatible storage (AWS S3, Cloudflare R2, MinIO). Bucket must be private. */
export class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;
  private client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    });
  }

  async createUploadTarget(key: string, options: { contentType: string; size: number }): Promise<UploadTarget> {
    // Content-Length is signed, so the bucket refuses a body of any other size (the size was
    // checked against the upload limits when the intent was created). The link only has to be
    // valid when the upload starts, so it's short: it is also how long the uploader could
    // overwrite the object after finishing (or after losing access).
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: options.contentType, ContentLength: options.size }),
      { expiresIn: 60 * 60, signableHeaders: new Set(["content-length", "content-type"]) },
    );
    return { url, method: "PUT", headers: { "content-type": options.contentType } };
  }

  async signedUrl(key: string, options: SignedUrlOptions = {}): Promise<string> {
    const { issuedAt, expiresAt } = bucketedExpiry();
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.downloadName ? contentDisposition(options.downloadName) : undefined,
        ResponseContentType: options.contentType,
      }),
      { expiresIn: Math.floor((expiresAt - issuedAt) / 1000), signingDate: new Date(issuedAt) },
    );
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async putFile(key: string, filePath: string, contentType: string) {
    const { size } = await fsp.stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async stat(key: string) {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { size: head.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async readHead(key: string, bytes: number): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as Readable) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async materialize(key: string) {
    const dir = await fsp.mkdtemp(tempPrefix("forge-"));
    const file = runtimePath(dir, path.basename(key));
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    await pipeline(result.Body as Readable, fs.createWriteStream(file));
    return { path: file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async deletePrefix(prefix: string) {
    if (!prefix.endsWith("/")) throw new Error(`Not a folder prefix: ${prefix}`);
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.config.bucket, Delete: { Objects: keys, Quiet: true } }));
        if (result.Errors?.length) throw new Error(`Couldn't delete ${result.Errors.length} object(s) under ${prefix}: ${result.Errors[0]?.Message ?? "unknown error"}`);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
