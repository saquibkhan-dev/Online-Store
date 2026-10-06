import { NextResponse, type NextRequest } from "next/server";

const isProd = process.env.NODE_ENV === "production";

function buildCsp(nonce: string): string {
  const analytics = process.env.ANALYTICS_DOMAIN?.trim()
    ? new URL(process.env.ANALYTICS_SCRIPT_URL?.trim() || "https://plausible.io/js/script.js").origin
    : null;
  return [
    "default-src 'self'",
    // Scripts run only if they carry this request's nonce. 'strict-dynamic' lets those trusted scripts load chunks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'", // React inline style attributes; no script risk
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${analytics ? ` ${analytics}` : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProd ? ["upgrade-insecure-requests"] : [])
  ].join("; ");
}

export function middleware(request: NextRequest) {
  // Force HTTPS as a second line of defence behind nginx. Only `x-edge-proto` is trusted: nginx overwrites it on every
  // request, whereas x-forwarded-proto is also injected by Next itself and would redirect health checks. No header
  // (local dev, container health probes, direct internal calls) means no redirect.
  if (isProd && process.env.FORCE_HTTPS !== "false" && request.headers.get("x-edge-proto") === "http") {
    const url = request.nextUrl.clone();
    url.protocol = "https:";
    url.port = "";
    url.host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
    return NextResponse.redirect(url, 308);
  }

  // Private pages: bounce signed-out visitors immediately (a real 307) instead of streaming a loading shell first.
  // This only looks for the presence of a session cookie; the pages and the gateway still verify it server-side.
  const path = request.nextUrl.pathname;
  if ((path === "/cart" || path === "/orders" || path.startsWith("/orders/")) && !request.cookies.has("access_token") && !request.cookies.has("refresh_token")) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(login, 307);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp); // Next reads the nonce from here to tag its own scripts

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  if (isProd) response.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|.*\\.(?:png|jpg|svg|ico|webp)$).*)" }]
};
