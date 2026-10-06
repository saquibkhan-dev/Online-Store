import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger, signAccessToken } from "@commerce/shared";
import { createApp } from "../src/app";
import { loadGatewayConfig } from "../src/config";
import { findRule } from "../src/routes";

const SECRET = "j".repeat(40);
const TOKEN = "i".repeat(40);
const uid = "11111111-1111-4111-8111-111111111111";
const oid = "22222222-2222-4222-8222-222222222222";
const adminUid = "99999999-9999-4999-8999-999999999999";
const ghostUid = "88888888-8888-4888-8888-888888888888"; // valid token, but the account no longer exists
let accessMode: "normal" | "down" = "normal";
const bearer = (role: "CUSTOMER" | "ADMIN" = "CUSTOMER", ttl = 600, sub = role === "ADMIN" ? adminUid : uid) => `Bearer ${signAccessToken({ sub, role }, SECRET, ttl)}`;

// One stub upstream that echoes what the gateway forwarded.
const upstream = http.createServer((req, res) => {
  const access = /^\/internal\/users\/([0-9a-f-]{36})\/access$/.exec(req.url ?? "");
  if (access) {
    res.setHeader("content-type", "application/json");
    if (accessMode === "down") return void res.writeHead(500).end("{}");
    if (access[1] === ghostUid) return void res.writeHead(404).end("{}");
    return void res.end(JSON.stringify({ role: access[1] === adminUid ? "ADMIN" : "CUSTOMER" }));
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, bodySha: createHash("sha256").update(body).digest("hex"), bodyLength: body.length }));
  });
});
let app: ReturnType<typeof createApp>;
let deadPort = 0;

beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const config = loadGatewayConfig({
    NODE_ENV: "test", INTERNAL_SERVICE_TOKEN: TOKEN, JWT_ACCESS_SECRET: SECRET,
    USER_SERVICE_URL: base, PRODUCT_SERVICE_URL: base, INVENTORY_SERVICE_URL: base, ORDER_SERVICE_URL: base, NOTIFICATION_SERVICE_URL: base,
    PAYMENT_SERVICE_URL: `http://127.0.0.1:${deadPort}`,
    SESSION_CACHE_SECONDS: "0", AUTH_RATE_LIMIT_PER_15_MIN: "5", CORS_ORIGINS: "https://shop.example.com", TRUST_PROXY_HOPS: "0"
  });
  app = createApp({ config, logger: createLogger("test", "silent") });
});
afterAll(() => new Promise((r) => upstream.close(r)));

describe("route policy", () => {
  it("only exposes what is listed; internal and unknown paths are 404", async () => {
    await request(app).get("/internal/products/batch?ids=x").expect(404);
    await request(app).get("/api/unknown").expect(404);
    await request(app).get("/api/admin/analytics").set("authorization", bearer("ADMIN")).expect(404);
    expect(findRule("DELETE", "/api/orders")).toBeUndefined();
  });

  it("serves public reads without a token and forwards the original path and query", async () => {
    const res = await request(app).get("/api/products?search=lamp&limit=5").expect(200);
    expect(res.body.url).toBe("/api/products?search=lamp&limit=5");
    expect(res.body.headers["x-user-id"]).toBeUndefined();
    expect(res.body.headers["x-internal-auth"]).toBe(TOKEN);
  });

  it("requires a token for private routes and the admin role for admin routes", async () => {
    await request(app).get("/api/cart").expect(401);
    await request(app).post("/api/products").send({}).expect(401);
    await request(app).post("/api/products").set("authorization", bearer("CUSTOMER")).send({}).expect(403);
    await request(app).get("/api/admin/orders").set("authorization", bearer("CUSTOMER")).expect(403);
    await request(app).post("/api/products").set("authorization", bearer("ADMIN")).send({}).expect(200);
    await request(app).put(`/api/admin/inventory/${uid}`).set("authorization", bearer("ADMIN")).send({ quantity: 1 }).expect(200);
    await request(app).post(`/api/orders/${oid}/cancel`).set("authorization", bearer()).expect(200);
  });

  it("rejects bad, tampered, wrong-secret and expired tokens, even on public routes", async () => {
    const good = bearer().slice(7);
    const wrongSecret = `Bearer ${signAccessToken({ sub: uid, role: "ADMIN" }, "k".repeat(40), 600)}`;
    for (const h of ["Bearer garbage", `Bearer ${good.slice(0, -2)}xx`, wrongSecret, bearer("CUSTOMER", -10), "Basic abc", "Bearer "]) {
      await request(app).get("/api/products").set("authorization", h).expect(401);
      await request(app).get("/api/cart").set("authorization", h).expect(401);
    }
  });
});

