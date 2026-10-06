import type { EventEnvelope, EventPayload } from "@commerce/shared";
import { Errors } from "@commerce/shared";
import type { Db } from "./db";
import { Prisma } from "./generated/client";

export const CONSUMER = "notification-service";

const shortId = (orderId: string) => orderId.slice(0, 8).toUpperCase();
const REASONS: Record<string, string> = {
  INSUFFICIENT_STOCK: "some items are out of stock",
  PAYMENT_FAILED: "the payment did not go through",
  USER_CANCELLED: "you cancelled it",
  TIMEOUT: "payment was not completed in time"
};

export class NotificationService {
  constructor(private readonly db: Db) {}

  /** Creates a notification exactly once per (event, consumer), however many times the event is delivered. */
  private async createOnce(
    envelope: EventEnvelope,
    n: { userId: string; type: string; title: string; body: string; data?: Prisma.InputJsonObject }
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.processedEvent.createMany({ data: [{ eventId: envelope.eventId, consumerName: CONSUMER }], skipDuplicates: true });
      if (claimed.count === 0) return;
      await tx.notification.create({ data: { ...n, data: n.data ?? {}, sourceEventId: envelope.eventId } });
    });
  }

  onOrderConfirmed(p: EventPayload<"OrderConfirmed">, e: EventEnvelope) {
    return this.createOnce(e, {
      userId: p.userId,
      type: "ORDER_CONFIRMED",
      title: "Order confirmed",
      body: `Your order #${shortId(p.orderId)} is confirmed. Thank you!`,
      data: { orderId: p.orderId }
    });
  }

  onOrderCancelled(p: EventPayload<"OrderCancelled">, e: EventEnvelope) {
    return this.createOnce(e, {
      userId: p.userId,
      type: "ORDER_CANCELLED",
      title: "Order cancelled",
      body: `Your order #${shortId(p.orderId)} was cancelled because ${REASONS[p.reason] ?? "of a problem processing it"}.`,
      data: { orderId: p.orderId, reason: p.reason }
    });
  }

  onNotificationRequested(p: EventPayload<"NotificationRequested">, e: EventEnvelope) {
    const title = typeof p.data.title === "string" ? p.data.title.slice(0, 120) : p.type;
    const body = typeof p.data.body === "string" ? p.data.body.slice(0, 1000) : "";
    return this.createOnce(e, { userId: p.userId, type: p.type, title, body, data: p.data as Prisma.InputJsonObject });
  }

  async list(userId: string, opts: { unreadOnly: boolean; page: number; limit: number }) {
    const where: Prisma.NotificationWhereInput = { userId, ...(opts.unreadOnly ? { readAt: null } : {}) };
    const [items, total, unread] = await Promise.all([
      this.db.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (opts.page - 1) * opts.limit, take: opts.limit }),
      this.db.notification.count({ where }),
      this.db.notification.count({ where: { userId, readAt: null } })
    ]);
    return { items, total, unread, page: opts.page, limit: opts.limit };
  }

  async markRead(userId: string, id: string): Promise<void> {
    // Scoped by userId so one user can never touch another's notification; already-read is a no-op.
    const owned = await this.db.notification.count({ where: { id, userId } });
    if (owned === 0) throw Errors.notFound("Notification");
    await this.db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  }
}
