import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, catalog, db, outbox, resetDb, userHeaders } from "./helpers";

const alice = randomUUID();
const bob = randomUUID();
const as = (id: string) => userHeaders(id);
const key = () => `key-${randomUUID()}`;

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(resetDb);

const addToCart = (user: string, productId: string, quantity = 1) =>
  request(app).post("/api/cart/items").set(as(user)).send({ productId, quantity });

describe("cart", () => {
  it("requires authentication and a gateway", async () => {
    await request(app).get("/api/cart").set("x-internal-auth", "t".repeat(40)).expect(401);
    await request(app).get("/api/cart").expect(403);
  });

  it("adds, merges, updates and removes items with server-side prices", async () => {
    const lamp = catalog.add("Lamp", 1999);
    await addToCart(alice, lamp.id, 2).expect(201);
    const res = await addToCart(alice, lamp.id, 3).expect(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ quantity: 5, lineTotalMinor: 9995, product: { name: "Lamp", unitPriceMinor: 1999 } });
    expect(res.body.subtotalMinor).toBe(9995);
    const itemId = res.body.items[0].id;
    await request(app).patch(`/api/cart/items/${itemId}`).set(as(alice)).send({ quantity: 1 }).expect(200);
    await request(app).patch(`/api/cart/items/${itemId}`).set(as(alice)).send({ quantity: 0 }).expect(400);
    await request(app).delete(`/api/cart/items/${itemId}`).set(as(alice)).expect(204);
    expect((await request(app).get("/api/cart").set(as(alice))).body.items).toEqual([]);
  });

  it("caps quantities and rejects unknown products", async () => {
    const lamp = catalog.add("Lamp", 100);
    await addToCart(alice, lamp.id, 21).expect(400);
    await addToCart(alice, lamp.id, 20).expect(201);
    const capped = await addToCart(alice, lamp.id, 20).expect(201);
    expect(capped.body.items[0].quantity).toBe(20);
    await addToCart(alice, randomUUID()).expect(404);
  });

  it("survives concurrent first-time adds", async () => {
    const lamp = catalog.add("Lamp", 100);
    const results = await Promise.all(Array.from({ length: 8 }, () => addToCart(alice, lamp.id, 1)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await request(app).get("/api/cart").set(as(alice))).body.items[0].quantity).toBe(8);
  });

  it("users cannot touch each other's cart items", async () => {
    const lamp = catalog.add("Lamp", 100);
    const itemId = (await addToCart(alice, lamp.id)).body.items[0].id;
    await request(app).patch(`/api/cart/items/${itemId}`).set(as(bob)).send({ quantity: 9 }).expect(404);
    await request(app).delete(`/api/cart/items/${itemId}`).set(as(bob)).expect(204);
    expect((await request(app).get("/api/cart").set(as(alice))).body.items).toHaveLength(1);
  });

  it("still shows the cart, without prices, when the catalogue is down", async () => {
    const lamp = catalog.add("Lamp", 100);
    await addToCart(alice, lamp.id).expect(201);
    catalog.down = true;
    const res = await request(app).get("/api/cart").set(as(alice)).expect(200);
    expect(res.body.items[0].product).toBeNull();
    expect(res.body.subtotalMinor).toBeNull();
    await addToCart(alice, lamp.id).expect(503);
  });
});

