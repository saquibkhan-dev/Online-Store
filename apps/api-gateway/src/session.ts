import { safeEqual, TtlCache, type Logger, type Role } from "@commerce/shared";

export type LiveAccess = { role: Role } | null | "unavailable";

/**
 * Server-side session check. A valid signature only proves the token was issued; this confirms the account still
 * exists and returns its CURRENT role, so a deleted user or a demoted admin loses access within `ttlSeconds`
 * instead of when the token expires. Results are cached briefly per instance to keep this off the hot path.
 */
export class SessionVerifier {
  private readonly positive: TtlCache<{ role: Role }>;
  private readonly negative: TtlCache<true>;

  constructor(
    private readonly userServiceUrl: string,
    private readonly internalToken: string,
    private readonly logger: Logger,
    ttlSeconds: number,
    private readonly timeoutMs = 1500
  ) {
    this.positive = new TtlCache(ttlSeconds * 1000, 5000);
    this.negative = new TtlCache(Math.min(ttlSeconds, 5) * 1000, 5000);
  }

  async lookup(userId: string, ctx: { requestId: string; correlationId: string }): Promise<LiveAccess> {
    if (this.negative.get(userId)) return null;
    const cached = this.positive.get(userId);
    if (cached) return cached;
    try {
      const res = await fetch(`${this.userServiceUrl}/internal/users/${userId}/access`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "x-internal-auth": this.internalToken, "x-request-id": ctx.requestId, "x-correlation-id": ctx.correlationId }
      });
      if (res.status === 404) {
        this.negative.set(userId, true);
        return null;
      }
      if (!res.ok) throw new Error(`user-service responded ${res.status}`);
      const body = (await res.json()) as { role?: string };
      if (body.role !== "CUSTOMER" && body.role !== "ADMIN") throw new Error("malformed access response");
      const access = { role: body.role as Role };
      this.positive.set(userId, access);
      return access;
    } catch (err) {
      this.logger.error({ err: err instanceof Error ? err.message : String(err) }, "session verification unavailable");
      return "unavailable";
    }
  }
}

export { safeEqual };
