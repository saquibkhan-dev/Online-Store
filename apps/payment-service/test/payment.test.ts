import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger, createMessageProcessor, type Logger } from "@commerce/shared";
import { createApp } from "../src/app";
import { loadPaymentConfig } from "../src/config";
import { buildHandlers } from "../src/consumers";
import { createDb } from "../src/db";
import { PaymentService } from "../src/payment-service";
import { signPayload, verifySignature } from "../src/signature";

const TOKEN = "t".repeat(40);
const SECRET = "w".repeat(40);
const logger: Logger = createLogger("test", "silent");
const config = loadPaymentConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/payment_test",
  INTERNAL_SERVICE_TOKEN: TOKEN,
  KAFKA_BROKERS: "localhost:9092",
  PAYMENT_WEBHOOK_SECRET: SECRET
});
const db = createDb(config.DATABASE_URL, 10);
const payments = new PaymentService(db, logger);
const app = createApp({ db, config, logger, payments });
const consume = createMessageProcessor({ consumerName: "payment-service", handlers: buildHandlers(payments), dlq: { sendRaw: async () => {} }, logger, maxAttempts: 1 });

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(async () => {
  for (const t of ["payment", "webhookEvent", "outboxEvent", "processedEvent"] as const) {
    await (db[t] as unknown as { deleteMany(): Promise<unknown> }).deleteMany();
  }
});

async function requested(amountMinor = 2500, currency = "INR") {
  const orderId = randomUUID();
  const paymentId = randomUUID();
  await consume({
    topic: "orders.events", partition: 0, offset: "0", key: orderId,
    value: JSON.stringify({
      eventId: randomUUID(), eventType: "PaymentRequested", version: 1, timestamp: new Date().toISOString(), producer: "order-service",
      correlationId: randomUUID(), causationId: null, payload: { orderId, paymentId, amountMinor, currency }
    })
  });
  return { orderId, paymentId, amountMinor, currency };
}

