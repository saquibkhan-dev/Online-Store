import { createLogger, onShutdown, startEventRuntime } from "@commerce/shared";
import { createApp } from "./app";
import { loadNotificationConfig } from "./config";
import { buildHandlers, consumeTopics } from "./consumers";
import { createDb } from "./db";
import { NotificationService } from "./notification-service";

async function main() {
  const config = loadNotificationConfig();
  const logger = createLogger("notification-service", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const notifications = new NotificationService(db);
  const events = await startEventRuntime({
    service: "notification-service",
    kafka: config,
    logger,
    db,
    consume: { topics: consumeTopics, handlers: buildHandlers(notifications) }
  });
  const server = createApp({ db, config, logger, notifications }).listen(config.PORT, () => logger.info({ port: config.PORT }, "notification-service ready"));
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
