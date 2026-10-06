import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, catalog, consume, db, deadLetters, orders, outbox, paid, payFailed, reservationFailed, reserved, resetDb, userHeaders } from "./helpers";

const alice = randomUUID();
beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(resetDb);

async function placeOrder(price = 2500) {
  const lamp = catalog.add("Lamp", price);
  await request(app).post("/api/cart/items").set(userHeaders(alice)).send({ productId: lamp.id, quantity: 1 });
  const res = await request(app).post("/api/checkout").set(userHeaders(alice)).set("idempotency-key", `key-${randomUUID()}`).expect(202);
  await db.outboxEvent.deleteMany(); // isolate the events produced by the saga step under test
  return { orderId: res.body.orderId as string, price };
}
const status = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).status;

describe("order saga", () => {
  it("happy path: reserved -> payment requested -> paid -> confirmed", async () => {
    const { orderId, price } = await placeOrder();
    await consume(reserved(orderId));
    expect(await status(orderId)).toBe("PAYMENT_PENDING");
    const [req] = await db.outboxEvent.findMany();
    expect(req).toMatchObject({ eventType: "PaymentRequested", aggregateId: orderId });
    expect(req?.payload).toMatchObject({ orderId, amountMinor: price, currency: "INR" });
    expect(req?.causationId).toBeTruthy();

    await consume(paid(orderId, price));
    expect(await status(orderId)).toBe("CONFIRMED");
    expect(await outbox()).toEqual(["PaymentRequested", "OrderConfirmed"]);
  });

  it("cancels with a reason and emits OrderCancelled when stock is short", async () => {
    const { orderId } = await placeOrder();
    await consume(reservationFailed(orderId));
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "CANCELLED", cancelReason: "INSUFFICIENT_STOCK" });
    expect(await outbox()).toEqual(["OrderCancelled"]);
  });

  it("cancels when payment fails", async () => {
    const { orderId } = await placeOrder();
    await consume(reserved(orderId));
    await consume(payFailed(orderId));
    expect(await status(orderId)).toBe("CANCELLED");
    expect(await outbox()).toEqual(["PaymentRequested", "OrderCancelled"]);
  });

  it("is idempotent: redelivery and concurrent delivery change nothing", async () => {
    const { orderId, price } = await placeOrder();
    const r = reserved(orderId);
    await Promise.all([consume(r), consume(r), consume(r)]);
    await consume(r);
    expect(await outbox()).toEqual(["PaymentRequested"]);
    const p = paid(orderId, price);
    await Promise.all([consume(p), consume(p)]);
    await consume(p);
    expect(await outbox()).toEqual(["PaymentRequested", "OrderConfirmed"]);
    // a *different* PaymentCompleted for an already-confirmed order is also harmless
    await consume(paid(orderId, price));
    expect(await outbox()).toEqual(["PaymentRequested", "OrderConfirmed"]);
    expect(await db.auditLog.count()).toBe(0);
  });

  it("tolerates out-of-order events: payment before reservation is never confirmed early", async () => {
    const { orderId, price } = await placeOrder();
    await consume(paid(orderId, price)); // order is still PENDING
    expect(await status(orderId)).toBe("PENDING");
    expect(await db.auditLog.count()).toBe(1); // flagged for a human: paid but not payable
  });

  it("refuses to confirm when the paid amount does not match the order", async () => {
    const { orderId, price } = await placeOrder();
    await consume(reserved(orderId));
    await consume(paid(orderId, price - 1));
    await consume(paid(orderId, price, "USD"));
    expect(await status(orderId)).toBe("PAYMENT_PENDING");
    expect((await db.auditLog.findMany()).map((a) => a.action)).toEqual(["PAYMENT_AMOUNT_MISMATCH", "PAYMENT_AMOUNT_MISMATCH"]);
  });

  it("flags payments that arrive for cancelled orders so they can be refunded", async () => {
    const { orderId, price } = await placeOrder();
    await consume(reserved(orderId));
    await request(app).post(`/api/orders/${orderId}/cancel`).set(userHeaders(alice)).expect(200);
    await db.outboxEvent.deleteMany();
    await consume(paid(orderId, price));
    expect(await status(orderId)).toBe("CANCELLED");
    expect(await outbox()).toEqual([]);
    expect((await db.auditLog.findFirstOrThrow()).action).toBe("PAYMENT_RECEIVED_FOR_UNPAYABLE_ORDER");
  });

  it("a late InventoryReserved for a cancelled order does not resurrect it or request payment", async () => {
    const { orderId } = await placeOrder();
    await request(app).post(`/api/orders/${orderId}/cancel`).set(userHeaders(alice)).expect(200);
    await db.outboxEvent.deleteMany();
    await consume(reserved(orderId));
    expect(await status(orderId)).toBe("CANCELLED");
    expect(await outbox()).toEqual([]);
  });

  it("dead-letters events for orders that do not exist", async () => {
    await consume(reserved(randomUUID()));
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatch(/Unknown order/);
  });
});

describe("cancellation", () => {
  it("customers can cancel before payment completes, once, and not after confirmation", async () => {
    const { orderId, price } = await placeOrder();
    const first = await request(app).post(`/api/orders/${orderId}/cancel`).set(userHeaders(alice)).expect(200);
    expect(first.body.status).toBe("CANCELLED");
    await request(app).post(`/api/orders/${orderId}/cancel`).set(userHeaders(alice)).expect(200);
    expect(await outbox()).toEqual(["OrderCancelled"]);

    const second = await placeOrder();
    await consume(reserved(second.orderId));
    await consume(paid(second.orderId, price));
    const res = await request(app).post(`/api/orders/${second.orderId}/cancel`).set(userHeaders(alice)).expect(409);
    expect(res.body.error.code).toBe("NOT_CANCELLABLE");
  });

  it("concurrent cancellations emit a single OrderCancelled", async () => {
    const { orderId } = await placeOrder();
    await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/api/orders/${orderId}/cancel`).set(userHeaders(alice))));
    expect(await outbox()).toEqual(["OrderCancelled"]);
  });

  it("the timeout sweep cancels only stale in-flight orders", async () => {
    const stale = await placeOrder();
    const fresh = await placeOrder();
    const done = await placeOrder();
    await consume(reserved(done.orderId));
    await consume(paid(done.orderId, done.price));
    await db.order.updateMany({ where: { id: { in: [stale.orderId, done.orderId] } }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
    await db.outboxEvent.deleteMany();
    expect(await orders.expireStale(new Date(Date.now() - 1_800_000))).toBe(1);
    expect(await orders.expireStale(new Date(Date.now() - 1_800_000))).toBe(0);
    expect(await status(stale.orderId)).toBe("CANCELLED");
    expect(await status(fresh.orderId)).toBe("PENDING");
    expect(await status(done.orderId)).toBe("CONFIRMED");
    expect((await db.outboxEvent.findFirstOrThrow()).payload).toMatchObject({ reason: "TIMEOUT" });
  });
});
