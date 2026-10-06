import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@commerce/shared";
import { createApp } from "../src/app";
import { loadProductConfig } from "../src/config";
import { createDb } from "../src/db";

process.env.CATALOG_CACHE_SECONDS = "30";
const TOKEN = "t".repeat(40);
const config = loadProductConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/product_test", INTERNAL_SERVICE_TOKEN: TOKEN });
const db = createDb(config.DATABASE_URL, 5);
const app = createApp({ db, config, logger: createLogger("test", "silent") });
const gw = { "x-internal-auth": TOKEN };
const admin = { ...gw, "x-user-id": "11111111-1111-4111-8111-111111111111", "x-user-role": "ADMIN" };

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(async () => { await db.product.deleteMany(); await db.category.deleteMany(); });

describe("catalogue response cache", () => {
  it("serves repeat reads from cache, and every write is visible immediately", async () => {
    await request(app).post("/api/products").set(admin).send({ name: "Lamp", slug: "lamp", priceMinor: 100 }).expect(201);
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(1);
    await db.product.create({ data: { name: "Sneaky", slug: "sneaky", priceMinor: 1 } }); // bypasses the service: cache must still hold
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(1);
    await request(app).post("/api/products").set(admin).send({ name: "Desk", slug: "desk", priceMinor: 200 }).expect(201); // write -> invalidates
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(3);
  });

  it("keeps different queries separate", async () => {
    await request(app).post("/api/products").set(admin).send({ name: "Lamp", slug: "lamp", priceMinor: 100 });
    await request(app).post("/api/products").set(admin).send({ name: "Desk", slug: "desk", priceMinor: 200 });
    expect((await request(app).get("/api/products?search=lamp").set(gw)).body.total).toBe(1);
    expect((await request(app).get("/api/products?search=desk").set(gw)).body.total).toBe(1);
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(2);
  });

  it("never lets a deleted product be served from cache", async () => {
    const p = (await request(app).post("/api/products").set(admin).send({ name: "Lamp", slug: "lamp", priceMinor: 100 })).body;
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(1);
    await request(app).delete(`/api/products/${p.id}`).set(admin).expect(204);
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(0);
  });
});
