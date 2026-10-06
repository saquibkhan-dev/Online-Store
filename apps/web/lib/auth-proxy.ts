import { NextResponse } from "next/server";
import { forwardedFor } from "./client-ip";
import { isSameOrigin } from "./csrf";
import { API_URL, setSession, type TokenSet } from "./session";

const fail = (status: number, code: string, message: string) => NextResponse.json({ error: { code, message } }, { status });

/** A human needs at least this long to fill in the registration form. */
export const MIN_FORM_MS = 2000;
const MAX_FORM_AGE_MS = 24 * 3600 * 1000;

/**
 * Proxies login/register to the gateway. Spam defences, in addition to the gateway's per-IP limits and the user
 * service's per-account lockout: a honeypot field that real users never see, and a minimum fill-in time. Bots that post
 * straight to this route (without the hidden fields) are rejected with a deliberately vague message.
 */
export async function proxyAuth(req: Request, endpoint: "login" | "register"): Promise<NextResponse> {
  if (!isSameOrigin(req.headers)) return fail(403, "FORBIDDEN", "Cross-site request blocked");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "INVALID_JSON", "Malformed request");
  }

  const { company_website: honeypot, formStartedAt, ...fields } = body;
  const age = Date.now() - Number(formStartedAt);
  const looksAutomated = typeof honeypot === "string" && honeypot !== "";
  const tooFast = endpoint === "register" && !(age >= MIN_FORM_MS && age <= MAX_FORM_AGE_MS);
  if (looksAutomated || tooFast) return fail(400, "VALIDATION_ERROR", "We couldn't submit that. Please wait a moment and try again.");

  const res = await fetch(`${API_URL}/api/auth/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...forwardedFor(req.headers) },
    body: JSON.stringify(fields),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  }).catch(() => null);
  if (!res) return fail(502, "BAD_GATEWAY", "The service is temporarily unavailable");

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const out = (init: ResponseInit, payload: unknown) => {
    const r = NextResponse.json(payload, init);
    const retry = res.headers.get("retry-after");
    if (retry) r.headers.set("retry-after", retry);
    return r;
  };
  if (!res.ok) return out({ status: res.status }, data);
  await setSession(data as unknown as TokenSet); // tokens go into httpOnly cookies and never reach page scripts
  return out({}, { user: data.user });
}
