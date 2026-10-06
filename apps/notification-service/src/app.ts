import express from "express";
import { z } from "zod";
import {
  currentUser, errorHandler, gatewayIdentity, healthRoutes, notFoundHandler, parse, requestContext, requireGateway, requireUser, type Logger
} from "@commerce/shared";
import type { Config } from "./config";
import type { Db } from "./db";
import type { NotificationService } from "./notification-service";

const listQuery = z.object({
  unreadOnly: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});
const idParam = z.object({ id: z.string().uuid() });

export function createApp(deps: { db: Db; config: Config; logger: Logger; notifications: NotificationService }): express.Express {
  const { db, config, logger, notifications } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(healthRoutes("notification-service", config.INTERNAL_SERVICE_TOKEN, { database: () => db.$queryRaw`SELECT 1` }));
  app.use(requireGateway(config.INTERNAL_SERVICE_TOKEN));
  app.use(express.json({ limit: "10kb" }));
  app.use(gatewayIdentity);

  app.get("/api/notifications", requireUser, async (req, res) => {
    res.json(await notifications.list(currentUser(req).id, parse(listQuery, req.query)));
  });
  app.post("/api/notifications/:id/read", requireUser, async (req, res) => {
    await notifications.markRead(currentUser(req).id, parse(idParam, req.params).id);
    res.status(204).end();
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
