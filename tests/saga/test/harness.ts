import { randomUUID } from "node:crypto";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createLogger, createMessageProcessor, OutboxRelay, signAccessToken, verifyAccessToken,
  type EventEnvelope, type Handler, type Logger, type Publisher, type RawMessage
} from "@commerce/shared";
import { createApp as gatewayApp } from "../../../apps/api-gateway/src/app";
import { loadGatewayConfig } from "../../../apps/api-gateway/src/config";
import { createApp as inventoryApp } from "../../../apps/inventory-service/src/app";
import { loadInventoryConfig } from "../../../apps/inventory-service/src/config";
import { buildHandlers as inventoryHandlers, consumeTopics as inventoryTopics } from "../../../apps/inventory-service/src/consumers";
import { createDb as inventoryDb } from "../../../apps/inventory-service/src/db";
import { InventoryService } from "../../../apps/inventory-service/src/inventory-service";
import { createApp as notificationApp } from "../../../apps/notification-service/src/app";
import { loadNotificationConfig } from "../../../apps/notification-service/src/config";
import { buildHandlers as notificationHandlers, consumeTopics as notificationTopics } from "../../../apps/notification-service/src/consumers";
import { createDb as notificationDb } from "../../../apps/notification-service/src/db";
import { NotificationService } from "../../../apps/notification-service/src/notification-service";
import { createApp as orderApp } from "../../../apps/order-service/src/app";
import { HttpCatalogClient } from "../../../apps/order-service/src/catalog-client";
import { loadOrderConfig } from "../../../apps/order-service/src/config";
import { buildHandlers as orderHandlers, consumeTopics as orderTopics } from "../../../apps/order-service/src/consumers";
import { createDb as orderDb } from "../../../apps/order-service/src/db";
import { OrderService } from "../../../apps/order-service/src/order-service";
import { createApp as paymentApp } from "../../../apps/payment-service/src/app";
import { loadPaymentConfig } from "../../../apps/payment-service/src/config";
import { buildHandlers as paymentHandlers, consumeTopics as paymentTopics } from "../../../apps/payment-service/src/consumers";
import { createDb as paymentDb } from "../../../apps/payment-service/src/db";
import { PaymentService } from "../../../apps/payment-service/src/payment-service";
import { signPayload } from "../../../apps/payment-service/src/signature";
import { createApp as productApp } from "../../../apps/product-service/src/app";
import { loadProductConfig } from "../../../apps/product-service/src/config";
import { createDb as productDb } from "../../../apps/product-service/src/db";
import { createApp as userApp } from "../../../apps/user-service/src/app";
import { loadUserConfig } from "../../../apps/user-service/src/config";
import { createDb as userDb } from "../../../apps/user-service/src/db";

export const INTERNAL = "i".repeat(40);
export const JWT = "j".repeat(40);
export const WEBHOOK_SECRET = "w".repeat(40);
const pg = (db: string) => `postgresql://postgres:postgres@localhost:5432/${process.env.SAGA_DB_PREFIX ?? "saga_"}${db}`;
const kafka = { KAFKA_BROKERS: "unused:9092" };
const logger: Logger = createLogger("saga", "silent");

/** Delivers outbox events straight to subscribed consumers, standing in for Kafka. */
class InMemoryBus implements Publisher {
  readonly subscribers: Array<{ topics: string[]; process: (m: RawMessage) => Promise<void>; name: string }> = [];
  duplicate = false;
  delivered: EventEnvelope[] = [];
  private offset = 0;

  subscribe(name: string, topics: string[], handlers: Handler[]) {
    const process = createMessageProcessor({
      consumerName: name, handlers, logger, maxAttempts: 2, sleep: async () => {},
      dlq: { sendRaw: async (topic, _k, _v, h) => { throw new Error(`DLQ ${topic}: ${h?.["x-error"]}`); } }
    });
    this.subscribers.push({ name, topics, process });
  }

  async publish(topic: string, key: string, envelope: EventEnvelope) {
    this.delivered.push(envelope);
    const value = JSON.stringify(envelope);
    for (const s of this.subscribers.filter((x) => x.topics.includes(topic))) {
      const msg = { topic, partition: 0, offset: String(this.offset++), key, value };
      await s.process(msg);
      if (this.duplicate) await Promise.all([s.process(msg), s.process(msg)]);
    }
  }
}

const listen = (app: http.RequestListener) =>
  new Promise<{ url: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }));
  });

