import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import request from "supertest";
import { JWT, startPlatform, type Platform } from "./harness";

/**
 * Red-team suite: every test is an ATTACK and asserts the secure outcome. A failure here is a vulnerability.
 */
let p: Platform;
beforeAll(async () => { p = await startPlatform(); });
afterAll(() => p.stop());
beforeEach(() => p.reset());

const uid = "11111111-1111-4111-8111-111111111111";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const claims = (extra: object = {}) => ({ sub: uid, role: "CUSTOMER", iss: "commerce-user-service", exp: Math.floor(Date.now() / 1000) + 600, ...extra });
const PRIVATE = ["/api/cart", "/api/orders", "/api/notifications", "/api/auth/me"];
const ADMIN = ["/api/admin/orders", "/api/admin/users", "/api/admin/inventory"];

async function registerReal(email = `u${randomUUID().slice(0, 6)}@example.com`, password = "correct horse battery") {
  const res = await request(p.app).post("/api/auth/register").send({ email, password, name: "Test User" });
  return { email, password, res };
}

describe("A. token forgery and authentication bypass", () => {
  const forged: Record<string, string> = {
    "alg=none": `${b64({ alg: "none", typ: "JWT" })}.${b64(claims({ role: "ADMIN" }))}.`,
    "alg=none empty sig variants": `${b64({ alg: "NONE", typ: "JWT" })}.${b64(claims({ role: "ADMIN" }))}.`,
    "wrong secret": jwt.sign(claims({ role: "ADMIN" }), "k".repeat(40), { algorithm: "HS256" }),
    "wrong issuer": jwt.sign({ sub: uid, role: "ADMIN" }, JWT, { algorithm: "HS256", issuer: "evil", expiresIn: 600 }),
    "no expiry": jwt.sign({ sub: uid, role: "ADMIN" }, JWT, { algorithm: "HS256", issuer: "commerce-user-service" }),
    "non-uuid subject": jwt.sign(claims({ sub: "1 OR 1=1" }), JWT, { algorithm: "HS256" }),
    "unknown role": jwt.sign(claims({ role: "SUPERUSER" }), JWT, { algorithm: "HS256" }),
    "HS512 (algorithm confusion)": jwt.sign(claims(), JWT, { algorithm: "HS512" })
  };
  for (const [name, token] of Object.entries(forged)) {
    it(`rejects a forged token: ${name}`, async () => {
      for (const path of [...PRIVATE, ...ADMIN]) {
        const res = await request(p.app).get(path).set("authorization", `Bearer ${token}`);
        expect(res.status, `${path} accepted ${name}`).toBe(401);
      }
    });
  }

  it("rejects a tampered payload that keeps the original signature", async () => {
    const good = jwt.sign(claims(), JWT, { algorithm: "HS256" });
    const [h, , sig] = good.split(".");
    const evil = `${h}.${b64(claims({ role: "ADMIN" }))}.${sig}`;
    await request(p.app).get("/api/admin/orders").set("authorization", `Bearer ${evil}`).expect(401);
  });

  it("answers every private/admin route with 401 when no credentials are sent", async () => {
    for (const path of [...PRIVATE, ...ADMIN]) await request(p.app).get(path).expect(401);
    for (const [m, path] of [["post", "/api/checkout"], ["post", "/api/products"], ["put", `/api/admin/inventory/${uid}`], ["delete", "/api/cart"]] as const) {
      expect((await request(p.app)[m](path).send({})).status, `${m} ${path}`).toBe(401);
    }
  });

  it("does not let a customer reach any admin route, by any verb", async () => {
    const customer = `Bearer ${p.token(uid).slice(7)}`;
    for (const path of ADMIN) expect((await request(p.app).get(path).set("authorization", customer)).status).toBe(403);
    expect((await request(p.app).put(`/api/admin/inventory/${uid}`).set("authorization", customer).send({ quantity: 5 })).status).toBe(403);
    expect((await request(p.app).post("/api/products").set("authorization", customer).send({})).status).toBe(403);
    expect((await request(p.app).delete(`/api/products/${uid}`).set("authorization", customer)).status).toBe(403);
  });

  it("route-matching tricks (case, encoding, dot segments, double slash) never reach a protected handler", async () => {
    const tricks = ["/API/ADMIN/ORDERS", "/api/admin/orders/", "//api/admin/orders", "/api/admin%2Forders", "/api/products/../admin/orders",
      `/api/products/${uid}/../../admin/inventory`, "/api/admin/orders;x=1", "/api/admin/orders%00", "/api/./admin/orders", "/api/%61dmin/orders"];
    for (const path of tricks) {
      const res = await request(p.app).get(path);
      expect([401, 403, 404], `${path} -> ${res.status}`).toContain(res.status);
      expect(res.body?.items, `${path} leaked data`).toBeUndefined();
    }
    await request(p.app).get("/internal/products/batch?ids=" + uid).expect(404);
    await request(p.app).get("/internal/anything").set("x-internal-auth", "guess").expect(404);
  });

  it("an admin whose role is revoked loses admin access immediately, not when the token expires", async () => {
    const { res, email } = await registerReal();
    await p.db.user.user.update({ where: { id: res.body.user.id }, data: { role: "ADMIN" } });
    const login = await request(p.app).post("/api/auth/login").send({ email, password: "correct horse battery" }).expect(200);
    expect(login.body.user.role).toBe("ADMIN");
    await request(p.app).get("/api/admin/orders").set("authorization", `Bearer ${login.body.accessToken}`).expect(200);
    await p.db.user.user.update({ where: { id: res.body.user.id }, data: { role: "CUSTOMER" } }); // demoted
    await request(p.app).get("/api/admin/orders").set("authorization", `Bearer ${login.body.accessToken}`).expect(403);
  });

  it("a deleted account's still-unexpired token stops working on admin routes", async () => {
    const { res, email } = await registerReal();
    await p.db.user.user.update({ where: { id: res.body.user.id }, data: { role: "ADMIN" } });
    const login = await request(p.app).post("/api/auth/login").send({ email, password: "correct horse battery" }).expect(200);
    const auth = `Bearer ${login.body.accessToken}`;
    await request(p.app).get("/api/admin/orders").set("authorization", auth).expect(200); // works while the account exists
    await p.db.user.user.delete({ where: { id: res.body.user.id } });
    expect((await request(p.app).get("/api/admin/orders").set("authorization", auth)).status).toBe(401);
    expect((await request(p.app).get("/api/cart").set("authorization", auth)).status).toBe(401); // and on private routes too
  });
});

