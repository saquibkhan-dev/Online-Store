import jwt from "jsonwebtoken";
import { z } from "zod";

export const roleSchema = z.enum(["CUSTOMER", "ADMIN"]);
export type Role = z.infer<typeof roleSchema>;

export interface AccessClaims {
  sub: string;
  role: Role;
}

// exp and iat are mandatory: a token that never expires is rejected even if the signature is valid.
const verifiedSchema = z.object({ sub: z.string().uuid(), role: roleSchema, exp: z.number().int().positive(), iat: z.number().int().positive() });

const ISSUER = "commerce-user-service";

export function signAccessToken(claims: AccessClaims, secret: string, expiresInSeconds: number): string {
  return jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: expiresInSeconds, issuer: ISSUER });
}

/** Returns the claims, or null for any invalid, unsigned, expired or non-expiring token. */
export function verifyAccessToken(token: string, secret: string): AccessClaims | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: ISSUER });
    const parsed = verifiedSchema.safeParse(decoded);
    return parsed.success ? { sub: parsed.data.sub, role: parsed.data.role } : null;
  } catch {
    return null;
  }
}
