import { cookies, headers } from "next/headers";
import { forwardedFor } from "./client-ip";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

export const API_URL = process.env.API_URL ?? "http://api-gateway:4000";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const base = { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" } as const;

export async function setSession(tokens: TokenSet): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: tokens.expiresIn });
  jar.set(REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: 30 * 86_400 });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/** Server-side call to the gateway on behalf of the current user, refreshing an expired access token once. */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const jar = await cookies();
  const visitor = forwardedFor(await headers());
  const call = (token: string | undefined) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { ...(init.headers as Record<string, string>), ...visitor, ...(token ? { authorization: `Bearer ${token}` } : {}) }
    });
  let res = await call(jar.get(ACCESS_COOKIE)?.value);
  if (res.status === 401 && jar.get(REFRESH_COOKIE)?.value) {
    const refreshed = await tryRefresh(jar.get(REFRESH_COOKIE)?.value ?? "");
    if (refreshed) res = await call(refreshed.accessToken);
  }
  return res;
}

export async function tryRefresh(refreshToken: string): Promise<TokenSet | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", ...forwardedFor(await headers()) },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return null;
    const tokens = (await res.json()) as TokenSet;
    try {
      await setSession(tokens); // only allowed in route handlers / actions; ignored when rendering a page
    } catch {
      /* rendering context: the caller still uses the fresh token for this request */
    }
    return tokens;
  } catch {
    return null;
  }
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: "CUSTOMER" | "ADMIN";
}

export async function currentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE) && !jar.get(REFRESH_COOKIE)) return null;
  try {
    const res = await gatewayFetch("/api/auth/me");
    return res.ok ? ((await res.json()) as CurrentUser) : null;
  } catch {
    return null;
  }
}
