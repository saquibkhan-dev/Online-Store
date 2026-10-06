import { baseEnv, loadConfig, secret } from "@commerce/shared";
import { z } from "zod";

const url = z.string().url();
const schema = baseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_ACCESS_SECRET: secret,
  USER_SERVICE_URL: url,
  PRODUCT_SERVICE_URL: url,
  INVENTORY_SERVICE_URL: url,
  ORDER_SERVICE_URL: url,
  PAYMENT_SERVICE_URL: url,
  NOTIFICATION_SERVICE_URL: url,
  REDIS_URL: z.string().url().optional(),
  /** Comma separated browser origins allowed to call the API directly. Empty = same-origin only. */
  CORS_ORIGINS: z.string().default("").transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  /** Number of reverse proxies in front of the gateway (nginx = 1), so client IPs are not spoofable. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_PER_15_MIN: z.coerce.number().int().positive().default(30),
  /** How long a verified session/role is cached. 0 disables caching (every request re-checks). */
  SESSION_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(15),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000)
});

export type Config = z.infer<typeof schema>;
export const loadGatewayConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
