import type { OutboxRecordInput } from "@commerce/shared";
import { Prisma } from "./generated/client";

type Tx = Prisma.TransactionClient;

/** Writes an event to the outbox inside the caller's transaction. */
export function enqueue(tx: Tx, record: OutboxRecordInput) {
  return tx.outboxEvent.create({ data: { ...record, payload: record.payload as Prisma.InputJsonObject } });
}

/**
 * Records that this consumer processed the event, as the first statement of the handler's transaction.
 * Returns false for a duplicate delivery; the handler must then do nothing.
 */
export async function claimEvent(tx: Tx, eventId: string, consumerName: string): Promise<boolean> {
  const result = await tx.processedEvent.createMany({ data: [{ eventId, consumerName }], skipDuplicates: true });
  return result.count === 1;
}
