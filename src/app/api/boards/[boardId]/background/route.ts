import { NextResponse } from "next/server";
import { requireRouteSession } from "@/server/auth/route-session";
import { AppError, forbidden, invalid } from "@/server/errors";
import { errorResponse, isTrustedOrigin, readBodyLimited } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { setBoardBackgroundImage } from "@/server/services/board";

export const dynamic = "force-dynamic";

const MAX_BACKGROUND_BYTES = 15 * 1024 * 1024;

/** Uploads an image as a board's background (people who can manage the project's boards). */
export async function POST(req: Request, context: { params: Promise<{ boardId: string }> }) {
  try {
    if (!isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    const { actor } = await requireRouteSession(req);
    enforceRateLimit(`board-background:${actor.userId}`, 30, 60 * 60 * 1000);
    const { boardId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(boardId)) throw invalid("Unknown board.");
    // Buffered with a hard cap first: formData() alone would read any size (e.g. a chunked body with no Content-Length).
    const body = await readBodyLimited(req, MAX_BACKGROUND_BYTES + 64 * 1024, "Background images must be under 15 MB.");
    const form = await new Response(new Uint8Array(body), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData().catch(() => {
      throw invalid("Choose an image to upload.");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw invalid("Choose an image to upload.");
    if (file.size > MAX_BACKGROUND_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Background images must be under 15 MB.");
    const result = await setBoardBackgroundImage(actor, boardId, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