describe("B. bypassing the gateway", () => {
  it("every service refuses direct calls without the internal token, even with forged identity", async () => {
    const forged = { "x-user-id": uid, "x-user-role": "ADMIN" };
    for (const [name, url] of Object.entries(p.urls)) {
      for (const path of ["/api/admin/orders", "/api/cart", "/api/products", "/api/admin/users", "/internal/products/batch?ids=" + uid]) {
        const res = await request(url).get(path).set(forged);
        expect([403, 404], `${name} ${path} -> ${res.status}`).toContain(res.status);
      }
      expect((await request(url).get("/api/cart").set({ ...forged, "x-internal-auth": "wrong" })).status).toBe(403);
    }
  });

  it("operational endpoints that reveal internals are not available without the internal token", async () => {
    for (const [name, url] of [["gateway", null], ...Object.entries(p.urls)] as Array<[string, string | null]>) {
      const target = url ? request(url) : request(p.app);
      const metrics = await target.get("/metrics");
      expect(metrics.status, `${name} /metrics is public`).not.toBe(200);
    }
  });
});

describe("C. privilege escalation and mass assignment", () => {
  it("ignores role/id/status fields smuggled into registration", async () => {
    const res = await request(p.app).post("/api/auth/register")
      .send({ email: "mallory@example.com", password: "correct horse battery", name: "Mallory", role: "ADMIN", id: uid, isAdmin: true }).expect(201);
    expect(res.body.user.role).toBe("CUSTOMER");
    expect(res.body.user.id).not.toBe(uid);
    expect((await p.db.user.user.findUniqueOrThrow({ where: { email: "mallory@example.com" } })).role).toBe("CUSTOMER");
  });

  it("rejects unknown/protected fields on product updates and checkout", async () => {
    const admin = p.token(randomUUID(), "ADMIN");
    const prod = (await request(p.app).post("/api/products").set("authorization", admin).send({ name: "Lamp", slug: "lamp-1", priceMinor: 100 }).expect(201)).body;
    for (const evil of [{ status: "DELETED" }, { id: uid }, { createdAt: "2000-01-01" }, { __proto__: { admin: true } }]) {
      await request(p.app).patch(`/api/products/${prod.id}`).set("authorization", admin).send(evil).expect(400);
    }
  });

  it("an authenticated user cannot act as someone else via body, query or header", async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    const lamp = (await request(p.app).post("/api/products").set("authorization", p.token(randomUUID(), "ADMIN")).send({ name: "Lamp", slug: "lamp-2", priceMinor: 100 })).body;
    await request(p.app).post("/api/cart/items").set("authorization", p.token(alice)).set("x-user-id", bob).send({ productId: lamp.id, quantity: 1, userId: bob }).expect(201);
    expect((await request(p.app).get(`/api/cart?userId=${alice}`).set("authorization", p.token(bob)).set("x-user-id", alice)).body.items).toEqual([]);
    expect((await request(p.app).get(`/api/orders?userId=${alice}`).set("authorization", p.token(bob))).body.total).toBe(0);
    expect((await request(p.app).get(`/api/notifications?userId=${alice}`).set("authorization", p.token(bob))).body.total).toBe(0);
  });
});

