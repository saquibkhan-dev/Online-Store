import { createLogger, onShutdown } from "@commerce/shared";
import { createApp } from "./app";
import { loadProductConfig } from "./config";
import { createDb } from "./db";

async function main() {
  const config = loadProductConfig();
  const logger = createLogger("product-service", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const server = createApp({ db, config, logger }).listen(config.PORT, () => logger.info({ port: config.PORT }, "product-service ready"));
  onShutdown(logger, [
    ["http", () => new Promise((resolve) => server.close(resolve))],
    ["database", () => db.$disconnect()]
  ]);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
