import { NextResponse } from "next/server";
import { hashToken } from "@/server/auth/crypto";
import { AppError } from "@/server/errors";
import { enforceSharedRateLimit } from "@/server/rate-limit";
import { calendarFeedFor } from "@/server/services/calendar-feed";

export const dynamic = "force-dynamic";

/**
 * A person's private calendar feed (/api/calendar/<token>.ics), fetched by calendar apps without
 * a session. Unknown or revoked tokens get the same 404 as anything else.
 */
export async function GET(_req: Request, context: { params: Promise<{ token: string }> }) {
  const { token: raw } = await context.params;
  const token = raw.replace(/\.ics$/, "");
  try {
    await enforceSharedRateLimit(`ics:${hashToken(token).slice(0, 32)}`, 120, 60 * 60 * 1000);
  } catch (error) {
    if (error instanceof AppError) return new NextResponse("Too many requests", { status: 429 });
    throw error;
  }
  const body = await calendarFeedFor(token);
  if (!body) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="forge.ics"',
      // Personal data: never cached by shared caches.
      "cache-control": "private, max-age=300",
      "x-robots-tag": "noindex",
    },
  });
}
