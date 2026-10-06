import { NextResponse, type NextRequest } from "next/server";
import { forwardedFor } from "@/lib/client-ip";
import { isAllowedBffPath, isSameOrigin } from "@/lib/csrf";
import { API_URL, ACCESS_COOKIE, REFRESH_COOKIE, tryRefresh } from "@/lib/session";

export const dynamic = "force-dynamic";

const FORWARDED_REQUEST_HEADERS = ["content-type", "idempotency-key", "accept"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "idempotent-replay", "x-request-id"];

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = path.join("/");
  if (!isAllowedBffPath(target)) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  const mutating = !["GET", "HEAD"].includes(req.method);
  if (mutating && !isSameOrigin(req.headers)) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Cross-site request blocked" } }, { status: 403 });
  }

  const body = mutating ? await req.text() : undefined;
  const call = (token: string | undefined) => {
    const headers = new Headers(forwardedFor(req.headers));
    for (const h of FORWARDED_REQUEST_HEADERS) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${API_URL}/${target}${req.nextUrl.search}`, { method: req.method, headers, body, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  };

  let upstream: Response;
  let refreshed: Awaited<ReturnType<typeof tryRefresh>> = null;
  try {
    upstream = await call(req.cookies.get(ACCESS_COOKIE)?.value);
    const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
    if (upstream.status === 401 && refresh) {
      refreshed = await tryRefresh(refresh);
      if (refreshed) upstream = await call(refreshed.accessToken);
    }
  } catch {
    return NextResponse.json({ error: { code: "BAD_GATEWAY", message: "The service is temporarily unavailable" } }, { status: 502 });
  }

  const out = new NextResponse(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status });
  for (const h of FORWARDED_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  if (upstream.status === 401) {
    out.cookies.delete(ACCESS_COOKIE);
    out.cookies.delete(REFRESH_COOKIE);
  }
  return out;
}

export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
