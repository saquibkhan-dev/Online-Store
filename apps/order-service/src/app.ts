import express from "express";
import { z } from "zod";
import {
  currentUser,
  errorHandler,
  gatewayIdentity,
  healthRoutes,
  notFoundHandler,
  parse,
  requestContext,
  requireGateway,
  requireRole,
  requireUser,
  type Logger
} from "@commerce/shared";
import type { Config } from "./config";
import type { Db } from "./db";
import { MAX_QUANTITY, presentOrder, type OrderService } from "./order-service";

const itemParam = z.object({ itemId: z.string().uuid() });
const orderParam = z.object({ orderId: z.string().uuid() });
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, "Idempotency-Key must be 8-128 URL-safe characters");
const quantity = z.number().int().min(1).max(MAX_QUANTITY);
const addItemBody = z.object({ productId: z.string().uuid(), quantity: quantity.default(1) });
const quantityBody = z.object({ quantity });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(["PENDING", "PAYMENT_PENDING", "CONFIRMED", "CANCELLED"]).optional()
});

export function createApp(deps: { db: Db; config: Config; logger: Logger; orders: OrderService }): express.Express {
  const { db, config, logger, orders } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(healthRoutes("order-service", config.INTERNAL_SERVICE_TOKEN, { database: () => db.$queryRaw`SELECT 1` }));
  app.use(requireGateway(config.INTERNAL_SERVICE_TOKEN));
  app.use(express.json({ limit: "10kb" }));
  app.use(gatewayIdentity);

  const meta = (req: express.Request) => ({ requestId: req.ctx.requestId, correlationId: req.ctx.correlationId });

  // ---- cart
  app.get("/api/cart", requireUser, async (req, res) => void res.json(await orders.getCart(currentUser(req).id, meta(req))));
  app.post("/api/cart/items", requireUser, async (req, res) => {
    const body = parse(addItemBody, req.body);
    res.status(201).json(await orders.addItem(currentUser(req).id, body.productId, body.quantity, meta(req)));
  });
  app.patch("/api/cart/items/:itemId", requireUser, async (req, res) => {
    const { itemId } = parse(itemParam, req.params);
    res.json(await orders.setQuantity(currentUser(req).id, itemId, parse(quantityBody, req.body).quantity, meta(req)));
  });
  app.delete("/api/cart/items/:itemId", requireUser, async (req, res) => {
    await orders.removeItem(currentUser(req).id, parse(itemParam, req.params).itemId);
    res.status(204).end();
  });
  app.delete("/api/cart", requireUser, async (req, res) => {
    await orders.clearCart(currentUser(req).id);
    res.status(204).end();
  });

  // ---- checkout: starts a distributed workflow, so it answers 202 with the order to poll
  const checkout: express.RequestHandler = async (req, res) => {
    const key = parse(idempotencyKey, req.header("idempotency-key"));
    const { order, replay } = await orders.checkout(currentUser(req).id, key, meta(req));
    res.setHeader("Idempotent-Replay", String(replay));
    res.status(replay ? 200 : 202).json({ orderId: order.id, status: order.status, totalMinor: order.totalMinor, currency: order.currency });
  };
  app.post("/api/checkout", requireUser, checkout);
  app.post("/api/orders", requireUser, checkout);

  // ---- orders
  app.get("/api/orders", requireUser, async (req, res) => {
    const q = parse(pageQuery, req.query);
    res.json(await orders.listOrders({ userId: currentUser(req).id, status: q.status }, q.page, q.limit));
  });
  app.get("/api/orders/:orderId", requireUser, async (req, res) => {
    const { orderId } = parse(orderParam, req.params);
    res.json(presentOrder(await orders.getOrder(orderId, currentUser(req))));
  });
  app.post("/api/orders/:orderId/cancel", requireUser, async (req, res) => {
    const { orderId } = parse(orderParam, req.params);
    res.json(presentOrder(await orders.cancelByUser(orderId, currentUser(req))));
  });

  // ---- admin
  app.get("/api/admin/orders", requireRole("ADMIN"), async (req, res) => {
    const q = parse(pageQuery, req.query);
    res.json(await orders.listOrders({ status: q.status }, q.page, q.limit));
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
