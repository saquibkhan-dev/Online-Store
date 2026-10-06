import { createLogger, onShutdown } from "@commerce/shared";
import { createApp } from "./app";
import { loadGatewayConfig } from "./config";
import { connectRedis } from "./redis";

async function main() {
  const config = loadGatewayConfig();
  const logger = createLogger("api-gateway", config.LOG_LEVEL);
  const redis = config.REDIS_URL ? await connectRedis(config.REDIS_URL, logger) : undefined;
  const server = createApp({ config, logger, redis }).listen(config.PORT, () => logger.info({ port: config.PORT }, "api-gateway ready"));
  // Slow-loris protection and keep-alive longer than nginx's upstream idle timeout.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  onShutdown(logger, [
    ["http", () => new Promise((resolve) => server.close(resolve))],
    ["redis", async () => void redis?.disconnect()]
  ]);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
