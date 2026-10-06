import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { startPlatform, type Platform } from "./harness";

let p: Platform;
beforeAll(async () => { p = await startPlatform(); });
afterAll(() => p.stop());
beforeEach(() => p.reset());

const admin = () => p.token(randomUUID(), "ADMIN");

async function seedProduct(price: number, stock: number, name = "Desk Lamp") {
  const created = await request(p.app).post("/api/products").set("authorization", admin())
    .send({ name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 6)}`, priceMinor: price }).expect(201);
  await request(p.app).put(`/api/admin/inventory/${created.body.id}`).set("authorization", admin()).send({ quantity: stock }).expect(200);
  return created.body.id as string;
}

async function checkout(userId: string, productId: string, quantity = 1) {
  const auth = p.token(userId);
  await request(p.app).post("/api/cart/items").set("authorization", auth).send({ productId, quantity }).expect(201);
  const res = await request(p.app).post("/api/checkout").set("authorization", auth).set("idempotency-key", `k-${randomUUID()}`).expect(202);
  return res.body.orderId as string;
}

const order = async (userId: string, orderId: string) => (await request(p.app).get(`/api/orders/${orderId}`).set("authorization", p.token(userId)).expect(200)).body;
const stock = async (productId: string) => {
  const rows = (await request(p.app).get("/api/admin/inventory").set("authorization", admin()).expect(200)).body.items;
  return rows.find((r: { productId: string }) => r.productId === productId);
};
const notes = async (userId: string) => (await request(p.app).get("/api/notifications").set("authorization", p.token(userId)).expect(200)).body.items as Array<{ type: string; body: string }>;

function pay(orderId: string, kind: "succeeded" | "failed", amountMinor: number, eventId = `evt_${randomUUID()}`) {
  const { raw, signature } = p.signedWebhook({
    id: eventId, type: `payment.${kind}`,
    data: { orderId, reference: `pay_${randomUUID().slice(0, 8)}`, amountMinor, currency: "INR", ...(kind === "failed" ? { reason: "card_declined" } : {}) }
  });
  return request(p.app).post("/api/payments/webhook").set("content-type", "application/json").set("x-signature", signature).send(raw);
}

describe("end-to-end order saga (gateway -> services -> outbox -> consumers)", () => {
  it("happy path: checkout, reserve, pay, confirm, decrement stock, notify", async () => {
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp, 2);
    expect((await order(alice, orderId)).status).toBe("PENDING");

    await p.settle();
    const awaiting = await order(alice, orderId);
    expect(awaiting).toMatchObject({ status: "PAYMENT_PENDING", totalMinor: 5000 });
    expect(await stock(lamp)).toMatchObject({ quantity: 5, reservedQuantity: 2, available: 3 });

    await pay(orderId, "succeeded", 5000).expect(200);
    await p.settle();
    expect((await order(alice, orderId)).status).toBe("CONFIRMED");
    expect(await stock(lamp)).toMatchObject({ quantity: 3, reservedQuantity: 0, available: 3 });
    expect((await notes(alice)).map((n) => n.type)).toEqual(["ORDER_CONFIRMED"]);

    const types = p.bus.delivered.map((e) => e.eventType);
    expect(types).toEqual(["OrderCreated", "InventoryReserved", "PaymentRequested", "PaymentCompleted", "OrderConfirmed"]);
    expect(new Set(p.bus.delivered.map((e) => e.correlationId)).size).toBe(1); // one trace id across all services
  });

  it("out of stock: order is cancelled, nothing is reserved, customer is told why", async () => {
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 1);
    const orderId = await checkout(alice, lamp, 3);
    await p.settle();
    expect(await order(alice, orderId)).toMatchObject({ status: "CANCELLED", cancelReason: "INSUFFICIENT_STOCK" });
    expect(await stock(lamp)).toMatchObject({ quantity: 1, reservedQuantity: 0 });
    expect((await notes(alice))[0]?.body).toContain("out of stock");
  });

  it("payment declined: order cancelled and the reservation is released", async () => {
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp, 2);
    await p.settle();
    await pay(orderId, "failed", 5000).expect(200);
    await p.settle();
    expect(await order(alice, orderId)).toMatchObject({ status: "CANCELLED", cancelReason: "PAYMENT_FAILED" });
    expect(await stock(lamp)).toMatchObject({ quantity: 5, reservedQuantity: 0 });
    expect((await notes(alice))[0]?.type).toBe("ORDER_CANCELLED");
  });

  it("customer cancels while awaiting payment; a late successful payment is flagged for refund, never confirmed", async () => {
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp);
    await p.settle();
    await request(p.app).post(`/api/orders/${orderId}/cancel`).set("authorization", p.token(alice)).expect(200);
    await p.settle();
    expect(await stock(lamp)).toMatchObject({ quantity: 5, reservedQuantity: 0 });

    await pay(orderId, "succeeded", 2500).expect(200);
    await p.settle();
    expect((await order(alice, orderId)).status).toBe("CANCELLED");
    expect(await stock(lamp)).toMatchObject({ quantity: 5, reservedQuantity: 0 });
    expect((await p.db.order.auditLog.findFirstOrThrow()).action).toBe("PAYMENT_RECEIVED_FOR_UNPAYABLE_ORDER");
  });

  it("duplicate webhooks and a bus that delivers every event three times still yield exactly one outcome", async () => {
    p.bus.duplicate = true;
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp, 1);
    await p.settle();
    const evt = `evt_${randomUUID()}`;
    const results = await Promise.all([1, 2, 3, 4].map(() => pay(orderId, "succeeded", 2500, evt)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    await p.settle();
    expect((await order(alice, orderId)).status).toBe("CONFIRMED");
    expect(await stock(lamp)).toMatchObject({ quantity: 4, reservedQuantity: 0 });
    expect(await notes(alice)).toHaveLength(1);
    expect(await p.db.payment.payment.count()).toBe(1);
  });

  it("webhooks without a valid signature are rejected end to end", async () => {
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp);
    await p.settle();
    const body = JSON.stringify({ id: "evt_x", type: "payment.succeeded", data: { orderId, reference: "r", amountMinor: 2500, currency: "INR" } });
    await request(p.app).post("/api/payments/webhook").set("content-type", "application/json").send(body).expect(401);
    await request(p.app).post("/api/payments/webhook").set("content-type", "application/json").set("x-signature", "t=1,v1=" + "0".repeat(64)).send(body).expect(401);
    expect((await order(alice, orderId)).status).toBe("PAYMENT_PENDING");
  });

  it("an underpayment is never confirmed", async () => {
    const alice = randomUUID();
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp);
    await p.settle();
    await pay(orderId, "succeeded", 1).expect(200);
    await p.settle();
    expect((await order(alice, orderId)).status).toBe("PAYMENT_PENDING");
    expect(await p.db.payment.payment.findFirstOrThrow()).toMatchObject({ status: "REQUIRES_REVIEW" });
  });

  it("flash sale: 12 shoppers race for 5 units - exactly 5 orders can be paid, stock never goes negative", async () => {
    const lamp = await seedProduct(1000, 5, "Limited Lamp");
    const shoppers = Array.from({ length: 12 }, () => randomUUID());
    const orderIds = await Promise.all(shoppers.map((u) => checkout(u, lamp, 1)));
    await p.settle();
    const states = await Promise.all(orderIds.map((id, i) => order(shoppers[i]!, id)));
    const waiting = states.filter((o) => o.status === "PAYMENT_PENDING");
    expect(waiting).toHaveLength(5);
    expect(states.filter((o) => o.status === "CANCELLED")).toHaveLength(7);
    for (const o of waiting) await pay(o.id, "succeeded", 1000).expect(200);
    await p.settle();
    const final = await Promise.all(orderIds.map((id, i) => order(shoppers[i]!, id)));
    expect(final.filter((o) => o.status === "CONFIRMED")).toHaveLength(5);
    expect(await stock(lamp)).toMatchObject({ quantity: 0, reservedQuantity: 0, available: 0 });
  });

  it("customers cannot see or cancel each other's orders through the gateway", async () => {
    const [alice, mallory] = [randomUUID(), randomUUID()];
    const lamp = await seedProduct(2500, 5);
    const orderId = await checkout(alice, lamp);
    await request(p.app).get(`/api/orders/${orderId}`).set("authorization", p.token(mallory)).expect(404);
    await request(p.app).post(`/api/orders/${orderId}/cancel`).set("authorization", p.token(mallory)).expect(404);
    await request(p.app).get("/api/admin/orders").set("authorization", p.token(mallory)).expect(403);
    await request(p.app).get("/internal/products/batch?ids=" + lamp).expect(404);
  });

  it("real registration and login flow works through the gateway", async () => {
    const reg = await request(p.app).post("/api/auth/register").send({ email: "ada@example.com", password: "correct horse battery", name: "Ada" }).expect(201);
    const me = await request(p.app).get("/api/auth/me").set("authorization", `Bearer ${reg.body.accessToken}`).expect(200);
    expect(me.body.email).toBe("ada@example.com");
    const refreshed = await request(p.app).post("/api/auth/refresh").send({ refreshToken: reg.body.refreshToken }).expect(200);
    await request(p.app).get("/api/auth/me").set("authorization", `Bearer ${refreshed.body.accessToken}`).expect(200);
  });
});
