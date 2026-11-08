import { NextResponse } from "next/server";
import { assertApiTokenScope, touchApiToken } from "@/server/auth/api-tokens";
import { applySessionRenewal, bearerTokenFrom, requireRouteSession, requireRouteToken } from "@/server/auth/route-session";
import { AppError, forbidden, notFound } from "@/server/errors";
import { errorResponse, isTrustedOrigin, readJsonBody } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import type { RpcContext, ScopeRef } from "@/server/rpc/procedure";
import { appRouter } from "@/server/rpc/router";

export const dynamic = "force-dynamic";

/** Bearer requests have no cookie to ride on, so the origin check doesn't apply; they get their own budget instead. */
const TOKEN_RPC_LIMIT = { max: 300, windowMs: 60_000 };

export async function POST(req: Request, context: { params: Promise<{ procedure: string }> }) {
  try {
    const bearer = bearerTokenFrom(req);
    if (!bearer && !isTrustedOrigin(req)) throw forbidden("Cross-site request blocked.");
    if (!req.headers.get("content-type")?.includes("application/json")) {
      throw new AppError("VALIDATION", "Requests must be JSON.");
    }
    const { procedure: name } = await context.params;
    if (!Object.hasOwn(appRouter, name)) throw notFound("Endpoint");
    const procedure = appRouter[name as keyof typeof appRouter];
    // The router is a heterogeneous map, so each handler is invoked through a common signature.
    const handler = procedure.handler as (ctx: RpcContext, input: unknown) => Promise<unknown>;

    if (bearer) {
      // An API token (see lib/api-tokens): acts as the bot member, limited to its allowlist and projects.
      // An invalid token is refused outright; it never falls back to the cookie.
      const { token, user, actor } = await requireRouteToken(req, bearer);
      const scope = procedure.scope as ((input: unknown) => ScopeRef) | undefined;
      if (!scope || !token.procedures.includes(name)) throw forbidden(`This token can't call ${name}.`);
      enforceRateLimit(`rpc:token:${token.id}`, TOKEN_RPC_LIMIT.max, TOKEN_RPC_LIMIT.windowMs);
      if (procedure.limit) enforceRateLimit(`rpc:${name}:${actor.userId}`, procedure.limit.max, procedure.limit.windowMs);

      const body = await readJsonBody(req, 1024 * 1024);
      const input = procedure.input.parse(body);
      await assertApiTokenScope(token, scope(input));
      const data = await handler({ actor, user }, input);
      await touchApiToken(token);
      return NextResponse.json({ data }, { headers: { "cache-control": "no-store" } });
    }

    const { session, actor, token } = await requireRouteSession(req);
    enforceRateLimit(`rpc:${actor.userId}`, 1200, 60_000);
    if (procedure.limit) enforceRateLimit(`rpc:${name}:${actor.userId}`, procedure.limit.max, procedure.limit.windowMs);

    // Inputs are small (text fields are capped far below this); files never travel through RPC.
    const body = await readJsonBody(req, 1024 * 1024);
    const input = procedure.input.parse(body);
    const data = await handler({ actor, user: session.user }, input);

    const res = NextResponse.json({ data }, { headers: { "cache-control": "no-store" } });
    applySessionRenewal(res, session, token);
    return res;
  } catch (error) {
    return errorResponse(error);
  }
}
