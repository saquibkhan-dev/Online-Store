import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Header format: `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">`.
 * The timestamp is part of the signed payload, so a captured request cannot be replayed outside the tolerance window.
 */
export function signPayload(secret: string, rawBody: Buffer | string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export type SignatureResult = "ok" | "malformed" | "expired" | "mismatch";

export function verifySignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  toleranceSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): SignatureResult {
  if (!header) return "malformed";
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isInteger(t) || !provided || !/^[0-9a-f]{64}$/i.test(provided)) return "malformed";
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return "expired";
  const expected = Buffer.from(signPayload(secret, rawBody, t).split("v1=")[1] ?? "", "hex");
  const given = Buffer.from(provided, "hex");
  // Lengths are equal (both 32 bytes) by the regex above, so timingSafeEqual cannot throw.
  return timingSafeEqual(expected, given) ? "ok" : "mismatch";
}
