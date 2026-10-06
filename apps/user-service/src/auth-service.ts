import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { AppError, Errors, passwordBytesOk, signAccessToken, type Role } from "@commerce/shared";
import type { Config } from "./config";
import type { Db } from "./db";
import { Prisma } from "./generated/client";

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

type AuthConfig = Pick<Config, "JWT_ACCESS_SECRET" | "ACCESS_TOKEN_TTL_SECONDS" | "REFRESH_TOKEN_TTL_DAYS" | "BCRYPT_COST">;

/** Consecutive failures allowed before an address is locked, and the lock-out ceiling. */
export const LOCKOUT_AFTER = 8;
const MAX_LOCK_MINUTES = 15;
const FAILURE_WINDOW_MINUTES = 30;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const toPublic = (u: PublicUser): PublicUser => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export class AuthService {
  // Compared against when the email is unknown so login time does not reveal which emails exist.
  private readonly dummyHash: string;

  constructor(private readonly db: Db, private readonly config: AuthConfig) {
    this.dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), config.BCRYPT_COST);
  }

  async register(input: { email: string; password: string; name: string }) {
    if (!passwordBytesOk(input.password)) throw Errors.badRequest("PASSWORD_TOO_LONG", "Password must be at most 72 bytes");
    const passwordHash = await bcrypt.hash(input.password, this.config.BCRYPT_COST);
    try {
      const user = await this.db.user.create({ data: { email: input.email.toLowerCase(), name: input.name, passwordHash } });
      return { user: toPublic(user), ...(await this.issueTokens(user)) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw Errors.conflict("EMAIL_EXISTS", "Email already registered");
      }
      throw err;
    }
  }

  async login(input: { email: string; password: string }) {
    const email = input.email.toLowerCase();
    const key = sha256(email);
    await this.assertNotLocked(key); // checked before bcrypt so a locked address cannot be used to burn CPU
    const user = await this.db.user.findUnique({ where: { email } });
    // Over-long passwords can never match (they could not have been registered); compare against a dummy so timing is unchanged.
    const comparable = passwordBytesOk(input.password) ? input.password : "\u0000invalid";
    const ok = await bcrypt.compare(comparable, user?.passwordHash ?? this.dummyHash);
    if (!user || !ok || !passwordBytesOk(input.password)) {
      await this.recordFailure(key);
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    await this.db.$executeRaw`DELETE FROM "LoginThrottle" WHERE "emailHash" = ${key}`;
    return { user: toPublic(user), ...(await this.issueTokens(user)) };
  }

  private async assertNotLocked(key: string): Promise<void> {
    const rows = await this.db.$queryRaw<Array<{ seconds: number | null }>>`
      SELECT CEIL(EXTRACT(EPOCH FROM ("lockedUntil" - now())))::int AS seconds
      FROM "LoginThrottle" WHERE "emailHash" = ${key} AND "lockedUntil" > now()`;
    const seconds = rows[0]?.seconds;
    if (seconds && seconds > 0) {
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many failed attempts. Please wait and try again.", { retryAfterSeconds: seconds });
    }
  }

  private async recordFailure(key: string): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO "LoginThrottle" ("emailHash", "failures", "updatedAt") VALUES (${key}, 0, now()) ON CONFLICT DO NOTHING`;
    const rows = await this.db.$queryRaw<Array<{ failures: number }>>`
      UPDATE "LoginThrottle"
      SET "failures" = CASE WHEN "updatedAt" < now() - make_interval(mins => ${FAILURE_WINDOW_MINUTES}::int) THEN 1 ELSE "failures" + 1 END,
          "updatedAt" = now()
      WHERE "emailHash" = ${key}
      RETURNING "failures"`;
    const failures = rows[0]?.failures ?? 0;
    if (failures >= LOCKOUT_AFTER) {
      const minutes = Math.min(MAX_LOCK_MINUTES, 2 ** (failures - LOCKOUT_AFTER));
      await this.db.$executeRaw`UPDATE "LoginThrottle" SET "lockedUntil" = now() + make_interval(mins => ${minutes}::int) WHERE "emailHash" = ${key}`;
    }
  }

  /** Live account state for the gateway's server-side session check. */
  async access(userId: string): Promise<{ role: Role } | null> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user ? { role: user.role } : null;
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session family. */
  async refresh(refreshToken: string) {
    const session = await this.db.session.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { user: true } });
    if (!session) throw Errors.unauthorized("Invalid refresh token");
    if (session.revokedAt) {
      await this.db.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw Errors.unauthorized("Refresh token reuse detected");
    }
    if (session.expiresAt < new Date()) throw Errors.unauthorized("Refresh token expired");
    const next = await this.issueTokens(session.user, session.familyId, async (tx, newId) => {
      // updateMany keeps this atomic: only one of two concurrent refreshes can flip revokedAt from null.
      const claimed = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: newId }
      });
      if (claimed.count === 0) throw Errors.unauthorized("Refresh token reuse detected");
    });
    return { user: toPublic(session.user), ...next };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.session.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw Errors.unauthorized();
    return toPublic(user);
  }

  async listUsers(page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.db.user.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      this.db.user.count()
    ]);
    return { items: items.map((u) => ({ ...toPublic(u), createdAt: u.createdAt })), total, page, limit };
  }

  /** Removes sessions that expired (or were revoked) more than `graceDays` ago. Reuse detection needs recent revoked rows. */
  async pruneSessions(graceDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - graceDays * 86_400_000);
    const result = await this.db.session.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } });
    await this.db.$executeRaw`DELETE FROM "LoginThrottle" WHERE "updatedAt" < now() - interval '1 day'`;
    return result.count;
  }

  /** Creates the first admin from environment config; never changes an existing account's password. */
  async ensureAdmin(email: string, password: string): Promise<boolean> {
    const existing = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return false;
    await this.db.user.create({
      data: { email: email.toLowerCase(), name: "Administrator", role: "ADMIN", passwordHash: await bcrypt.hash(password, this.config.BCRYPT_COST) }
    });
    return true;
  }

  private async issueTokens(
    user: { id: string; role: Role },
    familyId: string = randomUUID(),
    beforeCreate?: (tx: Prisma.TransactionClient, newSessionId: string) => Promise<void>
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(48).toString("base64url");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.db.$transaction(async (tx) => {
      if (beforeCreate) await beforeCreate(tx, id);
      await tx.session.create({ data: { id, userId: user.id, familyId, tokenHash: sha256(refreshToken), expiresAt } });
    });
    return {
      accessToken: signAccessToken({ sub: user.id, role: user.role }, this.config.JWT_ACCESS_SECRET, this.config.ACCESS_TOKEN_TTL_SECONDS),
      refreshToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS
    };
  }
}
