import { z } from "zod";

export const secret = z.string().min(32, "must be at least 32 characters");

export const baseEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  INTERNAL_SERVICE_TOKEN: secret
});

export const dbEnv = z.object({
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10)
});

export const kafkaEnv = z.object({
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().positive().default(3),
  KAFKA_REPLICATION_FACTOR: z.coerce.number().int().positive().default(1)
});

const PLACEHOLDER = /replace-with|change-?me|local-webhook|example|password123/i;

/** Parses configuration and refuses to boot a production process with placeholder secrets. */
export function loadConfig<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data as Record<string, unknown>;
  if (cfg.NODE_ENV === "production") {
    for (const [key, value] of Object.entries(cfg)) {
      if (/SECRET|TOKEN|PASSWORD/.test(key) && typeof value === "string" && PLACEHOLDER.test(value)) {
        throw new Error(`Invalid configuration: ${key} still contains a placeholder value`);
      }
    }
  }
  return parsed.data;
}