describe("checkout", () => {
  it("prices the order from the catalogue, snapshots it, empties the cart and emits OrderCreated", async () => {
    const lamp = catalog.add("Lamp", 1999);
    const book = catalog.add("Book", 500);
    await addToCart(alice, lamp.id, 2);
    await addToCart(alice, book.id, 1);
    const res = await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key()).expect(202);
    expect(res.body).toMatchObject({ status: "PENDING", totalMinor: 4498, currency: "INR" });
    const order = await db.order.findUniqueOrThrow({ where: { id: res.body.orderId }, include: { items: true } });
    expect(order.items.map((i) => [i.productName, i.unitPriceMinor, i.quantity]).sort()).toEqual([["Book", 500, 1], ["Lamp", 1999, 2]]);
    catalog.products.get(lamp.id)!.priceMinor = 99999; // later catalogue change must not alter history
    const fetched = await request(app).get(`/api/orders/${order.id}`).set(as(alice)).expect(200);
    expect(fetched.body.items.find((i: { productName: string }) => i.productName === "Lamp").unitPriceMinor).toBe(1999);
    expect(await db.cartItem.count()).toBe(0);
    const [evt] = await db.outboxEvent.findMany();
    expect(evt).toMatchObject({ eventType: "OrderCreated", aggregateId: order.id });
    expect(evt?.payload).toMatchObject({ orderId: order.id, userId: alice, totalMinor: 4498 });
  });

  it("ignores any price or user the client tries to supply", async () => {
    const lamp = catalog.add("Lamp", 1999);
    await addToCart(alice, lamp.id);
    const res = await request(app)
      .post("/api/checkout").set(as(alice)).set("idempotency-key", key())
      .send({ userId: bob, items: [{ productId: lamp.id, unitPrice: 1, quantity: 1 }], totalMinor: 1 })
      .expect(202);
    expect(res.body.totalMinor).toBe(1999);
    expect((await db.order.findUniqueOrThrow({ where: { id: res.body.orderId } })).userId).toBe(alice);
  });

  it("requires a valid Idempotency-Key and a non-empty cart", async () => {
    await request(app).post("/api/checkout").set(as(alice)).expect(400);
    await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", "short").expect(400);
    await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key()).expect(409);
  });

  it("returns the same order for a retried key, and creates exactly one order under concurrency", async () => {
    const lamp = catalog.add("Lamp", 100);
    await addToCart(alice, lamp.id);
    const k = key();
    const results = await Promise.all(Array.from({ length: 6 }, () => request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", k)));
    expect(results.every((r) => [200, 202].includes(r.status))).toBe(true);
    expect(new Set(results.map((r) => r.body.orderId)).size).toBe(1);
    expect(await db.order.count()).toBe(1);
    expect(await outbox()).toEqual(["OrderCreated"]);
    const again = await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", k).expect(200);
    expect(again.headers["idempotent-replay"]).toBe("true");
  });

  it("two different keys cannot both consume one cart", async () => {
    const lamp = catalog.add("Lamp", 100);
    await addToCart(alice, lamp.id);
    const results = await Promise.all([key(), key()].map((k) => request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", k)));
    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await db.order.count()).toBe(1);
  });

  it("rejects products that disappeared, mixed currencies and absurd totals", async () => {
    const gone = catalog.add("Gone", 100);
    await addToCart(alice, gone.id);
    catalog.products.delete(gone.id);
    expect((await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key()).expect(409)).body.error.code).toBe("PRODUCT_UNAVAILABLE");
    await request(app).delete("/api/cart").set(as(alice)).expect(204);

    const inr = catalog.add("A", 100);
    const usd = catalog.add("B", 100, "USD");
    await addToCart(alice, inr.id);
    await addToCart(alice, usd.id);
    expect((await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key()).expect(409)).body.error.code).toBe("MIXED_CURRENCY");
    await request(app).delete("/api/cart").set(as(alice)).expect(204);

    const gold = catalog.add("Gold", 500_000_000);
    await addToCart(alice, gold.id, 5);
    expect((await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key()).expect(422)).body.error.code).toBe("ORDER_TOO_LARGE");
    expect(await db.order.count()).toBe(0);
  });

  it("fails closed with 503 when the catalogue is down", async () => {
    const lamp = catalog.add("Lamp", 100);
    await addToCart(alice, lamp.id);
    catalog.down = true;
    await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key()).expect(503);
    expect(await db.order.count()).toBe(0);
    expect(await db.cartItem.count()).toBe(1);
  });
});

describe("order access", () => {
  it("hides other users' orders (IDOR) but lets admins in", async () => {
    const lamp = catalog.add("Lamp", 100);
    await addToCart(alice, lamp.id);
    const { orderId } = (await request(app).post("/api/checkout").set(as(alice)).set("idempotency-key", key())).body;
    await request(app).get(`/api/orders/${orderId}`).set(as(bob)).expect(404);
    await request(app).post(`/api/orders/${orderId}/cancel`).set(as(bob)).expect(404);
    await request(app).get(`/api/orders/${orderId}`).set(userHeaders(bob, "ADMIN")).expect(200);
    expect((await request(app).get("/api/orders").set(as(bob))).body.total).toBe(0);
    expect((await request(app).get("/api/orders").set(as(alice))).body.total).toBe(1);
    await request(app).get("/api/admin/orders").set(as(alice)).expect(403);
    expect((await request(app).get("/api/admin/orders").set(userHeaders(bob, "ADMIN")).expect(200)).body.total).toBe(1);
    await request(app).get("/api/orders/not-a-uuid").set(as(alice)).expect(400);
  });
});
