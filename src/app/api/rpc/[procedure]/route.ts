import { NextResponse } from "next/server";
import { applySessionRenewal, requireRouteSession } from "@/server/auth/route-session";
import { AppError, forbidden, notFound } from "@/server/errors";
import { errorResponse, isTrustedOrigin, readJsonBody } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { appRouter } from "@/server/rpc/router";

export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ procedure: string }> }) {
  try {
    if (!isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    if (!req.headers.get("content-type")?.includes("application/json")) {
      throw new AppError("VALIDATION", "Requests must be JSON.");
    }
    const { procedure: name } = await context.params;
    if (!Object.hasOwn(appRouter, name)) throw notFound("Endpoint");
    const procedure = appRouter[name as keyof typeof appRouter];

    const { session, actor, token } = await requireRouteSession(req);
    enforceRateLimit(`rpc:${actor.userId}`, 1200, 60_000);
    if (procedure.limit) enforceRateLimit(`rpc:${name}:${actor.userId}`, procedure.limit.max, procedure.limit.windowMs);

    // Inputs are small (text fields are capped far below this); files never travel through RPC.
    const body = await readJsonBody(req, 1024 * 1024);
    const input = procedure.input.parse(body);
    // The router is a heterogeneous map, so each handler is invoked through a common signature.
    const handler = procedure.handler as (ctx: unknown, input: unknown) => Promise<unknown>;
    const data = await handler({ actor, user: session.user }, input);

    const res = NextResponse.json({ data }, { headers: { "cache-control": "no-store" } });
    applySessionRenewal(res, session, token);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
