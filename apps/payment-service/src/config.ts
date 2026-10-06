import { baseEnv, dbEnv, kafkaEnv, loadConfig, secret } from "@commerce/shared";
import { z } from "zod";

const schema = baseEnv.merge(dbEnv).merge(kafkaEnv).extend({
  PORT: z.coerce.number().int().positive().default(4005),
  PAYMENT_WEBHOOK_SECRET: secret,
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300)
});

export type Config = z.infer<typeof schema>;
export const loadPaymentConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
