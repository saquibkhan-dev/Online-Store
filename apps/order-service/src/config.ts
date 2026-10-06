import { baseEnv, dbEnv, kafkaEnv, loadConfig } from "@commerce/shared";
import { z } from "zod";

const schema = baseEnv.merge(dbEnv).merge(kafkaEnv).extend({
  PORT: z.coerce.number().int().positive().default(4004),
  PRODUCT_SERVICE_URL: z.string().url(),
  ORDER_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60)
});

export type Config = z.infer<typeof schema>;
export const loadOrderConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
