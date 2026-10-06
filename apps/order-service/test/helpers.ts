import { randomUUID } from "node:crypto";
import { createLogger, createMessageProcessor, type EventType, type Logger, type RawMessage } from "@commerce/shared";
import { createApp } from "../src/app";
import type { CatalogClient, CatalogProduct } from "../src/catalog-client";
import { loadOrderConfig } from "../src/config";
import { buildHandlers } from "../src/consumers";
import { createDb } from "../src/db";
import { OrderService } from "../src/order-service";

export const TOKEN = "t".repeat(40);
export const logger: Logger = createLogger("test", "silent");
export const config = loadOrderConfig({
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/order_test",
  INTERNAL_SERVICE_TOKEN: TOKEN,
  KAFKA_BROKERS: "localhost:9092",
  PRODUCT_SERVICE_URL: "http://catalog.invalid"
});
export const db = createDb(config.DATABASE_URL, 20);

export class FakeCatalog implements CatalogClient {
  products = new Map<string, CatalogProduct>();
  down = false;
  add(name: string, priceMinor: number, currency = "INR"): CatalogProduct {
    const p = { id: randomUUID(), name, priceMinor, currency };
    this.products.set(p.id, p);
    return p;
  }
  async batch(ids: string[]) {
    if (this.down) throw new Error("down");
    return ids.flatMap((id) => this.products.get(id) ?? []);
  }
}

export const catalog = new FakeCatalog();
export const orders = new OrderService(db, catalog, logger);
export const app = createApp({ db, config, logger, orders });

export const deadLetters: string[] = [];
export const consume = createMessageProcessor({
  consumerName: "order-service",
  handlers: buildHandlers(orders),
  dlq: { sendRaw: async (_t, _k, _v, h) => void deadLetters.push(h?.["x-error"] ?? "") },
  logger,
  maxAttempts: 1
});

export function event(type: EventType, payload: Record<string, unknown>, topic: string, eventId: string = randomUUID()): RawMessage {
  return {
    topic,
    partition: 0,
    offset: "0",
    key: String(payload.orderId),
    value: JSON.stringify({ eventId, eventType: type, version: 1, timestamp: new Date().toISOString(), producer: "x", correlationId: randomUUID(), causationId: null, payload })
  };
}
export const reserved = (orderId: string, eventId?: string) =>
  event("InventoryReserved", { orderId, reservationId: randomUUID(), items: [{ productId: randomUUID(), quantity: 1 }] }, "inventory.events", eventId);
export const reservationFailed = (orderId: string) =>
  event("InventoryReservationFailed", { orderId, reason: "INSUFFICIENT_STOCK", failedItems: [] }, "inventory.events");
export const paid = (orderId: string, amountMinor: number, currency = "INR", eventId?: string) =>
  event("PaymentCompleted", { orderId, paymentId: randomUUID(), providerReference: "pay_1", amountMinor, currency }, "payments.events", eventId);
export const payFailed = (orderId: string) => event("PaymentFailed", { orderId, paymentId: randomUUID(), reason: "card_declined" }, "payments.events");

export const userHeaders = (id: string, role: "CUSTOMER" | "ADMIN" = "CUSTOMER") => ({
  "x-internal-auth": TOKEN,
  "x-user-id": id,
  "x-user-role": role
});

export async function resetDb() {
  deadLetters.length = 0;
  catalog.products.clear();
  catalog.down = false;
  for (const t of ["orderItem", "order", "cartItem", "cart", "outboxEvent", "processedEvent", "auditLog"] as const) {
    await (db[t] as unknown as { deleteMany(): Promise<unknown> }).deleteMany();
  }
}

export const outbox = async () => (await db.outboxEvent.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.eventType);
