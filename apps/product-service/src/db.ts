import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export type Db = PrismaClient;

/**
 * Pooled connection with bounded waits: a stuck query is cancelled by the server after `statement_timeout`, idle
 * connections are recycled, and callers fail fast (instead of queueing forever) when the pool is exhausted.
 */
export function createDb(connectionString: string, max: number): Db {
  const statementTimeout = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15_000);
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: statementTimeout,
      idle_in_transaction_session_timeout: 30_000
    })
  });
}
