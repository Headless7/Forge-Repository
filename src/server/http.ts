import { ZodError } from "zod";
import { appOrigin, isProduction, trustedProxyHops } from "./env";
import { AppError, STATUS_BY_CODE } from "./errors";

/**
 * The client's IP as reported by the trusted proxies in front of the app (TRUSTED_PROXY_HOPS).
 * Each proxy appends the address it received the request from, so with N trusted proxies the
 * client is the N-th entry from the right; anything further left was written by the client
 * and is ignored. With no trusted proxy the headers are ignored entirely (null).
 */
export function clientIp(req: Request): string | null {
  return clientIpFrom(req.headers, trustedProxyHops());
}

export function clientIpFrom(headers: Headers, hops: number): string | null {
  if (hops === 0) return null;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = chain.length ? chain[Math.max(0, chain.length - hops)]! : headers.get("x-real-ip");
  return ip ? ip.slice(0, 64) : null;
}

export function userAgent(req: Request): string | null {
  return req.headers.get("user-agent")?.slice(0, 400) ?? null;
}

/** Where the request says it was sent to — only believed in development (local hostnames vary). */
function requestOrigin(req: Request): string | null {
  if (isProduction()) return null;
  const url = new URL(req.url);
  const host = (trustedProxyHops() > 0 ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host") ?? url.host;
  const proto = (trustedProxyHops() > 0 ? req.headers.get("x-forwarded-proto") : null) ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/**
 * CSRF defence for state-changing requests: browsers always attach an Origin
 * header to cross-site POST/PUT/DELETE, which an attacker cannot forge.
 * Combined with SameSite=Lax session cookies this blocks cross-site writes.
 * In production only APP_URL's origin is accepted.
 */
export function isTrustedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const allowed = new Set([appOrigin(), requestOrigin(req)].filter((o): o is string => Boolean(o)));
  if (origin) return allowed.has(origin);
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Reads a JSON request body without buffering more than `maxBytes` (a huge body is refused
 * as it streams in, before it can exhaust memory).
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "The request is too large.");
  if (!req.body) throw new AppError("VALIDATION", "Malformed request body.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AppError("PAYLOAD_TOO_LARGE", "The request is too large.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("VALIDATION", "Malformed request body.");
  }
}

export function jsonResponse(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Converts any thrown value into a safe JSON error. Internal details never leave the server. */
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    const headers: HeadersInit = {};
    if (error.code === "RATE_LIMITED" && typeof error.details?.retryAfterMs === "number") {
      (headers as Record<string, string>)["retry-after"] = String(Math.ceil(error.details.retryAfterMs / 1000));
    }
    return jsonResponse(
      { error: { code: error.code, message: error.message, details: error.details } } satisfies ErrorBody,
      { status: STATUS_BY_CODE[error.code], headers },
    );
  }
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const field = first?.path.join(".");
    return jsonResponse(
      {
        error: {
          code: "VALIDATION",
          message: first ? `${field ? `${field}: ` : ""}${first.message}` : "Invalid input.",
          details: { issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        },
      } satisfies ErrorBody,
      { status: 400 },
    );
  }
  console.error("[forge] unhandled error", error);
  return jsonResponse(
    { error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again." } } satisfies ErrorBody,
    { status: 500 },
  );
}
