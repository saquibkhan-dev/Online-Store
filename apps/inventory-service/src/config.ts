import { baseEnv, dbEnv, kafkaEnv, loadConfig } from "@commerce/shared";
import { z } from "zod";

const schema = baseEnv.merge(dbEnv).merge(kafkaEnv).extend({
  PORT: z.coerce.number().int().positive().default(4003),
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().default(60)
});

export type Config = z.infer<typeof schema>;
export const loadInventoryConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
