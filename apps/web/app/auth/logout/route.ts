import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { forwardedFor } from "@/lib/client-ip";
import { isSameOrigin } from "@/lib/csrf";
import { API_URL, clearSession, REFRESH_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req.headers)) return NextResponse.json({ error: { code: "FORBIDDEN", message: "Cross-site request blocked" } }, { status: 403 });
  const refreshToken = (await cookies()).get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: "POST", headers: { "content-type": "application/json", ...forwardedFor(req.headers) }, body: JSON.stringify({ refreshToken }), signal: AbortSignal.timeout(5000)
    }).catch(() => undefined); // best effort: the cookies are cleared regardless
  }
  await clearSession();
  return new NextResponse(null, { status: 204 });
}
