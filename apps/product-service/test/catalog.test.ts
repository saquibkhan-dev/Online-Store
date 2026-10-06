import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@commerce/shared";
import { createApp } from "../src/app";
import { loadProductConfig } from "../src/config";
import { createDb } from "../src/db";

process.env.CATALOG_CACHE_SECONDS = "0"; // these tests mutate the DB directly, so bypass the response cache
const TOKEN = "t".repeat(40);
const config = loadProductConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/product_test",
  INTERNAL_SERVICE_TOKEN: TOKEN
});
const db = createDb(config.DATABASE_URL, 5);
const app = createApp({ db, config, logger: createLogger("test", "silent") });
const gw = { "x-internal-auth": TOKEN };
const asAdmin = { ...gw, "x-user-id": "11111111-1111-4111-8111-111111111111", "x-user-role": "ADMIN" };
const asCustomer = { ...asAdmin, "x-user-role": "CUSTOMER" };

const make = (name: string, priceMinor: number, extra: Record<string, unknown> = {}) =>
  request(app).post("/api/products").set(asAdmin).send({ name, slug: name.toLowerCase().replace(/\s+/g, "-"), priceMinor, ...extra });

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await db.product.deleteMany();
  await db.category.deleteMany();
});

describe("catalog", () => {
  it("only admins can mutate; anyone can read", async () => {
    await request(app).post("/api/products").set(gw).send({}).expect(401);
    await request(app).post("/api/products").set(asCustomer).send({}).expect(403);
    await make("Desk Lamp", 129900).expect(201);
    await request(app).get("/api/products").set(gw).expect(200);
    await request(app).delete("/api/products/11111111-1111-4111-8111-111111111111").set(asCustomer).expect(403);
  });

  it("validates input and enforces unique slugs", async () => {
    await make("Bad", -5).expect(400);
    await request(app).post("/api/products").set(asAdmin).send({ name: "X", slug: "Not Valid", priceMinor: 1 }).expect(400);
    await make("Desk Lamp", 100).expect(201);
    await make("Desk Lamp", 100).expect(409);
  });

  it("searches, filters, sorts and paginates with a server-side page cap", async () => {
    const cat = (await request(app).post("/api/categories").set(asAdmin).send({ name: "Lighting", slug: "lighting" }).expect(201)).body;
    await make("Desk Lamp", 300, { categoryId: cat.id });
    await make("Floor Lamp", 900, { categoryId: cat.id });
    await make("Notebook", 100);
    const list = (q: string) => request(app).get(`/api/products?${q}`).set(gw).expect(200);
    expect((await list("search=lamp&sort=price_desc")).body.items.map((p: { name: string }) => p.name)).toEqual(["Floor Lamp", "Desk Lamp"]);
    expect((await list("category=lighting")).body.total).toBe(2);
    expect((await list("minPrice=200&maxPrice=500")).body.items).toHaveLength(1);
    const page = (await list("sort=name&limit=2&page=2")).body;
    expect(page.items.map((p: { name: string }) => p.name)).toEqual(["Notebook"]);
    expect(page.total).toBe(3);
    await request(app).get("/api/products?limit=500").set(gw).expect(400);
    await request(app).get("/api/products?page=abc").set(gw).expect(400);
  });

  it("treats search input as data, not as a query", async () => {
    await make("Desk Lamp", 300);
    const res = await request(app).get("/api/products").query({ search: "'; DROP TABLE \"Product\"; --" }).set(gw).expect(200);
    expect(res.body.total).toBe(0);
    expect(await db.product.count()).toBe(1);
  });

  it("soft-deletes products and hides them everywhere", async () => {
    const p = (await make("Desk Lamp", 300).expect(201)).body;
    await request(app).delete(`/api/products/${p.id}`).set(asAdmin).expect(204);
    await request(app).delete(`/api/products/${p.id}`).set(asAdmin).expect(204);
    await request(app).get(`/api/products/${p.id}`).set(gw).expect(404);
    await request(app).patch(`/api/products/${p.id}`).set(asAdmin).send({ name: "Renamed" }).expect(404);
    expect((await request(app).get("/api/products").set(gw)).body.total).toBe(0);
    expect((await request(app).get(`/internal/products/batch?ids=${p.id}`).set(gw)).body.items).toEqual([]);
    expect(await db.product.count()).toBe(1);
  });

  it("updates products and rejects empty or unknown fields", async () => {
    const p = (await make("Desk Lamp", 300).expect(201)).body;
    const upd = await request(app).patch(`/api/products/${p.id}`).set(asAdmin).send({ priceMinor: 350 }).expect(200);
    expect(upd.body.priceMinor).toBe(350);
    await request(app).patch(`/api/products/${p.id}`).set(asAdmin).send({}).expect(400);
    await request(app).patch(`/api/products/${p.id}`).set(asAdmin).send({ status: "DELETED" }).expect(400);
  });

  it("serves authoritative prices to other services", async () => {
    const a = (await make("Desk Lamp", 300).expect(201)).body;
    const b = (await make("Notebook", 100).expect(201)).body;
    const res = await request(app).get(`/internal/products/batch?ids=${a.id},${b.id}`).set(gw).expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.find((i: { id: string }) => i.id === a.id)).toMatchObject({ name: "Desk Lamp", priceMinor: 300, currency: "INR" });
    await request(app).get("/internal/products/batch?ids=not-a-uuid").set(gw).expect(400);
  });
});
