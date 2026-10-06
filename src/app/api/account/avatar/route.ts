import { NextResponse } from "next/server";
import { requireRouteSession } from "@/server/auth/route-session";
import { AppError, forbidden, invalid } from "@/server/errors";
import { errorResponse, isTrustedOrigin, readBodyLimited } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { setAvatar } from "@/server/services/accounts";

export const dynamic = "force-dynamic";

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    if (!isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    const { actor } = await requireRouteSession(req);
    enforceRateLimit(`avatar:${actor.userId}`, 20, 60 * 60 * 1000);
    // Buffered with a hard cap first: formData() alone would read any size (e.g. a chunked body with no Content-Length).
    const body = await readBodyLimited(req, MAX_AVATAR_BYTES + 64 * 1024, "Avatars must be under 8 MB.");
    const form = await new Response(new Uint8Array(body), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData().catch(() => {
      throw invalid("Choose an image to upload.");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw invalid("Choose an image to upload.");
    if (file.size > MAX_AVATAR_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Avatars must be under 8 MB.");
    const profile = await setAvatar(actor, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ data: profile });
  } catch (error) {
    return errorResponse(error);
  }
}
