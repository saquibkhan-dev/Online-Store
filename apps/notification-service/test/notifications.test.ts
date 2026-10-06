import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger, createMessageProcessor, type EventType, type Logger } from "@commerce/shared";
import { createApp } from "../src/app";
import { loadNotificationConfig } from "../src/config";
import { buildHandlers } from "../src/consumers";
import { createDb } from "../src/db";
import { NotificationService } from "../src/notification-service";

const TOKEN = "t".repeat(40);
const logger: Logger = createLogger("test", "silent");
const config = loadNotificationConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/notification_test",
  INTERNAL_SERVICE_TOKEN: TOKEN,
  KAFKA_BROKERS: "localhost:9092"
});
const db = createDb(config.DATABASE_URL, 10);
const notifications = new NotificationService(db);
const app = createApp({ db, config, logger, notifications });
const consume = createMessageProcessor({ consumerName: "notification-service", handlers: buildHandlers(notifications), dlq: { sendRaw: async () => {} }, logger, maxAttempts: 1 });
const as = (id: string) => ({ "x-internal-auth": TOKEN, "x-user-id": id, "x-user-role": "CUSTOMER" });
const alice = randomUUID();
const bob = randomUUID();

const send = (type: EventType, payload: Record<string, unknown>, eventId = randomUUID()) =>
  consume({
    topic: "orders.events", partition: 0, offset: "0", key: null,
    value: JSON.stringify({ eventId, eventType: type, version: 1, timestamp: new Date().toISOString(), producer: "o", correlationId: randomUUID(), causationId: null, payload })
  });

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await db.notification.deleteMany();
  await db.processedEvent.deleteMany();
});

describe("notifications", () => {
  it("creates one notification per event even when delivered repeatedly or concurrently", async () => {
    const orderId = randomUUID();
    const id = randomUUID();
    await Promise.all(Array.from({ length: 6 }, () => send("OrderConfirmed", { orderId, userId: alice }, id)));
    await send("OrderConfirmed", { orderId, userId: alice }, id);
    expect(await db.notification.count()).toBe(1);
  });

  it("explains cancellations in plain language and handles unknown reasons", async () => {
    await send("OrderCancelled", { orderId: randomUUID(), userId: alice, reason: "INSUFFICIENT_STOCK" });
    await send("OrderCancelled", { orderId: randomUUID(), userId: alice, reason: "SOMETHING_NEW" });
    const bodies = (await db.notification.findMany()).map((n) => n.body);
    expect(bodies.some((b) => b.includes("out of stock"))).toBe(true);
    expect(bodies.some((b) => b.includes("problem processing"))).toBe(true);
  });

  it("lists only the caller's notifications, with unread counts, and requires authentication", async () => {
    await send("OrderConfirmed", { orderId: randomUUID(), userId: alice });
    await send("OrderConfirmed", { orderId: randomUUID(), userId: bob });
    await request(app).get("/api/notifications").set("x-internal-auth", TOKEN).expect(401);
    const res = await request(app).get("/api/notifications").set(as(alice)).expect(200);
    expect(res.body).toMatchObject({ total: 1, unread: 1 });
    expect(res.body.items[0].userId).toBe(alice);
  });

  it("marks read for the owner only", async () => {
    await send("OrderConfirmed", { orderId: randomUUID(), userId: alice });
    const { id } = (await request(app).get("/api/notifications").set(as(alice))).body.items[0];
    await request(app).post(`/api/notifications/${id}/read`).set(as(bob)).expect(404);
    expect((await request(app).get("/api/notifications?unreadOnly=true").set(as(alice))).body.total).toBe(1);
    await request(app).post(`/api/notifications/${id}/read`).set(as(alice)).expect(204);
    await request(app).post(`/api/notifications/${id}/read`).set(as(alice)).expect(204);
    const after = (await request(app).get("/api/notifications?unreadOnly=true").set(as(alice))).body;
    expect(after.total).toBe(0);
    expect(after.unread).toBe(0);
  });
});
