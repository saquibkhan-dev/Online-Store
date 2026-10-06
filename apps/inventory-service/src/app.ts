import express from "express";
import { z } from "zod";
import {
  errorHandler,
  gatewayIdentity,
  healthRoutes,
  notFoundHandler,
  parse,
  requestContext,
  requireGateway,
  requireRole,
  type Logger
} from "@commerce/shared";
import type { Config } from "./config";
import type { Db } from "./db";
import type { InventoryService } from "./inventory-service";

const stockBody = z.object({ quantity: z.number().int().min(0).max(1_000_000) });
const productParam = z.object({ productId: z.string().uuid() });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export function createApp(deps: { db: Db; config: Config; logger: Logger; inventory: InventoryService }): express.Express {
  const { db, config, logger, inventory } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(healthRoutes("inventory-service", config.INTERNAL_SERVICE_TOKEN, { database: () => db.$queryRaw`SELECT 1` }));
  app.use(requireGateway(config.INTERNAL_SERVICE_TOKEN));
  app.use(express.json({ limit: "10kb" }));
  app.use(gatewayIdentity);

  app.get("/api/admin/inventory", requireRole("ADMIN"), async (req, res) => {
    const { page, limit } = parse(pageQuery, req.query);
    res.json(await inventory.listStock(page, limit));
  });
  app.put("/api/admin/inventory/:productId", requireRole("ADMIN"), async (req, res) => {
    const { productId } = parse(productParam, req.params);
    res.json(await inventory.setStock(productId, parse(stockBody, req.body).quantity));
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
