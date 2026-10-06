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
  text,
  type Logger
} from "@commerce/shared";
import { CatalogService } from "./catalog-service";
import type { Config } from "./config";
import type { Db } from "./db";

const slug = z.string().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens only");
const productBody = z.object({
  name: text(2, 200),
  slug,
  description: text(0, 5000, { multiline: true }).default(""),
  priceMinor: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().length(3).toUpperCase().default("INR"),
  categoryId: z.string().uuid().nullable().optional()
});
const productPatch = productBody.partial().strict().refine((v) => Object.keys(v).length > 0, "at least one field is required");
const categoryBody = z.object({ name: text(2, 100), slug });
const categoryPatch = categoryBody.partial().strict().refine((v) => Object.keys(v).length > 0, "at least one field is required");
const id = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  search: text(0, 100).optional(),
  category: slug.optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "name"]).default("newest"),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});
const batchQuery = z.object({
  ids: z.string().transform((v) => v.split(",")).pipe(z.array(z.string().uuid()).min(1).max(100))
});

export function createApp(deps: { db: Db; config: Config; logger: Logger }): express.Express {
  const { db, config, logger } = deps;
  const catalog = new CatalogService(db);
  const admin = requireRole("ADMIN");
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(healthRoutes("product-service", config.INTERNAL_SERVICE_TOKEN, { database: () => db.$queryRaw`SELECT 1` }));
  app.use(requireGateway(config.INTERNAL_SERVICE_TOKEN));
  app.use(express.json({ limit: "100kb" }));
  app.use(gatewayIdentity);

  app.get("/api/products", async (req, res) => void res.json(await catalog.listProducts(parse(listQuery, req.query))));
  app.get("/api/products/:id", async (req, res) => void res.json(await catalog.getProduct(parse(id, req.params).id)));
  app.post("/api/products", admin, async (req, res) => void res.status(201).json(await catalog.createProduct(parse(productBody, req.body))));
  app.patch("/api/products/:id", admin, async (req, res) => {
    res.json(await catalog.updateProduct(parse(id, req.params).id, parse(productPatch, req.body)));
  });
  app.delete("/api/products/:id", admin, async (req, res) => {
    await catalog.deleteProduct(parse(id, req.params).id);
    res.status(204).end();
  });

  app.get("/api/categories", async (_req, res) => void res.json({ items: await catalog.listCategories() }));
  app.post("/api/categories", admin, async (req, res) => void res.status(201).json(await catalog.createCategory(parse(categoryBody, req.body))));
  app.patch("/api/categories/:id", admin, async (req, res) => {
    res.json(await catalog.updateCategory(parse(id, req.params).id, parse(categoryPatch, req.body)));
  });
  app.delete("/api/categories/:id", admin, async (req, res) => {
    await catalog.deleteCategory(parse(id, req.params).id);
    res.status(204).end();
  });

  // Internal: service-to-service price lookup. The gateway never routes /internal/*.
  app.get("/internal/products/batch", async (req, res) => {
    res.json({ items: await catalog.batch(parse(batchQuery, req.query).ids) });
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
