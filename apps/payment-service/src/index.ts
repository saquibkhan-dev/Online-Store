import { createLogger, onShutdown, startEventRuntime } from "@commerce/shared";
import { createApp } from "./app";
import { loadPaymentConfig } from "./config";
import { buildHandlers, consumeTopics } from "./consumers";
import { createDb } from "./db";
import { PaymentService } from "./payment-service";

async function main() {
  const config = loadPaymentConfig();
  const logger = createLogger("payment-service", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const payments = new PaymentService(db, logger);
  const events = await startEventRuntime({
    service: "payment-service",
    kafka: config,
    logger,
    outbox: db,
    db,
    consume: { topics: consumeTopics, handlers: buildHandlers(payments) }
  });
  const server = createApp({ db, config, logger, payments }).listen(config.PORT, () => logger.info({ port: config.PORT }, "payment-service ready"));
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
