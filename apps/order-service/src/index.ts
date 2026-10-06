import { createLogger, onShutdown, startEventRuntime } from "@commerce/shared";
import { createApp } from "./app";
import { HttpCatalogClient } from "./catalog-client";
import { loadOrderConfig } from "./config";
import { buildHandlers, consumeTopics } from "./consumers";
import { createDb } from "./db";
import { OrderService } from "./order-service";

async function main() {
  const config = loadOrderConfig();
  const logger = createLogger("order-service", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const catalog = new HttpCatalogClient(config.PRODUCT_SERVICE_URL, config.INTERNAL_SERVICE_TOKEN);
  const orders = new OrderService(db, catalog, logger);
  const events = await startEventRuntime({
    service: "order-service",
    kafka: config,
    logger,
    outbox: db,
    db,
    consume: { topics: consumeTopics, handlers: buildHandlers(orders) }
  });

  const sweep = setInterval(() => {
    orders
      .expireStale(new Date(Date.now() - config.ORDER_TTL_MINUTES * 60_000))
      .then((n) => n > 0 && logger.info({ cancelled: n }, "cancelled stale orders"))
      .catch((err) => logger.error({ err }, "stale order sweep failed"));
  }, config.SWEEP_INTERVAL_SECONDS * 1000);

  const server = createApp({ db, config, logger, orders }).listen(config.PORT, () => logger.info({ port: config.PORT }, "order-service ready"));
  onShutdown(logger, [
    ["http", () => new Promise((resolve) => server.close(resolve))],
    ["sweeper", async () => clearInterval(sweep)],
    ["events", () => events.stop()],
    ["database", () => db.$disconnect()]
  ]);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