const webhook = (body: unknown, opts: { secret?: string; t?: number; raw?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(body);
  const sig = signPayload(opts.secret ?? SECRET, raw, opts.t ?? Math.floor(Date.now() / 1000));
  return request(app).post("/api/payments/webhook").set("x-internal-auth", TOKEN).set("content-type", "application/json").set("x-signature", sig).send(raw);
};
const succeeded = (o: { orderId: string; amountMinor: number; currency: string }, id = `evt_${randomUUID()}`) => ({
  id, type: "payment.succeeded", data: { orderId: o.orderId, reference: "pay_123", amountMinor: o.amountMinor, currency: o.currency }
});
const types = async () => (await db.outboxEvent.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.eventType);

describe("signature", () => {
  const body = Buffer.from('{"a":1}');
  const now = 1_800_000_000;
  const header = signPayload(SECRET, body, now);
  it("accepts a valid signature and rejects tampering, wrong secret, staleness and garbage", () => {
    expect(verifySignature(SECRET, body, header, 300, now)).toBe("ok");
    expect(verifySignature(SECRET, Buffer.from('{"a":2}'), header, 300, now)).toBe("mismatch");
    expect(verifySignature("x".repeat(40), body, header, 300, now)).toBe("mismatch");
    expect(verifySignature(SECRET, body, header, 300, now + 301)).toBe("expired");
    expect(verifySignature(SECRET, body, header, 300, now - 301)).toBe("expired");
    expect(verifySignature(SECRET, body, undefined, 300, now)).toBe("malformed");
    expect(verifySignature(SECRET, body, "t=abc,v1=zz", 300, now)).toBe("malformed");
    expect(verifySignature(SECRET, body, `t=${now},v1=abcd`, 300, now)).toBe("malformed"); // wrong length must not throw
  });
});

describe("payment requested", () => {
  it("creates one pending payment per order even if the event is redelivered or duplicated", async () => {
    const o = await requested();
    await requested();
    expect(await db.payment.count()).toBe(2);
    const dup = await db.payment.findUniqueOrThrow({ where: { orderId: o.orderId } });
    expect(dup).toMatchObject({ id: o.paymentId, status: "PENDING", amountMinor: 2500 });
  });
});

describe("webhook", () => {
  it("rejects unsigned, badly signed, stale and non-gateway requests with 401/403 and no side effects", async () => {
    const o = await requested();
    const body = succeeded(o);
    await request(app).post("/api/payments/webhook").set("x-internal-auth", TOKEN).send(body).expect(401);
    await webhook(body, { secret: "x".repeat(40) }).expect(401);
    await webhook(body, { t: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
    await request(app).post("/api/payments/webhook").send(body).expect(403);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: o.orderId } })).status).toBe("PENDING");
    expect(await types()).toEqual([]);
  });

  it("completes the payment and emits PaymentCompleted", async () => {
    const o = await requested();
    const res = await webhook(succeeded(o)).expect(200);
    expect(res.body.outcome).toBe("processed");
    expect(await db.payment.findUniqueOrThrow({ where: { orderId: o.orderId } })).toMatchObject({ status: "COMPLETED", providerReference: "pay_123" });
    const [evt] = await db.outboxEvent.findMany();
    expect(evt).toMatchObject({ eventType: "PaymentCompleted", aggregateId: o.orderId });
    expect(evt?.payload).toMatchObject({ orderId: o.orderId, paymentId: o.paymentId, amountMinor: 2500, currency: "INR" });
  });

  it("is idempotent for replays and concurrent retries of the same provider event", async () => {
    const o = await requested();
    const body = succeeded(o, "evt_fixed");
    const results = await Promise.all(Array.from({ length: 6 }, () => webhook(body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.outcome === "processed")).toHaveLength(1);
    expect(await types()).toEqual(["PaymentCompleted"]);
    expect((await webhook(succeeded(o, "evt_other")).expect(200)).body.outcome).toBe("ignored");
    expect(await types()).toEqual(["PaymentCompleted"]);
  });

  it("emits PaymentFailed for declined payments and does not allow a later success", async () => {
    const o = await requested();
    await webhook({ id: "evt_f", type: "payment.failed", data: { orderId: o.orderId, reference: "pay_9", amountMinor: 2500, currency: "INR", reason: "card_declined" } }).expect(200);
    expect(await types()).toEqual(["PaymentFailed"]);
    await webhook(succeeded(o)).expect(200);
    expect(await types()).toEqual(["PaymentFailed"]);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: o.orderId } })).status).toBe("FAILED");
  });

  it("never completes a payment whose amount or currency differs; it flags it for review", async () => {
    const o = await requested(2500);
    expect((await webhook(succeeded({ ...o, amountMinor: 100 })).expect(200)).body.outcome).toBe("needs_review");
    const row = await db.payment.findUniqueOrThrow({ where: { orderId: o.orderId } });
    expect(row).toMatchObject({ status: "REQUIRES_REVIEW", failureReason: "AMOUNT_MISMATCH" });
    expect(await types()).toEqual([]);
  });

  it("asks the provider to retry when the webhook beats our own PaymentRequested handling", async () => {
    const orderId = randomUUID();
    const body = succeeded({ orderId, amountMinor: 10, currency: "INR" }, "evt_early");
    await webhook(body).expect(409);
    expect(await db.webhookEvent.count()).toBe(0); // dedupe row rolled back, so the retry is processed
    await consume({
      topic: "orders.events", partition: 0, offset: "1", key: orderId,
      value: JSON.stringify({ eventId: randomUUID(), eventType: "PaymentRequested", version: 1, timestamp: new Date().toISOString(), producer: "o", correlationId: randomUUID(), causationId: null, payload: { orderId, paymentId: randomUUID(), amountMinor: 10, currency: "INR" } })
    });
    await webhook(body).expect(200);
    expect(await types()).toEqual(["PaymentCompleted"]);
  });

  it("validates the body after the signature and tolerates garbage", async () => {
    await webhook({ id: "x", type: "payment.refunded", data: {} }).expect(400);
    await webhook(null, { raw: "{not json" }).expect(400);
  });
});
