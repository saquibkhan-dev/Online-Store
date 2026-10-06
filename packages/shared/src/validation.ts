import { z } from "zod";

// Control characters (including NUL, which Postgres cannot store and which would otherwise surface as a 500).
/* eslint-disable no-control-regex -- matching control characters is the purpose of these patterns */
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F\u2028\u2029]/;
const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;
/* eslint-enable no-control-regex */
const wellFormed = (s: string) => (s as { isWellFormed?: () => boolean }).isWellFormed?.() !== false;

/**
 * Free-text input: rejects control characters and malformed unicode, normalises to NFC and trims.
 * HTML is NOT stripped here: output encoding (React escaping, JSON responses) is the XSS defence, and silently
 * rewriting user text corrupts legitimate data. Never render these values with innerHTML.
 */
export function text(min: number, max: number, opts: { multiline?: boolean } = {}) {
  const forbidden = opts.multiline ? MULTI_LINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN;
  return z
    .string()
    .max(max * 4) // cheap bound before any further processing
    .refine((s) => !forbidden.test(s), "contains invalid characters")
    .refine(wellFormed, "contains invalid characters")
    .transform((s) => s.normalize("NFC").trim())
    .pipe(z.string().min(min).max(max));
}

/** bcrypt only uses the first 72 bytes; refuse longer passwords rather than silently truncating them. */
export const MAX_PASSWORD_BYTES = 72;
export const passwordBytesOk = (p: string) => Buffer.byteLength(p, "utf8") <= MAX_PASSWORD_BYTES;
