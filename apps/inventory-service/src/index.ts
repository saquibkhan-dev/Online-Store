import { createLogger, onShutdown, startEventRuntime } from "@commerce/shared";
import { createApp } from "./app";
import { loadInventoryConfig } from "./config";
import { buildHandlers, consumeTopics } from "./consumers";
import { createDb } from "./db";
import { InventoryService } from "./inventory-service";

async function main() {
  const config = loadInventoryConfig();
  const logger = createLogger("inventory-service", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const inventory = new InventoryService(db, { reservationTtlMinutes: config.RESERVATION_TTL_MINUTES, logger });
  const events = await startEventRuntime({
    service: "inventory-service",
    kafka: config,
    logger,
    outbox: db,
    db,
    consume: { topics: consumeTopics, handlers: buildHandlers(inventory) }
  });
  const server = createApp({ db, config, logger, inventory }).listen(config.PORT, () => logger.info({ port: config.PORT }, "inventory-service ready"));
  onShutdown(logger, [
    ["http", () => new Promise((resolve) => server.close(resolve))],
    ["events", () => events.stop()],
    ["database", () => db.$disconnect()]
  ]);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
