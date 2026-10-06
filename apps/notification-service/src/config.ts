import { baseEnv, dbEnv, kafkaEnv, loadConfig } from "@commerce/shared";
import { z } from "zod";

const schema = baseEnv.merge(dbEnv).merge(kafkaEnv).extend({ PORT: z.coerce.number().int().positive().default(4006) });

export type Config = z.infer<typeof schema>;
export const loadNotificationConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