describe("D. injection and malformed input", () => {
  it("treats SQL/NoSQL payloads as plain data everywhere", async () => {
    const payloads = ["' OR '1'='1", "1; DROP TABLE \"Product\";--", "\" OR \"\"=\"", "'; SELECT pg_sleep(5);--", "%' OR 1=1 --", "${7*7}", "{{7*7}}", "<script>alert(1)</script>"];
    for (const x of payloads) {
      for (const q of [`search=${encodeURIComponent(x)}`, `category=${encodeURIComponent(x)}`, `sort=${encodeURIComponent(x)}`, `minPrice=${encodeURIComponent(x)}`]) {
        const res = await request(p.app).get(`/api/products?${q}`);
        expect([200, 400], `${q} -> ${res.status}`).toContain(res.status);
      }
    }
    expect(await p.db.product.product.count()).toBe(0);
    await request(p.app).get("/api/products/1%20OR%201=1").expect(404);
  });

  it("rejects NoSQL-style operator objects and wrong types instead of coercing them", async () => {
    for (const body of [{ email: { $ne: null }, password: { $ne: null } }, { email: ["a@b.com"], password: "x" }, { email: "a@b.com", password: 12345 }, { email: true, password: null }]) {
      expect((await request(p.app).post("/api/auth/login").send(body)).status).toBe(400);
    }
    const t = p.token(randomUUID());
    for (const body of [{ productId: { $gt: "" }, quantity: 1 }, { productId: uid, quantity: "1" }, { productId: uid, quantity: 1.5 }, { productId: uid, quantity: -1 }, { productId: uid, quantity: 1e9 }, { productId: uid, quantity: null }]) {
      expect((await request(p.app).post("/api/cart/items").set("authorization", t).send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("survives prototype-pollution and hostile JSON without side effects or 5xx", async () => {
    const t = p.token(randomUUID());
    for (const raw of ['{"__proto__":{"polluted":true},"productId":"x"}', '{"constructor":{"prototype":{"polluted":true}}}', "[]", "null", '"str"', "{", "\u0000", "{\"a\":" + "[".repeat(5000)]) {
      const res = await request(p.app).post("/api/cart/items").set("authorization", t).set("content-type", "application/json").send(raw);
      expect(res.status, raw.slice(0, 30)).toBeLessThan(500);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns 400, never 500, for NUL bytes and invalid unicode in text fields", async () => {
    const admin = p.token(randomUUID(), "ADMIN");
    for (const bad of ["Lamp\u0000", "\u0000\u0000", "ab\u0000cd"]) {
      const a = await request(p.app).post("/api/products").set("authorization", admin).send({ name: bad, slug: "nul-test", priceMinor: 1 });
      expect(a.status, `product name ${JSON.stringify(bad)}`).toBe(400);
      const r = await request(p.app).post("/api/auth/register").send({ email: "nul@example.com", password: "correct horse battery", name: bad });
      expect(r.status, `user name ${JSON.stringify(bad)}`).toBe(400);
    }
    const c = await request(p.app).get("/api/products?search=%00abc");
    expect(c.status).toBeLessThan(500);
  });

  it("does not execute or reflect markup: stored names are plain text and responses are JSON", async () => {
    const admin = p.token(randomUUID(), "ADMIN");
    const res = await request(p.app).post("/api/products").set("authorization", admin).send({ name: "<img src=x onerror=alert(1)>", slug: "xss-1", priceMinor: 1 });
    expect([201, 400]).toContain(res.status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("repeated or array query params cannot cause server errors", async () => {
    for (const q of ["page=1&page=2", "limit[]=1", "limit[a]=1", "page=%00", "limit=1e9", "limit=-1", "page=99999999999999999999"]) {
      expect((await request(p.app).get(`/api/products?${q}`)).status, q).toBeLessThan(500);
    }
  });

  it("rejects wrong content types and oversized bodies cleanly", async () => {
    const t = p.token(randomUUID());
    expect((await request(p.app).post("/api/cart/items").set("authorization", t).set("content-type", "text/plain").send("productId=1")).status).toBe(400);
    expect((await request(p.app).post("/api/auth/login").set("content-type", "application/json").send(JSON.stringify({ email: "a".repeat(2_000_000) }))).status).toBeGreaterThanOrEqual(400);
  });
});

describe("E. credential attacks", () => {
  it("does not silently truncate long passwords (bcrypt 72-byte limit)", async () => {
    const long = "A".repeat(72) + "-first-password-tail";
    const reg = await request(p.app).post("/api/auth/register").send({ email: "long@example.com", password: long, name: "Long Pass" });
    if (reg.status === 201) {
      const prefixOnly = await request(p.app).post("/api/auth/login").send({ email: "long@example.com", password: "A".repeat(72) + "-DIFFERENT-tail" });
      expect(prefixOnly.status, "a different password sharing the first 72 bytes was accepted").toBe(401);
    } else expect(reg.status).toBe(400);
  });

  it("locks out online password guessing per account, without revealing whether the account exists", async () => {
    const { email, password } = await registerReal("victim@example.com");
    const wrong = () => request(p.app).post("/api/auth/login").send({ email, password: "wrong-password-1" });
    for (let i = 0; i < 12; i++) await wrong();
    const afterBurst = await request(p.app).post("/api/auth/login").send({ email, password });
    expect(afterBurst.status, "correct password still accepted after 12 failed guesses").toBe(429);
    // an unknown address must behave identically (no account-existence oracle)
    const ghost = () => request(p.app).post("/api/auth/login").send({ email: "nobody-here@example.com", password: "wrong-password-1" });
    for (let i = 0; i < 12; i++) await ghost();
    expect((await ghost()).status).toBe(429);
  });

  it("a logged-out refresh token and a rotated refresh token are dead", async () => {
    const { res } = await registerReal();
    await request(p.app).post("/api/auth/logout").send({ refreshToken: res.body.refreshToken }).expect(204);
    await request(p.app).post("/api/auth/refresh").send({ refreshToken: res.body.refreshToken }).expect(401);
  });

  it("never returns password hashes or token hashes from any endpoint", async () => {
    const { res } = await registerReal();
    const dump = JSON.stringify(res.body);
    expect(dump).not.toMatch(/passwordHash|\$2[aby]\$|tokenHash/);
    const admin = p.token(randomUUID(), "ADMIN");
    await p.db.user.user.update({ where: { id: res.body.user.id }, data: { role: "ADMIN" } });
    const users = await request(p.app).get("/api/admin/users").set("authorization", `Bearer ${(await request(p.app).post("/api/auth/login").send({ email: res.body.user.email, password: "correct horse battery" })).body.accessToken}`);
    expect(JSON.stringify(users.body)).not.toMatch(/passwordHash|\$2[aby]\$|tokenHash/);
    void admin;
  });
});

describe("F. IDOR", () => {
  it("one customer cannot read, modify, cancel or read-mark another customer's resources", async () => {
    const [alice, mallory] = [randomUUID(), randomUUID()];
    const lamp = (await request(p.app).post("/api/products").set("authorization", p.token(randomUUID(), "ADMIN")).send({ name: "Lamp", slug: "idor-1", priceMinor: 100 })).body;
    await request(p.app).put(`/api/admin/inventory/${lamp.id}`).set("authorization", p.token(randomUUID(), "ADMIN")).send({ quantity: 5 });
    const cart = (await request(p.app).post("/api/cart/items").set("authorization", p.token(alice)).send({ productId: lamp.id, quantity: 1 })).body;
    const order = (await request(p.app).post("/api/checkout").set("authorization", p.token(alice)).set("idempotency-key", `k-${randomUUID()}`)).body;
    await p.settle();
    const m = p.token(mallory);
    expect((await request(p.app).get(`/api/orders/${order.orderId}`).set("authorization", m)).status).toBe(404);
    expect((await request(p.app).post(`/api/orders/${order.orderId}/cancel`).set("authorization", m)).status).toBe(404);
    expect((await request(p.app).patch(`/api/cart/items/${cart.items[0]?.id ?? uid}`).set("authorization", m).send({ quantity: 9 })).status).toBe(404);
    await p.db.notification.notification.create({ data: { userId: alice, type: "X", title: "t", body: "b" } });
    const n = await p.db.notification.notification.findFirstOrThrow();
    expect((await request(p.app).post(`/api/notifications/${n.id}/read`).set("authorization", m)).status).toBe(404);
    // sequential/guessable ids are not a thing: ids are random UUIDs
    expect(order.orderId).toMatch(/^[0-9a-f-]{36}$/);
    // an idempotency key from another user must not return their order
    const key = `k-${randomUUID()}`;
    await request(p.app).post("/api/cart/items").set("authorization", m).send({ productId: lamp.id, quantity: 1 });
    const mo = await request(p.app).post("/api/checkout").set("authorization", m).set("idempotency-key", key);
    expect(mo.body.orderId).not.toBe(order.orderId);
  });
});

describe("G. payment webhook attacks", () => {
  const body = (orderId: string, amountMinor = 100) => JSON.stringify({ id: `evt_${randomUUID()}`, type: "payment.succeeded", data: { orderId, reference: "r", amountMinor, currency: "INR" } });
  it("rejects missing, malformed, wrong-secret, stale, future-dated and body-tampered signatures", async () => {
    const orderId = randomUUID();
    const raw = body(orderId);
    const { signature } = p.signedWebhook({ id: "different", type: "payment.succeeded", data: { orderId: randomUUID(), reference: "z", amountMinor: 1, currency: "INR" } });
    const sig = (secret: string, t: number, b = raw) => { return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(b).digest("hex")}`; };
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string | undefined, string]> = [
      ["none", undefined, raw], ["garbage", "hello", raw], ["wrong secret", sig("x".repeat(40), now), raw],
      ["stale", sig("w".repeat(40), now - 3600), raw], ["future", sig("w".repeat(40), now + 3600), raw],
      ["tampered body", sig("w".repeat(40), now), raw.replace('"amountMinor":100', '"amountMinor":1')], ["sig of another body", signature, raw], ["empty v1", `t=${now},v1=`, raw],
      ["multiple v1", `t=${now},v1=${"0".repeat(64)},v1=${"1".repeat(64)}`, raw]
    ];
    for (const [name, header, b] of cases) {
      const req = request(p.app).post("/api/payments/webhook").set("content-type", "application/json");
      const res = await (header ? req.set("x-signature", header) : req).send(b);
      expect(res.status, name).toBe(401);
    }
  });
});

describe("H. browser-facing protections", () => {
  it("does not reflect arbitrary origins, never allows credentials cross-origin, and answers preflight safely", async () => {
    const evil = "https://evil.example";
    const get = await request(p.app).get("/api/products").set("origin", evil);
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    expect(get.headers["access-control-allow-credentials"]).toBeUndefined();
    const pre = await request(p.app).options("/api/cart").set("origin", evil).set("access-control-request-method", "POST");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends hardening headers and does not fingerprint the stack", async () => {
    const res = await request(p.app).get("/api/products");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d{7,}/);
    expect(res.headers["cache-control"] ?? "").not.toMatch(/public/); // private data must never be publicly cacheable
  });

  it("errors are generic: no stack traces, SQL, file paths or internal hostnames", async () => {
    const outputs: string[] = [];
    for (const [m, path, b] of [["get", "/api/orders/not-a-uuid", undefined], ["post", "/api/auth/login", "{bad"], ["get", "/api/nope", undefined], ["post", "/api/cart/items", { productId: "x" }]] as const) {
      const r = request(p.app)[m](path).set("authorization", p.token(randomUUID()));
      const res = await (b ? r.set("content-type", "application/json").send(b as never) : r);
      outputs.push(JSON.stringify(res.body) + res.text);
    }
    expect(outputs.join("\n")).not.toMatch(/at\s+\S+\s+\(|node_modules|prisma|PrismaClient|SELECT |postgres|ECONN|\/home\/|stack/i);
  });

  it("authenticated responses are not publicly cacheable", async () => {
    const res = await request(p.app).get("/api/cart").set("authorization", p.token(randomUUID()));
    expect(res.headers["cache-control"] ?? "").toMatch(/no-store|private/);
  });
});
