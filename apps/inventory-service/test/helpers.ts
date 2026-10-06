import { randomUUID } from "node:crypto";
import { createLogger, createMessageProcessor, type EventType, type Logger, type RawMessage } from "@commerce/shared";
import { buildHandlers } from "../src/consumers";
import { createDb } from "../src/db";
import { InventoryService } from "../src/inventory-service";

export const TOKEN = "t".repeat(40);
export const logger: Logger = createLogger("test", "silent");
export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/inventory_test";
export const db = createDb(DATABASE_URL, 20);
export const inventory = new InventoryService(db, { reservationTtlMinutes: 60, logger });

export const deadLetters: Array<{ topic: string; reason: string | undefined }> = [];
export const consume = createMessageProcessor({
  consumerName: "inventory-service",
  handlers: buildHandlers(inventory),
  dlq: { sendRaw: async (topic, _key, _value, headers) => void deadLetters.push({ topic, reason: headers?.["x-error"] }) },
  logger,
  maxAttempts: 1
});

export function event(type: EventType, payload: Record<string, unknown>, eventId: string = randomUUID()): RawMessage {
  return {
    topic: "orders.events",
    partition: 0,
    offset: "0",
    key: String(payload.orderId),
    value: JSON.stringify({
      eventId,
      eventType: type,
      version: 1,
      timestamp: new Date().toISOString(),
      producer: "order-service",
      correlationId: randomUUID(),
      causationId: null,
      payload
    })
  };
}

export const orderCreated = (orderId: string, items: Array<{ productId: string; quantity: number }>, eventId?: string) =>
  event("OrderCreated", { orderId, userId: randomUUID(), items, totalMinor: 100, currency: "INR" }, eventId);

export async function resetDb() {
  deadLetters.length = 0;
  await db.reservationItem.deleteMany();
  await db.inventoryReservation.deleteMany();
  await db.inventory.deleteMany();
  await db.outboxEvent.deleteMany();
  await db.processedEvent.deleteMany();
}

export const stock = (productId: string, quantity: number) => db.inventory.create({ data: { productId, quantity } });
