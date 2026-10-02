import { NextResponse, type NextRequest } from "next/server";
import { pageContentSecurityPolicy } from "./security-headers";
import { SESSION_COOKIE } from "./server/auth/constants";

const PUBLIC_PREFIXES = ["/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/verify-email", "/invite", "/dev"];

/**
 * Cheap gate for page routes: visitors without a session cookie are sent to
 * sign-in. Real session validation and authorization happen server-side in
 * every layout, page and API route.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!isPublic && !request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  const headers = new Headers(request.headers);
  headers.set("x-forge-path", pathname + search);
  // A fresh nonce per page request; Next reads it from the request's CSP header and puts it on its scripts.
  const dev = process.env.NODE_ENV !== "production";
  const nonce = dev ? null : btoa(crypto.randomUUID());
  const csp = pageContentSecurityPolicy({ nonce, dev, storageOrigin: process.env.STORAGE_PUBLIC_ORIGIN ?? "" });
  if (nonce) headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|txt|woff2?)$).*)"],
};
