import { baseEnv, dbEnv, loadConfig } from "@commerce/shared";
import { z } from "zod";

const schema = baseEnv.merge(dbEnv).extend({ PORT: z.coerce.number().int().positive().default(4002) });

export type Config = z.infer<typeof schema>;
export const loadProductConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
