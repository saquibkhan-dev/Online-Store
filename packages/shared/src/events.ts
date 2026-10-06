import { randomUUID } from "node:crypto";
import { z } from "zod";

export const Topics = {
  orders: "orders.events",
  inventory: "inventory.events",
  payments: "payments.events"
} as const;

export const dlqTopic = (topic: string) => `${topic}.dlq`;

const uuid = z.string().uuid();
const currency = z.string().length(3);
const item = z.object({ productId: uuid, quantity: z.number().int().positive() });

/** Single source of truth for event contracts (see docs/EVENTS.md). */
export const eventContracts = {
  OrderCreated: {
    version: 1,
    topic: Topics.orders,
    schema: z.object({
      orderId: uuid,
      userId: uuid,
      items: z.array(item).min(1),
      totalMinor: z.number().int().nonnegative(),
      currency
    })
  },
  OrderConfirmed: { version: 1, topic: Topics.orders, schema: z.object({ orderId: uuid, userId: uuid }) },
  OrderCancelled: {
    version: 1,
    topic: Topics.orders,
    schema: z.object({ orderId: uuid, userId: uuid, reason: z.string().min(1) })
  },
  PaymentRequested: {
    version: 1,
    topic: Topics.orders,
    schema: z.object({ orderId: uuid, paymentId: uuid, amountMinor: z.number().int().nonnegative(), currency })
  },
  InventoryReserved: {
    version: 1,
    topic: Topics.inventory,
    schema: z.object({ orderId: uuid, reservationId: uuid, items: z.array(item).min(1) })
  },
  InventoryReservationFailed: {
    version: 1,
    topic: Topics.inventory,
    schema: z.object({
      orderId: uuid,
      reason: z.string().min(1),
      failedItems: z.array(z.object({ productId: uuid, requested: z.number().int().positive() }))
    })
  },
  PaymentCompleted: {
    version: 1,
    topic: Topics.payments,
    schema: z.object({
      orderId: uuid,
      paymentId: uuid,
      providerReference: z.string().min(1),
      amountMinor: z.number().int().nonnegative(),
      currency
    })
  },
  PaymentFailed: {
    version: 1,
    topic: Topics.payments,
    schema: z.object({ orderId: uuid, paymentId: uuid, reason: z.string().min(1) })
  },
  NotificationRequested: {
    version: 1,
    topic: Topics.orders,
    schema: z.object({ userId: uuid, type: z.string().min(1), data: z.record(z.unknown()).default({}) })
  }
} as const;

export type EventType = keyof typeof eventContracts;
export type EventPayload<T extends EventType> = z.infer<(typeof eventContracts)[T]["schema"]>;

export const eventEnvelopeSchema = z.object({
  eventId: uuid,
  eventType: z.string().min(1),
  version: z.number().int().positive(),
  timestamp: z.string().datetime(),
  producer: z.string().min(1),
  correlationId: uuid,
  causationId: uuid.nullable(),
  payload: z.record(z.unknown())
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export interface OutboxRecordInput {
  eventId: string;
  eventType: EventType;
  aggregateId: string;
  version: number;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Builds the row to insert into a service's OutboxEvent table, inside the same transaction as the state change.
 * The payload is validated against the contract here so a producer cannot write an invalid event.
 */
export function outboxRecord<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  meta: { aggregateId: string; correlationId: string; causationId?: string | null; eventId?: string }
): OutboxRecordInput {
  const contract = eventContracts[type];
  const valid = contract.schema.parse(payload) as Record<string, unknown>;
  return {
    eventId: meta.eventId ?? randomUUID(),
    eventType: type,
    aggregateId: meta.aggregateId,
    version: contract.version,
    correlationId: meta.correlationId,
    causationId: meta.causationId ?? null,
    payload: valid
  };
}

export function topicFor(type: string): string {
  const contract = (eventContracts as Record<string, { topic: string } | undefined>)[type];
  if (!contract) throw new Error(`Unknown event type: ${type}`);
  return contract.topic;
}