export async function startPlatform() {
  const bus = new InMemoryBus();
  const base = { NODE_ENV: "test", INTERNAL_SERVICE_TOKEN: INTERNAL };

  const udb = userDb(pg("user"), 5);
  const pdb = productDb(pg("product"), 5);
  const idb = inventoryDb(pg("inventory"), 15);
  const odb = orderDb(pg("order"), 15);
  const ydb = paymentDb(pg("payment"), 10);
  const ndb = notificationDb(pg("notification"), 5);

  const uCfg = loadUserConfig({ ...base, DATABASE_URL: pg("user"), JWT_ACCESS_SECRET: JWT, BCRYPT_COST: "4" });
  const pCfg = loadProductConfig({ ...base, DATABASE_URL: pg("product") });
  const iCfg = loadInventoryConfig({ ...base, ...kafka, DATABASE_URL: pg("inventory") });
  const yCfg = loadPaymentConfig({ ...base, ...kafka, DATABASE_URL: pg("payment"), PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET });
  const nCfg = loadNotificationConfig({ ...base, ...kafka, DATABASE_URL: pg("notification") });

  const user = await listen(userApp({ db: udb, config: uCfg, logger }));
  const product = await listen(productApp({ db: pdb, config: pCfg, logger }));
  const inventory = new InventoryService(idb, { reservationTtlMinutes: 60, logger });
  const inv = await listen(inventoryApp({ db: idb, config: iCfg, logger, inventory }));
  const payments = new PaymentService(ydb, logger);
  const pay = await listen(paymentApp({ db: ydb, config: yCfg, logger, payments }));
  const notifications = new NotificationService(ndb);
  const notif = await listen(notificationApp({ db: ndb, config: nCfg, logger, notifications }));
  const oCfg = loadOrderConfig({ ...base, ...kafka, DATABASE_URL: pg("order"), PRODUCT_SERVICE_URL: product.url });
  const orders = new OrderService(odb, new HttpCatalogClient(product.url, INTERNAL), logger);
  const ord = await listen(orderApp({ db: odb, config: oCfg, logger, orders }));

  const gwCfg = loadGatewayConfig({
    ...base, JWT_ACCESS_SECRET: JWT, TRUST_PROXY_HOPS: "0", RATE_LIMIT_PER_MINUTE: "100000", AUTH_RATE_LIMIT_PER_15_MIN: "100000", SESSION_CACHE_SECONDS: "0",
    USER_SERVICE_URL: user.url, PRODUCT_SERVICE_URL: product.url, INVENTORY_SERVICE_URL: inv.url,
    ORDER_SERVICE_URL: ord.url, PAYMENT_SERVICE_URL: pay.url, NOTIFICATION_SERVICE_URL: notif.url
  });
  const realGateway = gatewayApp({ config: gwCfg, logger });
  // Test convenience only: the first time a validly signed token for an unknown account is seen, create that account
  // so scenarios can mint tokens for fresh ids. Accounts seen once are never recreated (deletion tests rely on that),
  // and forged tokens never reach this code because they fail signature verification.
  const provisioned = new Set<string>();
  const gateway: express.Express = express();
  gateway.use(async (req, _res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.header("authorization") ?? "")?.[1];
    const claims = token ? verifyAccessToken(token, JWT) : null;
    if (claims && !provisioned.has(claims.sub)) {
      provisioned.add(claims.sub);
      await udb.user.createMany({ data: [{ id: claims.sub, email: `${claims.sub}@test.local`, name: "Test User", passwordHash: "x", role: claims.role }], skipDuplicates: true });
    }
    next();
  });
  gateway.use(realGateway);

  bus.subscribe("inventory-service", inventoryTopics, inventoryHandlers(inventory));
  bus.subscribe("order-service", orderTopics, orderHandlers(orders));
  bus.subscribe("payment-service", paymentTopics, paymentHandlers(payments));
  bus.subscribe("notification-service", notificationTopics, notificationHandlers(notifications));

  const relays = [
    [idb, "inventory-service"], [odb, "order-service"], [ydb, "payment-service"]
  ].map(([db, name]) => new OutboxRelay({ db: db as typeof idb, publisher: bus, producer: name as string, logger, pollMs: 10 }));

  /** Runs every outbox relay until the whole system is quiet (no event left to publish anywhere). */
  async function settle(maxRounds = 50) {
    for (let i = 0; i < maxRounds; i++) {
      const counts = await Promise.all(relays.map((r) => r.tick()));
      if (counts.every((c) => c === 0)) return;
    }
    throw new Error("system did not settle");
  }

  const token = (id: string, role: "CUSTOMER" | "ADMIN" = "CUSTOMER") => `Bearer ${signAccessToken({ sub: id, role }, JWT, 900)}`;
  const signedWebhook = (body: unknown) => {
    const raw = JSON.stringify(body);
    return { raw, signature: signPayload(WEBHOOK_SECRET, raw, Math.floor(Date.now() / 1000)) };
  };

  async function reset() {
    bus.delivered = [];
    bus.duplicate = false;
    provisioned.clear();
    const wipe = async (db: unknown, tables: string[]) => {
      for (const t of tables) await (db as Record<string, { deleteMany(): Promise<unknown> }>)[t]!.deleteMany();
    };
    await wipe(odb, ["orderItem", "order", "cartItem", "cart", "outboxEvent", "processedEvent", "auditLog"]);
    await wipe(idb, ["reservationItem", "inventoryReservation", "inventory", "outboxEvent", "processedEvent"]);
    await wipe(ydb, ["payment", "webhookEvent", "outboxEvent", "processedEvent"]);
    await wipe(ndb, ["notification", "processedEvent"]);
    await wipe(pdb, ["product", "category"]);
    await wipe(udb, ["session", "user"]);
  }

  return {
    app: gateway, urls: { user: user.url, product: product.url, inventory: inv.url, order: ord.url, payment: pay.url, notification: notif.url }, bus, settle, token, signedWebhook, reset, orders, uuid: randomUUID,
    db: { user: udb, product: pdb, inventory: idb, order: odb, payment: ydb, notification: ndb },
    async stop() {
      for (const s of [user, product, inv, pay, notif, ord]) await new Promise((r) => s.server.close(r));
      await Promise.all([udb, pdb, idb, odb, ydb, ndb].map((d) => d.$disconnect()));
    }
  };
}
export type Platform = Awaited<ReturnType<typeof startPlatform>>;
