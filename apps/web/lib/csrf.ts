/**
 * State-changing BFF requests must come from this site. SameSite=Lax already blocks cross-site POSTs with cookies;
 * this additionally verifies the Origin header (falling back to Referer) against the Host the request was sent to.
 */
export function isSameOrigin(headers: Headers): boolean {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const origin = headers.get("origin") ?? headers.get("referer");
  if (!host || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const ALLOWED = [
  /^api\/(products|categories)(\/[0-9a-f-]{36})?$/i,
  /^api\/cart(\/items(\/[0-9a-f-]{36})?)?$/i,
  /^api\/(checkout|orders)$/,
  /^api\/orders\/[0-9a-f-]{36}(\/cancel)?$/i,
  /^api\/notifications(\/[0-9a-f-]{36}\/read)?$/i
];

/** The browser may only reach these gateway paths through the BFF. Auth and webhooks have dedicated handling. */
export const isAllowedBffPath = (path: string): boolean => ALLOWED.some((r) => r.test(path));
