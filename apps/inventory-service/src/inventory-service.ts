import { randomUUID } from "node:crypto";
import { Errors, outboxRecord, type EventEnvelope, type EventPayload, type Logger } from "@commerce/shared";
import type { Db } from "./db";
import { claimEvent, enqueue } from "./outbox";

export const CONSUMER = "inventory-service";

interface Line {
  productId: string;
  quantity: number;
}

class StockShortage extends Error {
  constructor(readonly failed: Line[]) {
    super("INSUFFICIENT_STOCK");
  }
}

/** Merges duplicate product lines and sorts by id so concurrent reservations lock rows in the same order. */
function normalise(items: Line[]): Line[] {
  const merged = new Map<string, number>();
  for (const i of items) merged.set(i.productId, (merged.get(i.productId) ?? 0) + i.quantity);
  return [...merged].map(([productId, quantity]) => ({ productId, quantity })).sort((a, b) => a.productId.localeCompare(b.productId));
}

export class InventoryService {
  constructor(
    private readonly db: Db,
    private readonly opts: { reservationTtlMinutes: number; logger: Logger }
  ) {}

  /**
   * Reserves stock for every line or for none. Each line is one conditional UPDATE, so two concurrent orders can
   * never both take the last unit: the row lock serialises them and the second sees the reduced availability.
   */
  async reserveForOrder(payload: EventPayload<"OrderCreated">, envelope: EventEnvelope): Promise<void> {
    const items = normalise(payload.items);
    const meta = { aggregateId: payload.orderId, correlationId: envelope.correlationId, causationId: envelope.eventId };
    try {
      await this.db.$transaction(async (tx) => {
        if (!(await claimEvent(tx, envelope.eventId, CONSUMER))) return;
        if (await tx.inventoryReservation.findUnique({ where: { orderId: payload.orderId } })) return;
        const failed: Line[] = [];
        for (const item of items) {
          const updated = await tx.$executeRaw`
            UPDATE "Inventory"
            SET "reservedQuantity" = "reservedQuantity" + ${item.quantity}, "version" = "version" + 1, "updatedAt" = now()
            WHERE "productId" = ${item.productId}::uuid AND "quantity" - "reservedQuantity" >= ${item.quantity}`;
          if (updated === 0) failed.push(item);
        }
        if (failed.length > 0) throw new StockShortage(failed); // rolls back lines already reserved
        const reservation = await tx.inventoryReservation.create({
          data: {
            orderId: payload.orderId,
            status: "RESERVED",
            expiresAt: new Date(Date.now() + this.opts.reservationTtlMinutes * 60_000),
            items: { create: items }
          }
        });
        await enqueue(tx, outboxRecord("InventoryReserved", { orderId: payload.orderId, reservationId: reservation.id, items }, meta));
      });
    } catch (err) {
      if (!(err instanceof StockShortage)) throw err;
      await this.db.$transaction(async (tx) => {
        if (!(await claimEvent(tx, envelope.eventId, CONSUMER))) return;
        await enqueue(
          tx,
          outboxRecord(
            "InventoryReservationFailed",
            { orderId: payload.orderId, reason: "INSUFFICIENT_STOCK", failedItems: err.failed.map((f) => ({ productId: f.productId, requested: f.quantity })) },
            meta
          )
        );
      });
    }
  }

  /** The order was paid: reserved units become sold units. */
  async confirmForOrder(orderId: string, envelope: EventEnvelope): Promise<void> {
    await this.settle(orderId, envelope, "CONFIRMED");
  }

  /** The order was cancelled: reserved units go back on the shelf. */
  async releaseForOrder(orderId: string, envelope: EventEnvelope): Promise<void> {
    await this.settle(orderId, envelope, "RELEASED");
  }

  private async settle(orderId: string, envelope: EventEnvelope, to: "CONFIRMED" | "RELEASED"): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (!(await claimEvent(tx, envelope.eventId, CONSUMER))) return;
      // Compare-and-set on status makes this safe against concurrent or repeated settlement.
      const moved = await tx.inventoryReservation.updateMany({ where: { orderId, status: "RESERVED" }, data: { status: to } });
      if (moved.count === 0) {
        this.opts.logger.info({ orderId, to }, "no active reservation to settle");
        return;
      }
      const reservation = await tx.inventoryReservation.findUniqueOrThrow({ where: { orderId }, include: { items: true } });
      for (const item of normalise(reservation.items)) {
        if (to === "CONFIRMED") {
          await tx.$executeRaw`
            UPDATE "Inventory" SET "quantity" = "quantity" - ${item.quantity}, "reservedQuantity" = "reservedQuantity" - ${item.quantity},
                   "version" = "version" + 1, "updatedAt" = now()
            WHERE "productId" = ${item.productId}::uuid`;
        } else {
          await tx.$executeRaw`
            UPDATE "Inventory" SET "reservedQuantity" = "reservedQuantity" - ${item.quantity}, "version" = "version" + 1, "updatedAt" = now()
            WHERE "productId" = ${item.productId}::uuid`;
        }
      }
    });
  }

  /** Sets absolute on-hand stock. Refuses to go below what is already reserved. */
  async setStock(productId: string, quantity: number) {
    const rows = await this.db.$queryRaw<Array<{ productId: string; quantity: number; reservedQuantity: number }>>`
      INSERT INTO "Inventory" ("id", "productId", "quantity", "reservedQuantity", "version", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${productId}::uuid, ${quantity}, 0, 0, now())
      ON CONFLICT ("productId") DO UPDATE
        SET "quantity" = EXCLUDED."quantity", "version" = "Inventory"."version" + 1, "updatedAt" = now()
        WHERE "Inventory"."reservedQuantity" <= EXCLUDED."quantity"
      RETURNING "productId", "quantity", "reservedQuantity"`;
    const row = rows[0];
    if (!row) throw Errors.conflict("BELOW_RESERVED", "Quantity is lower than the units currently reserved");
    return { productId: row.productId, quantity: row.quantity, reservedQuantity: row.reservedQuantity, available: row.quantity - row.reservedQuantity };
  }

  async listStock(page: number, limit: number) {
    const [rows, total] = await Promise.all([
      this.db.inventory.findMany({ orderBy: { productId: "asc" }, skip: (page - 1) * limit, take: limit }),
      this.db.inventory.count()
    ]);
    const items = rows.map((r) => ({ productId: r.productId, quantity: r.quantity, reservedQuantity: r.reservedQuantity, available: r.quantity - r.reservedQuantity }));
    return { items, total, page, limit };
  }
}
