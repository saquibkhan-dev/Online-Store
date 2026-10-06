import { Redis } from "ioredis";
import type { Logger } from "@commerce/shared";

/**
 * Connects before the app is built, because the rate-limit store loads a Lua script as soon as it is created.
 * If Redis is unreachable at boot, returns undefined and the gateway falls back to per-instance in-memory limits
 * rather than refusing to start: an outage of the limiter must not become an outage of the shop.
 */
export async function connectRedis(url: string, logger: Logger, timeoutMs = 5000): Promise<Redis | undefined> {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000)
  });
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis error; rate limiting fails open"));
  try {
    await Promise.race([
      redis.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref())
    ]);
    return redis;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "redis unavailable at startup; using in-memory rate limits");
    redis.disconnect();
    return undefined;
  }
}
