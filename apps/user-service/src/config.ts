import { baseEnv, dbEnv, loadConfig, secret } from "@commerce/shared";
import { z } from "zod";

const schema = baseEnv.merge(dbEnv).extend({
  PORT: z.coerce.number().int().positive().default(4001),
  JWT_ACCESS_SECRET: secret,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional()
});

export type Config = z.infer<typeof schema>;
export const loadUserConfig = (env?: NodeJS.ProcessEnv): Config => loadConfig(schema, env);
