import { createLogger, onShutdown } from "@commerce/shared";
import { createApp } from "./app";
import { AuthService } from "./auth-service";
import { loadUserConfig } from "./config";
import { createDb } from "./db";

async function main() {
  const config = loadUserConfig();
  const logger = createLogger("user-service", config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const auth = new AuthService(db, config);
  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD && (await auth.ensureAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD))) {
    logger.info("bootstrap admin account created");
  }
  const prune = setInterval(() => {
    auth.pruneSessions().then((n) => n > 0 && logger.info({ pruned: n }, "pruned expired sessions")).catch((err) => logger.error({ err }, "session pruning failed"));
  }, 3_600_000);
  prune.unref();
  const server = createApp({ db, config, logger, auth }).listen(config.PORT, () => logger.info({ port: config.PORT }, "user-service ready"));
  onShutdown(logger, [
    ["http", () => new Promise((resolve) => server.close(resolve))],
    ["database", () => db.$disconnect()]
  ]);
}

main().catch((err) => {
  // Logger may not exist yet if configuration failed.
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
