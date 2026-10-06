import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, deadLetters, event, orderCreated, consume, resetDb, stock } from "./helpers";

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(resetDb);

const snapshot = async (productId: string) => {
  const row = await db.inventory.findUniqueOrThrow({ where: { productId } });
  return { quantity: row.quantity, reserved: row.reservedQuantity };
};
const outboxTypes = async () => (await db.outboxEvent.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.eventType);

describe("reservation", () => {
  it("reserves stock and emits InventoryReserved with the original correlation context", async () => {
    const p = randomUUID();
    const orderId = randomUUID();
    await stock(p, 5);
    await consume(orderCreated(orderId, [{ productId: p, quantity: 2 }]));
    expect(await snapshot(p)).toEqual({ quantity: 5, reserved: 2 });
    const reservation = await db.inventoryReservation.findUniqueOrThrow({ where: { orderId }, include: { items: true } });
    expect(reservation.status).toBe("RESERVED");
    const [out] = await db.outboxEvent.findMany();
    expect(out).toMatchObject({ eventType: "InventoryReserved", aggregateId: orderId, status: "PENDING" });
    expect(out?.causationId).toBeTruthy();
    expect(out?.payload).toMatchObject({ orderId, reservationId: reservation.id });
  });

  it("is all-or-nothing: a shortage on one line leaves every line untouched", async () => {
    const [a, b] = [randomUUID(), randomUUID()].sort();
    await stock(a!, 5);
    await stock(b!, 1);
    const orderId = randomUUID();
    await consume(orderCreated(orderId, [{ productId: a!, quantity: 3 }, { productId: b!, quantity: 2 }]));
    expect(await snapshot(a!)).toEqual({ quantity: 5, reserved: 0 });
    expect(await db.inventoryReservation.count()).toBe(0);
    const [out] = await db.outboxEvent.findMany();
    expect(out?.eventType).toBe("InventoryReservationFailed");
    expect(out?.payload).toMatchObject({ orderId, reason: "INSUFFICIENT_STOCK", failedItems: [{ productId: b, requested: 2 }] });
  });

  it("fails cleanly for a product that has no inventory record", async () => {
    await consume(orderCreated(randomUUID(), [{ productId: randomUUID(), quantity: 1 }]));
    expect(await outboxTypes()).toEqual(["InventoryReservationFailed"]);
  });

  it("merges duplicate lines for the same product", async () => {
    const p = randomUUID();
    await stock(p, 3);
    await consume(orderCreated(randomUUID(), [{ productId: p, quantity: 2 }, { productId: p, quantity: 2 }]));
    expect(await outboxTypes()).toEqual(["InventoryReservationFailed"]);
    expect(await snapshot(p)).toEqual({ quantity: 3, reserved: 0 });
  });

  it("produces the same state when one event is delivered ten times", async () => {
    const p = randomUUID();
    await stock(p, 5);
    const msg = orderCreated(randomUUID(), [{ productId: p, quantity: 2 }]);
    for (let i = 0; i < 10; i++) await consume(msg);
    expect(await snapshot(p)).toEqual({ quantity: 5, reserved: 2 });
    expect(await outboxTypes()).toEqual(["InventoryReserved"]);
  });

  it("handles the same event delivered concurrently", async () => {
    const p = randomUUID();
    await stock(p, 5);
    const msg = orderCreated(randomUUID(), [{ productId: p, quantity: 2 }]);
    await Promise.all(Array.from({ length: 8 }, () => consume(msg)));
    expect(await snapshot(p)).toEqual({ quantity: 5, reserved: 2 });
    expect(await outboxTypes()).toEqual(["InventoryReserved"]);
  });

  it("never oversells under concurrent orders for the last units", async () => {
    const p = randomUUID();
    await stock(p, 10);
    await Promise.all(Array.from({ length: 40 }, () => consume(orderCreated(randomUUID(), [{ productId: p, quantity: 1 }]))));
    const types = await outboxTypes();
    expect(types.filter((t) => t === "InventoryReserved")).toHaveLength(10);
    expect(types.filter((t) => t === "InventoryReservationFailed")).toHaveLength(30);
    expect(await snapshot(p)).toEqual({ quantity: 10, reserved: 10 });
    expect(deadLetters).toEqual([]);
  });

  it("does not deadlock when orders list the same products in opposite orders", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await stock(a, 100);
    await stock(b, 100);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        consume(orderCreated(randomUUID(), i % 2 ? [{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }] : [{ productId: b, quantity: 1 }, { productId: a, quantity: 1 }]))
      )
    );
    expect(deadLetters).toEqual([]);
    expect(await snapshot(a)).toEqual({ quantity: 100, reserved: 30 });
    expect(await snapshot(b)).toEqual({ quantity: 100, reserved: 30 });
  });
});

describe("confirmation and release", () => {
  const setup = async () => {
    const p = randomUUID();
    const orderId = randomUUID();
    await stock(p, 5);
    await consume(orderCreated(orderId, [{ productId: p, quantity: 2 }]));
    return { p, orderId };
  };

  it("confirm converts reserved units into sold units exactly once", async () => {
    const { p, orderId } = await setup();
    const msg = event("OrderConfirmed", { orderId, userId: randomUUID() });
    await consume(msg);
    await consume(msg);
    await consume(event("OrderConfirmed", { orderId, userId: randomUUID() })); // different event id, same order
    expect(await snapshot(p)).toEqual({ quantity: 3, reserved: 0 });
    expect((await db.inventoryReservation.findUniqueOrThrow({ where: { orderId } })).status).toBe("CONFIRMED");
  });

  it("release returns units and cannot be applied twice or after confirmation", async () => {
    const { p, orderId } = await setup();
    await consume(event("OrderCancelled", { orderId, userId: randomUUID(), reason: "PAYMENT_FAILED" }));
    await consume(event("OrderCancelled", { orderId, userId: randomUUID(), reason: "PAYMENT_FAILED" }));
    expect(await snapshot(p)).toEqual({ quantity: 5, reserved: 0 });
    await consume(event("OrderConfirmed", { orderId, userId: randomUUID() }));
    expect(await snapshot(p)).toEqual({ quantity: 5, reserved: 0 });
    expect((await db.inventoryReservation.findUniqueOrThrow({ where: { orderId } })).status).toBe("RELEASED");
  });

  it("ignores cancellation of an order that never held a reservation", async () => {
    await consume(event("OrderCancelled", { orderId: randomUUID(), userId: randomUUID(), reason: "X" }));
    expect(deadLetters).toEqual([]);
  });

  it("the database itself refuses to reserve more than exists", async () => {
    const p = randomUUID();
    await stock(p, 1);
    await expect(db.$executeRaw`UPDATE "Inventory" SET "reservedQuantity" = 2 WHERE "productId" = ${p}::uuid`).rejects.toThrow();
  });
});
