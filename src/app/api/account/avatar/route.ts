import { NextResponse } from "next/server";
import { requireRouteSession } from "@/server/auth/route-session";
import { AppError, forbidden, invalid } from "@/server/errors";
import { errorResponse, isTrustedOrigin } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { setAvatar } from "@/server/services/accounts";

export const dynamic = "force-dynamic";

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    if (!isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    const { actor } = await requireRouteSession(req);
    enforceRateLimit(`avatar:${actor.userId}`, 20, 60 * 60 * 1000);
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_AVATAR_BYTES + 64 * 1024) throw new AppError("PAYLOAD_TOO_LARGE", "Avatars must be under 8 MB.");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw invalid("Choose an image to upload.");
    if (file.size > MAX_AVATAR_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Avatars must be under 8 MB.");
    const profile = await setAvatar(actor, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ data: profile });
  } catch (error) {
    return errorResponse(error);
  }
}
