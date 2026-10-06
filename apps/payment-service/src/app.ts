import express from "express";
import { AppError, errorHandler, Errors, healthRoutes, notFoundHandler, requestContext, requireGateway, type Logger } from "@commerce/shared";
import type { Config } from "./config";
import type { Db } from "./db";
import { webhookSchema, type PaymentService } from "./payment-service";
import { verifySignature } from "./signature";

export function createApp(deps: { db: Db; config: Config; logger: Logger; payments: PaymentService }): express.Express {
  const { db, config, logger, payments } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(healthRoutes("payment-service", config.INTERNAL_SERVICE_TOKEN, { database: () => db.$queryRaw`SELECT 1` }));
  app.use(requireGateway(config.INTERNAL_SERVICE_TOKEN));

  // The signature covers the exact bytes the provider sent, so this route reads the raw body and parses it itself.
  app.post("/api/payments/webhook", express.raw({ type: () => true, limit: "100kb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const verdict = verifySignature(config.PAYMENT_WEBHOOK_SECRET, raw, req.header("x-signature"), config.WEBHOOK_TOLERANCE_SECONDS);
    if (verdict !== "ok") {
      req.ctx.log.warn({ verdict }, "rejected payment webhook");
      throw new AppError(401, "INVALID_SIGNATURE", "Invalid webhook signature");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      throw Errors.badRequest("INVALID_JSON", "Malformed JSON body");
    }
    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const outcome = await payments.handleWebhook(parsed.data);
    res.json({ received: true, outcome });
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
