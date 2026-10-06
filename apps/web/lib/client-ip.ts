import { isIP } from "node:net";

/**
 * The browser's address as reported by the reverse proxy in front of this app (nginx overwrites X-Forwarded-For with
 * the real peer, so the last entry is the one our own proxy wrote). Forwarding it matters: without it the gateway would
 * see every visitor as the web container's IP and its per-IP rate limits would throttle the whole site as one client.
 */
export function clientIp(headers: Headers): string | undefined {
  const entries = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const candidate = entries[entries.length - 1] ?? headers.get("x-real-ip")?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}

export const forwardedFor = (headers: Headers): Record<string, string> => {
  const ip = clientIp(headers);
  return ip ? { "x-forwarded-for": ip } : {};
};