describe("identity propagation", () => {
  it("injects verified identity and drops the bearer token", async () => {
    const res = await request(app).get("/api/cart").set("authorization", bearer("CUSTOMER")).expect(200);
    expect(res.body.headers).toMatchObject({ "x-user-id": uid, "x-user-role": "CUSTOMER", "x-internal-auth": TOKEN });
    expect(res.body.headers.authorization).toBeUndefined();
    expect(res.body.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("overwrites identity headers a client tries to forge", async () => {
    const forged = { "x-user-id": "99999999-9999-4999-8999-999999999999", "x-user-role": "ADMIN", "x-internal-auth": "attacker" };
    const anon = await request(app).get("/api/products").set(forged).expect(200);
    expect(anon.body.headers["x-user-id"]).toBeUndefined();
    expect(anon.body.headers["x-user-role"]).toBeUndefined();
    expect(anon.body.headers["x-internal-auth"]).toBe(TOKEN);
    const customer = await request(app).get("/api/cart").set("authorization", bearer("CUSTOMER")).set(forged).expect(200);
    expect(customer.body.headers).toMatchObject({ "x-user-id": uid, "x-user-role": "CUSTOMER" });
    await request(app).get("/api/admin/orders").set("authorization", bearer("CUSTOMER")).set(forged).expect(403);
  });

  it("keeps a valid caller-supplied request id and replaces junk", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const ok = await request(app).get("/api/products").set("x-request-id", id).expect(200);
    expect(ok.headers["x-request-id"]).toBe(id);
    const bad = await request(app).get("/api/products").set("x-request-id", "<script>").expect(200);
    expect(bad.headers["x-request-id"]).not.toBe("<script>");
  });
});

describe("transport behaviour", () => {
  it("forwards request bodies byte-for-byte (needed for webhook signatures)", async () => {
    const raw = '{"id":"evt_1",  "spacing":   "matters"}\n';
    const res = await request(app).post("/api/auth/login").set("content-type", "application/json").send(raw).expect(200);
    expect(res.body.bodySha).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("returns a clean 502 when a service is down, without leaking internals", async () => {
    const res = await request(app).post("/api/payments/webhook").send({}).expect(502);
    expect(res.body.error).toMatchObject({ code: "BAD_GATEWAY" });
    expect(JSON.stringify(res.body)).not.toContain(String(deadPort));
  });

  it("rejects oversized declared bodies", async () => {
    await request(app).post("/api/auth/login").set("content-length", "2000000").set("content-type", "application/json").send("{}").expect(413);
  });

  it("allows only configured CORS origins and sets security headers", async () => {
    const allowed = await request(app).get("/api/products").set("origin", "https://shop.example.com").expect(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://shop.example.com");
    const denied = await request(app).get("/api/products").set("origin", "https://evil.example.com").expect(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(allowed.headers["x-content-type-options"]).toBe("nosniff");
    expect(allowed.headers["x-powered-by"]).toBeUndefined();
  });

  it("exposes health without auth and does not proxy it", async () => {
    expect((await request(app).get("/health").expect(200)).body).toEqual({ status: "ok", service: "api-gateway" });
    await request(app).get("/ready").expect(200);
  });
});

describe("server-side session verification", () => {
  it("rejects a validly signed token whose account no longer exists", async () => {
    const res = await request(app).get("/api/cart").set("authorization", bearer("CUSTOMER", 600, ghostUid));
    expect(res.status).toBe(401);
  });

  it("uses the LIVE role, not the token's claim: a token saying ADMIN for a customer account is a customer", async () => {
    const lying = `Bearer ${signAccessToken({ sub: uid, role: "ADMIN" }, SECRET, 600)}`; // account uid is a CUSTOMER
    await request(app).get("/api/admin/orders").set("authorization", lying).expect(403);
    const res = await request(app).get("/api/cart").set("authorization", lying).expect(200);
    expect(res.body.headers["x-user-role"]).toBe("CUSTOMER");
  });

  it("fails closed for admin routes (503) and degrades to least privilege for customers when verification is down", async () => {
    accessMode = "down";
    try {
      await request(app).get("/api/admin/orders").set("authorization", bearer("ADMIN")).expect(503);
      const res = await request(app).get("/api/cart").set("authorization", bearer("ADMIN")).expect(200);
      expect(res.body.headers["x-user-role"]).toBe("CUSTOMER");
    } finally { accessMode = "normal"; }
  });
});

describe("caching headers", () => {
  it("marks private and unknown responses no-store, and only catalogue reads publicly cacheable", async () => {
    expect((await request(app).get("/api/cart").set("authorization", bearer())).headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/notifications").set("authorization", bearer())).headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/nope")).headers["cache-control"]).toBe("no-store");
    expect((await request(app).post("/api/auth/login").send({})).headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/products")).headers["cache-control"]).toMatch(/^public, max-age=\d+/);
    expect((await request(app).post("/api/products").set("authorization", bearer("ADMIN")).send({})).headers["cache-control"]).toBe("no-store");
  });
});

describe("ops endpoints", () => {
  it("hides /metrics and readiness details from callers without the internal token", async () => {
    await request(app).get("/metrics").expect(404);
    expect((await request(app).get("/ready")).body).toEqual({ status: "ready" });
    expect((await request(app).get("/metrics").set("x-internal-auth", TOKEN).expect(200)).text).toContain("http_request_duration_seconds");
    expect((await request(app).get("/ready").set("x-internal-auth", TOKEN)).body.service).toBe("api-gateway");
  });
});

describe("rate limiting", () => {
  it("throttles repeated auth attempts per client (runs last: it exhausts the window)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await request(app).post("/api/auth/login").send({})).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
  });
});
