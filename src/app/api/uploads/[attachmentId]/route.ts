import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { requireRouteSession } from "@/server/auth/route-session";
import { AppError, forbidden, invalid, notFound } from "@/server/errors";
import { errorResponse, isTrustedOrigin } from "@/server/http";
import { maxBytesFor } from "@/server/media/formats";
import { getPendingUpload } from "@/server/services/media";
import { storage } from "@/server/storage";
import { LocalStorageDriver, verifyUploadSignature } from "@/server/storage/local";

export const dynamic = "force-dynamic";

/**
 * Receives the original file for the local storage driver. (With S3/R2 the
 * browser uploads straight to the bucket via a presigned URL instead.)
 */
export async function PUT(req: Request, context: { params: Promise<{ attachmentId: string }> }) {
  let tempFile: string | null = null;
  try {
    if (!isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    const { attachmentId } = await context.params;
    const url = new URL(req.url);
    if (!verifyUploadSignature(attachmentId, Number(url.searchParams.get("exp")), url.searchParams.get("sig") ?? "")) {
      throw forbidden("This upload link has expired. Please try again.");
    }
    const { actor } = await requireRouteSession(req);
    const attachment = await getPendingUpload(attachmentId);
    if (!attachment) throw notFound("Upload");
    if (attachment.uploadedById !== actor.userId) throw forbidden();
    if (attachment.status !== "PENDING") throw invalid("This upload was already completed.");

    const store = storage();
    if (store.name !== "local") throw invalid("Uploads go directly to object storage.");
    const driver = store as LocalStorageDriver;
    if (!req.body) throw invalid("Empty upload.");

    const limit = Math.min(maxBytesFor(attachment.kind), attachment.sizeBytes + 1024);
    const target = driver.resolve(attachment.storageKey);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    tempFile = `${target}.part`;

    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        received += chunk.length;
        if (received > limit) callback(new AppError("PAYLOAD_TOO_LARGE", "The file is larger than announced or over the size limit."));
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(req.body as unknown as WebReadableStream), meter, fs.createWriteStream(tempFile));
    await fsp.rename(tempFile, target);
    tempFile = null;
    return NextResponse.json({ ok: true, received });
  } catch (error) {
    if (tempFile) await fsp.rm(tempFile, { force: true }).catch(() => {});
    return errorResponse(error);
  }
}
