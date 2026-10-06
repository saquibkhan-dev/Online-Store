import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { loadInventoryConfig } from "../src/config";
import { db, inventory, logger, orderCreated, consume, resetDb, TOKEN } from "./helpers";

const config = loadInventoryConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/inventory_test",
  INTERNAL_SERVICE_TOKEN: TOKEN,
  KAFKA_BROKERS: "localhost:9092"
});
const app = createApp({ db, config, logger, inventory });
const admin = { "x-internal-auth": TOKEN, "x-user-id": randomUUID(), "x-user-role": "ADMIN" };

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(resetDb);

describe("admin inventory API", () => {
  it("requires the admin role", async () => {
    const p = randomUUID();
    await request(app).put(`/api/admin/inventory/${p}`).set("x-internal-auth", TOKEN).send({ quantity: 5 }).expect(401);
    await request(app).put(`/api/admin/inventory/${p}`).set({ ...admin, "x-user-role": "CUSTOMER" }).send({ quantity: 5 }).expect(403);
  });

  it("sets stock, lists it, and refuses to drop below reserved units", async () => {
    const p = randomUUID();
    const res = await request(app).put(`/api/admin/inventory/${p}`).set(admin).send({ quantity: 10 }).expect(200);
    expect(res.body).toMatchObject({ quantity: 10, reservedQuantity: 0, available: 10 });
    await consume(orderCreated(randomUUID(), [{ productId: p, quantity: 6 }]));
    await request(app).put(`/api/admin/inventory/${p}`).set(admin).send({ quantity: 5 }).expect(409);
    await request(app).put(`/api/admin/inventory/${p}`).set(admin).send({ quantity: 6 }).expect(200);
    await request(app).put(`/api/admin/inventory/${p}`).set(admin).send({ quantity: -1 }).expect(400);
    const list = await request(app).get("/api/admin/inventory").set(admin).expect(200);
    expect(list.body.items).toEqual([{ productId: p, quantity: 6, reservedQuantity: 6, available: 0 }]);
  });
});
