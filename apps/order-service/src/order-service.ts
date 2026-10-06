import { randomUUID } from "node:crypto";
import {
  AppError,
  Errors,
  lineTotalMinor,
  MAX_ORDER_TOTAL_MINOR,
  outboxRecord,
  PermanentError,
  sumMinor,
  type EventEnvelope,
  type EventPayload,
  type Logger,
  type Role
} from "@commerce/shared";
import type { CatalogClient, CatalogProduct } from "./catalog-client";
import type { Db } from "./db";
import { Prisma } from "./generated/client";
import { claimEvent, enqueue } from "./outbox";
import { IN_FLIGHT, USER_CANCELLABLE, type OrderStatus } from "./state";

export const CONSUMER = "order-service";
export const MAX_QUANTITY = 20;
export const MAX_CART_LINES = 50;

export interface RequestMeta {
  requestId?: string;
  correlationId: string;
}

type Tx = Prisma.TransactionClient;
type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

export function presentOrder(o: OrderWithItems) {
  return {
    id: o.id,
    userId: o.userId,
    status: o.status,
    totalMinor: o.totalMinor,
    currency: o.currency,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    items: o.items.map((i) => ({
      productId: i.productId,
      productName: i.productName,
      unitPriceMinor: i.unitPriceMinor,
      quantity: i.quantity,
      lineTotalMinor: i.unitPriceMinor * i.quantity
    }))
  };
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogClient,
    private readonly logger: Logger
  ) {}

  /** Any catalogue failure becomes a 503 for the caller; the order service never guesses at prices. */
  private async lookup(ids: string[], meta?: RequestMeta): Promise<CatalogProduct[]> {
    try {
      return await this.catalog.batch(ids, meta);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.logger.error({ err }, "catalogue lookup failed");
      throw Errors.unavailable("Product catalogue is temporarily unavailable");
    }
  }

  // ---------------------------------------------------------------- cart

  async getCart(userId: string, meta?: RequestMeta) {
    const cart = await this.db.cart.findUnique({ where: { userId }, include: { items: { orderBy: { createdAt: "asc" } } } });
    const items = cart?.items ?? [];
    let products = new Map<string, CatalogProduct>();
    try {
      products = new Map((await this.lookup(items.map((i) => i.productId), meta)).map((p) => [p.id, p]));
    } catch {
      this.logger.warn("catalogue unavailable; returning cart without prices");
    }
    const lines = items.map((i) => {
      const p = products.get(i.productId);
      return {
        id: i.id,
        productId: i.productId,
        quantity: i.quantity,
        product: p ? { name: p.name, unitPriceMinor: p.priceMinor, currency: p.currency } : null,
        lineTotalMinor: p ? p.priceMinor * i.quantity : null
      };
    });
    const priced = lines.every((l) => l.lineTotalMinor !== null);
    return { items: lines, subtotalMinor: priced ? sumMinor(lines.map((l) => l.lineTotalMinor ?? 0)) : null };
  }

  async addItem(userId: string, productId: string, quantity: number, meta: RequestMeta) {
    const [product] = await this.lookup([productId], meta);
    if (!product) throw Errors.notFound("Product");
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.$transaction(async (tx) => {
          const cart = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
          const existing = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId } } });
          if (!existing && (await tx.cartItem.count({ where: { cartId: cart.id } })) >= MAX_CART_LINES) {
            throw Errors.conflict("CART_FULL", `A cart can hold at most ${MAX_CART_LINES} different products`);
          }
          // Atomic add-or-increment, capped per line.
          await tx.$executeRaw`
            INSERT INTO "CartItem" ("id", "cartId", "productId", "quantity", "updatedAt")
            VALUES (${randomUUID()}::uuid, ${cart.id}::uuid, ${productId}::uuid, ${quantity}, now())
            ON CONFLICT ("cartId", "productId")
            DO UPDATE SET "quantity" = LEAST("CartItem"."quantity" + EXCLUDED."quantity", ${MAX_QUANTITY}), "updatedAt" = now()`;
        });
        break;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < 2) continue; // two first-ever adds raced to create the cart
        throw err;
      }
    }
    return this.getCart(userId, meta);
  }

  async setQuantity(userId: string, itemId: string, quantity: number, meta: RequestMeta) {
    const updated = await this.db.cartItem.updateMany({ where: { id: itemId, cart: { userId } }, data: { quantity } });
    if (updated.count === 0) throw Errors.notFound("Cart item");
    return this.getCart(userId, meta);
  }

  async removeItem(userId: string, itemId: string): Promise<void> {
    await this.db.cartItem.deleteMany({ where: { id: itemId, cart: { userId } } });
  }

  async clearCart(userId: string): Promise<void> {
    await this.db.cartItem.deleteMany({ where: { cart: { userId } } });
  }

  // ------------------------------------------------------------ checkout

  /**
   * Turns the user's server-side cart into an order. Prices come from the catalogue, never from the client.
   * Calling it again with the same idempotency key returns the original order instead of creating another.
   */
  async checkout(userId: string, idempotencyKey: string, meta: RequestMeta): Promise<{ order: OrderWithItems; replay: boolean }> {
    const existing = await this.findByKey(userId, idempotencyKey);
    if (existing) return { order: existing, replay: true };

    const cart = await this.db.cart.findUnique({ where: { userId }, include: { items: true } });
    if (!cart || cart.items.length === 0) throw Errors.conflict("EMPTY_CART", "Your cart is empty");

    const products = new Map((await this.lookup(cart.items.map((i) => i.productId), meta)).map((p) => [p.id, p]));
    const missing = cart.items.filter((i) => !products.has(i.productId)).map((i) => i.productId);
    if (missing.length > 0) throw new AppError(409, "PRODUCT_UNAVAILABLE", "Some products are no longer available", { productIds: missing });
    const currencies = new Set([...products.values()].map((p) => p.currency));
    if (currencies.size > 1) throw Errors.conflict("MIXED_CURRENCY", "A cart cannot mix currencies");
    const currency = [...currencies][0] ?? "INR";

    let totalMinor: number;
    try {
      totalMinor = sumMinor(cart.items.map((i) => lineTotalMinor(products.get(i.productId)?.priceMinor ?? 0, i.quantity)));
    } catch {
      throw new AppError(422, "ORDER_TOO_LARGE", "Order total is too large");
    }
    if (totalMinor > MAX_ORDER_TOTAL_MINOR) throw new AppError(422, "ORDER_TOO_LARGE", "Order total is too large");

    const orderId = randomUUID();
    const snapshot = new Map(cart.items.map((i) => [i.productId, i.quantity]));
    try {
      const order = await this.db.$transaction(async (tx) => {
        // Lock the cart so two checkouts can't consume it twice, then make sure it is what we priced.
        await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cart.id}::uuid FOR UPDATE`;
        const current = await tx.cartItem.findMany({ where: { cartId: cart.id } });
        const unchanged = current.length === snapshot.size && current.every((i) => snapshot.get(i.productId) === i.quantity);
        if (!unchanged) throw Errors.conflict("CART_CHANGED", "Your cart changed during checkout; review it and try again");

        const created = await tx.order.create({
          data: {
            id: orderId,
            userId,
            totalMinor,
            currency,
            idempotencyKey,
            correlationId: meta.correlationId,
            items: {
              create: cart.items.map((i) => {
                const p = products.get(i.productId) as CatalogProduct;
                return { productId: i.productId, productName: p.name, unitPriceMinor: p.priceMinor, quantity: i.quantity };
              })
            }
          },
          include: { items: true }
        });
        await enqueue(
          tx,
          outboxRecord(
            "OrderCreated",
            { orderId, userId, items: cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity })), totalMinor, currency },
            { aggregateId: orderId, correlationId: meta.correlationId }
          )
        );
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        return created;
      });
      return { order, replay: false };
    } catch (err) {
      // A concurrent request with the same key won the race; hand back its order.
      if (isUniqueViolation(err) || (err instanceof AppError && err.code === "CART_CHANGED")) {
        const winner = await this.findByKey(userId, idempotencyKey);
        if (winner) return { order: winner, replay: true };
      }
      throw err;
    }
  }

  private findByKey(userId: string, idempotencyKey: string) {
    return this.db.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } }, include: { items: true } });
  }

  // -------------------------------------------------------------- orders

  /** Customers can only see their own orders; someone else's order looks exactly like a missing one. */
  async getOrder(orderId: string, viewer: { id: string; role: Role }) {
    const order = await this.db.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order || (order.userId !== viewer.id && viewer.role !== "ADMIN")) throw Errors.notFound("Order");
    return order;
  }

  async listOrders(filter: { userId?: string; status?: OrderStatus }, page: number, limit: number) {
    const where: Prisma.OrderWhereInput = { ...(filter.userId ? { userId: filter.userId } : {}), ...(filter.status ? { status: filter.status } : {}) };
    const [items, total] = await Promise.all([
      this.db.order.findMany({ where, include: { items: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
      this.db.order.count({ where })
    ]);
    return { items: items.map(presentOrder), total, page, limit };
  }

  async cancelByUser(orderId: string, viewer: { id: string; role: Role }) {
    const order = await this.getOrder(orderId, viewer);
    if (order.status === "CANCELLED") return order;
    const moved = await this.db.$transaction((tx) => this.cancelInTx(tx, order, USER_CANCELLABLE, "USER_CANCELLED", null));
    const fresh = await this.getOrder(orderId, viewer);
    if (!moved && fresh.status !== "CANCELLED") throw Errors.conflict("NOT_CANCELLABLE", `An order that is ${fresh.status} cannot be cancelled`);
    return fresh;
  }

  /** Cancels orders stuck waiting longer than the TTL (abandoned payment, lost event). Returns how many were cancelled. */
  async expireStale(olderThan: Date, limit = 100): Promise<number> {
    const stale = await this.db.order.findMany({
      where: { status: { in: [...IN_FLIGHT] }, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: "asc" },
      take: limit
    });
    let cancelled = 0;
    for (const order of stale) {
      const moved = await this.db.$transaction((tx) => this.cancelInTx(tx, order, IN_FLIGHT, "TIMEOUT", null));
      if (moved) cancelled++;
    }
    return cancelled;
  }

  // ---------------------------------------------------------------- saga

  async onInventoryReserved(p: EventPayload<"InventoryReserved">, env: EventEnvelope): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (!(await claimEvent(tx, env.eventId, CONSUMER))) return;
      const order = await this.requireOrder(tx, p.orderId);
      if (!(await this.move(tx, order.id, ["PENDING"], "PAYMENT_PENDING"))) {
        // Already cancelled/expired: the OrderCancelled event releases the reservation.
        this.logger.info({ orderId: order.id, status: order.status }, "InventoryReserved ignored: order no longer pending");
        return;
      }
      await enqueue(
        tx,
        outboxRecord(
          "PaymentRequested",
          { orderId: order.id, paymentId: randomUUID(), amountMinor: order.totalMinor, currency: order.currency },
          { aggregateId: order.id, correlationId: order.correlationId, causationId: env.eventId }
        )
      );
    });
  }

  async onInventoryReservationFailed(p: EventPayload<"InventoryReservationFailed">, env: EventEnvelope): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (!(await claimEvent(tx, env.eventId, CONSUMER))) return;
      const order = await this.requireOrder(tx, p.orderId);
      await this.cancelInTx(tx, order, ["PENDING"], p.reason, env.eventId);
    });
  }

  async onPaymentCompleted(p: EventPayload<"PaymentCompleted">, env: EventEnvelope): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (!(await claimEvent(tx, env.eventId, CONSUMER))) return;
      const order = await this.requireOrder(tx, p.orderId);
      if (p.amountMinor !== order.totalMinor || p.currency !== order.currency) {
        await this.audit(tx, "PAYMENT_AMOUNT_MISMATCH", order.id, { paymentId: p.paymentId, paid: p.amountMinor, expected: order.totalMinor });
        this.logger.error({ orderId: order.id }, "payment amount does not match order total; order not confirmed");
        return;
      }
      if (await this.move(tx, order.id, ["PAYMENT_PENDING"], "CONFIRMED")) {
        await enqueue(
          tx,
          outboxRecord("OrderConfirmed", { orderId: order.id, userId: order.userId }, { aggregateId: order.id, correlationId: order.correlationId, causationId: env.eventId })
        );
        return;
      }
      if (order.status !== "CONFIRMED") {
        // The customer was charged for an order we no longer hold. A human must refund it.
        await this.audit(tx, "PAYMENT_RECEIVED_FOR_UNPAYABLE_ORDER", order.id, {
          paymentId: p.paymentId,
          providerReference: p.providerReference,
          orderStatus: order.status
        });
        this.logger.error({ orderId: order.id, status: order.status }, "payment completed for an order that is not payable; refund required");
      }
    });
  }

  async onPaymentFailed(p: EventPayload<"PaymentFailed">, env: EventEnvelope): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (!(await claimEvent(tx, env.eventId, CONSUMER))) return;
      const order = await this.requireOrder(tx, p.orderId);
      await this.cancelInTx(tx, order, ["PAYMENT_PENDING"], "PAYMENT_FAILED", env.eventId);
    });
  }

  // ------------------------------------------------------------- helpers

  private async requireOrder(tx: Tx, orderId: string) {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    // Orders are committed before their events exist, so a missing order is a bad event, not a timing issue.
    if (!order) throw new PermanentError(`Unknown order ${orderId}`);
    return order;
  }

  /** Compare-and-set status change: succeeds only if the order is still in one of the expected states. */
  private async move(tx: Tx, orderId: string, from: readonly OrderStatus[], to: OrderStatus, cancelReason?: string): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id: orderId, status: { in: [...from] } },
      data: { status: to, ...(cancelReason ? { cancelReason } : {}) }
    });
    return result.count === 1;
  }

  private async cancelInTx(
    tx: Tx,
    order: { id: string; userId: string; correlationId: string },
    from: readonly OrderStatus[],
    reason: string,
    causationId: string | null
  ): Promise<boolean> {
    if (!(await this.move(tx, order.id, from, "CANCELLED", reason))) return false;
    await enqueue(
      tx,
      outboxRecord("OrderCancelled", { orderId: order.id, userId: order.userId, reason }, { aggregateId: order.id, correlationId: order.correlationId, causationId })
    );
    return true;
  }

  private audit(tx: Tx, action: string, orderId: string, metadata: Prisma.InputJsonObject) {
    return tx.auditLog.create({ data: { action, resourceType: "Order", resourceId: orderId, metadata } });
  }
}
