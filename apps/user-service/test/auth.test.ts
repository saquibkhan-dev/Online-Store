import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger, signAccessToken } from "@commerce/shared";
import { createApp } from "../src/app";
import { AuthService } from "../src/auth-service";
import { loadUserConfig } from "../src/config";
import { createDb } from "../src/db";

const TOKEN = "t".repeat(40);
const config = loadUserConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/user_test",
  INTERNAL_SERVICE_TOKEN: TOKEN,
  JWT_ACCESS_SECRET: "j".repeat(40),
  BCRYPT_COST: "4"
});
const db = createDb(config.DATABASE_URL, 5);
const app = createApp({ db, config, logger: createLogger("test", "silent") });
const gw = { "x-internal-auth": TOKEN };
const body = { email: "Ada@Example.com", password: "correct horse battery", name: "Ada Lovelace" };

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await db.session.deleteMany();
  await db.user.deleteMany();
});

describe("auth", () => {
  it("rejects requests that bypass the gateway", async () => {
    await request(app).post("/api/auth/login").send({}).expect(403);
  });

  it("registers, normalises email, and returns tokens", async () => {
    const res = await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    expect(res.body.user).toMatchObject({ email: "ada@example.com", role: "CUSTOMER" });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it("returns 409 for a duplicate email, including a concurrent race", async () => {
    await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    await request(app).post("/api/auth/register").set(gw).send({ ...body, email: "ADA@example.com" }).expect(409);
    const race = await Promise.all(
      [1, 2, 3].map(() => request(app).post("/api/auth/register").set(gw).send({ ...body, email: "race@example.com" }))
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("validates input and never leaks details of server errors", async () => {
    const res = await request(app).post("/api/auth/register").set(gw).send({ email: "x", password: "short", name: "" }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.requestId).toBeTruthy();
    await request(app).post("/api/auth/login").set(gw).set("content-type", "application/json").send("{bad").expect(400);
  });

  it("logs in with the same error for unknown email and wrong password", async () => {
    await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    const wrong = await request(app).post("/api/auth/login").set(gw).send({ email: body.email, password: "wrong-password-1" }).expect(401);
    const unknown = await request(app).post("/api/auth/login").set(gw).send({ email: "no@one.com", password: "wrong-password-1" }).expect(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    await request(app).post("/api/auth/login").set(gw).send({ email: body.email, password: body.password }).expect(200);
  });

  it("rotates refresh tokens and revokes the family when an old one is replayed", async () => {
    const first = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    const second = (await request(app).post("/api/auth/refresh").set(gw).send({ refreshToken: first.refreshToken }).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await request(app).post("/api/auth/refresh").set(gw).send({ refreshToken: first.refreshToken }).expect(401); // replay
    await request(app).post("/api/auth/refresh").set(gw).send({ refreshToken: second.refreshToken }).expect(401); // family revoked
  });

  it("lets only one of two concurrent refreshes win", async () => {
    const first = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    const results = await Promise.all(
      [1, 2].map(() => request(app).post("/api/auth/refresh").set(gw).send({ refreshToken: first.refreshToken }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("logout revokes the refresh token and is idempotent", async () => {
    const first = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    await request(app).post("/api/auth/logout").set(gw).send({ refreshToken: first.refreshToken }).expect(204);
    await request(app).post("/api/auth/logout").set(gw).send({ refreshToken: first.refreshToken }).expect(204);
    await request(app).post("/api/auth/refresh").set(gw).send({ refreshToken: first.refreshToken }).expect(401);
  });

  it("enforces authentication and the admin role on protected routes", async () => {
    const reg = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    await request(app).get("/api/auth/me").set(gw).expect(401);
    const me = await request(app).get("/api/auth/me").set({ ...gw, "x-user-id": reg.user.id, "x-user-role": "CUSTOMER" }).expect(200);
    expect(me.body.email).toBe("ada@example.com");
    await request(app).get("/api/admin/users").set({ ...gw, "x-user-id": reg.user.id, "x-user-role": "CUSTOMER" }).expect(403);
    const admin = await request(app).get("/api/admin/users").set({ ...gw, "x-user-id": reg.user.id, "x-user-role": "ADMIN" }).expect(200);
    expect(admin.body.total).toBe(1);
  });

  it("issues access tokens the gateway can verify", async () => {
    const reg = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    const { verifyAccessToken } = await import("@commerce/shared");
    expect(verifyAccessToken(reg.accessToken, "j".repeat(40))).toMatchObject({ sub: reg.user.id, role: "CUSTOMER" });
    expect(verifyAccessToken(reg.accessToken, "k".repeat(40))).toBeNull();
    expect(verifyAccessToken(signAccessToken({ sub: reg.user.id, role: "ADMIN" }, "j".repeat(40), -10), "j".repeat(40))).toBeNull();
  });
});

describe("session retention", () => {
  it("prunes sessions that expired long ago and keeps live and recently revoked ones", async () => {
    const auth = new AuthService(db, config);
    const reg = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    const user = await db.user.findUniqueOrThrow({ where: { id: reg.user.id } });
    const old = new Date(Date.now() - 30 * 86_400_000);
    const mk = (extra: object) => db.session.create({ data: { userId: user.id, familyId: user.id, tokenHash: `h-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000), ...extra } });
    await mk({ expiresAt: old });
    await mk({ revokedAt: old });
    await mk({ revokedAt: new Date() });
    expect(await auth.pruneSessions()).toBe(2);
    expect(await db.session.count()).toBe(2); // the registration session + the recently revoked one
  });
});

describe("login throttling", () => {
  const login = (password: string, email = body.email) => request(app).post("/api/auth/login").set(gw).send({ email, password });

  beforeEach(async () => { await db.$executeRaw`DELETE FROM "LoginThrottle"`; });

  it("locks an address after 8 consecutive failures, with Retry-After, and rejects even the right password while locked", async () => {
    await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    for (let i = 0; i < 7; i++) await login("wrong-password-1").expect(401);
    await login(body.password).expect(200); // still under the threshold; success clears the counter
    for (let i = 0; i < 8; i++) await login("wrong-password-1").expect(401);
    const locked = await login(body.password).expect(429);
    expect(locked.body.error.code).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("applies identically to addresses that do not exist (no account oracle) and is per address", async () => {
    for (let i = 0; i < 8; i++) await login("wrong-password-1", "ghost@example.com").expect(401);
    await login("wrong-password-1", "ghost@example.com").expect(429);
    await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    await login(body.password).expect(200); // a different address is unaffected
  });

  it("unlocks when the lock window passes, and stale failures stop counting", async () => {
    await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    for (let i = 0; i < 8; i++) await login("wrong-password-1").expect(401);
    await login(body.password).expect(429);
    await db.$executeRaw`UPDATE "LoginThrottle" SET "lockedUntil" = now() - interval '1 second'`;
    await login(body.password).expect(200);
    for (let i = 0; i < 7; i++) await login("wrong-password-1").expect(401);
    await db.$executeRaw`UPDATE "LoginThrottle" SET "updatedAt" = now() - interval '2 hours'`;
    for (let i = 0; i < 7; i++) await login("wrong-password-1").expect(401); // would have locked if the old failures still counted
    await login(body.password).expect(200);
  });

  it("never lets a password longer than 72 bytes register or match by prefix", async () => {
    const long = "é".repeat(40); // 80 bytes
    expect((await request(app).post("/api/auth/register").set(gw).send({ ...body, password: long })).body.error.code).toBe("VALIDATION_ERROR");
    await request(app).post("/api/auth/register").set(gw).send(body).expect(201);
    await login(body.password + "x".repeat(60)).expect(401); // correct 72-byte prefix + junk must NOT log in
  });
});

describe("session access lookup", () => {
  it("reports live role and 404 for unknown accounts, and requires the internal token", async () => {
    const reg = (await request(app).post("/api/auth/register").set(gw).send(body)).body;
    expect((await request(app).get(`/internal/users/${reg.user.id}/access`).set(gw).expect(200)).body).toEqual({ role: "CUSTOMER" });
    await db.user.update({ where: { id: reg.user.id }, data: { role: "ADMIN" } });
    expect((await request(app).get(`/internal/users/${reg.user.id}/access`).set(gw)).body).toEqual({ role: "ADMIN" });
    await request(app).get("/internal/users/11111111-1111-4111-8111-111111111111/access").set(gw).expect(404);
    await request(app).get(`/internal/users/${reg.user.id}/access`).expect(403);
  });

  it("rejects control characters in names with 400, never 500", async () => {
    const res = await request(app).post("/api/auth/register").set(gw).send({ ...body, name: "Ada\u0000Lovelace" });
    expect(res.status).toBe(400);
  });
});
