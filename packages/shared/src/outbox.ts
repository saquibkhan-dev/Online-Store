import client from "prom-client";
import { PermanentError } from "./errors";
import { eventEnvelopeSchema, topicFor, type EventEnvelope } from "./events";
import type { Publisher } from "./kafka";
import type { Logger } from "./logger";
import { outboxPublished, registry } from "./metrics";

/** The subset of PrismaClient the relay needs; every service's OutboxEvent table has the same shape. */
export interface SqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface OutboxRow {
  id: string;
  eventId: string;
  eventType: string;
  aggregateId: string;
  version: number;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  retryCount: number;
  createdAt: Date;
}

// Lease-based claim: rows are locked for `lease` seconds so several relay instances never publish the same row,
// and a crashed relay's rows become claimable again once the lease expires.
const CLAIM_SQL = `
UPDATE "OutboxEvent" o
SET "lockedUntil" = now() + make_interval(secs => $2::float8), "lastAttemptAt" = now()
WHERE o."id" IN (
  SELECT "id" FROM "OutboxEvent"
  WHERE "status" = 'PENDING' AND "nextAttemptAt" <= now()
    AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
  ORDER BY "createdAt" ASC
  LIMIT $1::int
  FOR UPDATE SKIP LOCKED
)
RETURNING o."id", o."eventId", o."eventType", o."aggregateId", o."version", o."correlationId",
          o."causationId", o."payload", o."retryCount", o."createdAt"`;

export interface RelayOptions {
  db: SqlExecutor;
  publisher: Publisher;
  producer: string;
  logger: Logger;
  batchSize?: number;
  pollMs?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;

  constructor(private readonly opts: RelayOptions) {
    this.batchSize = opts.batchSize ?? 50;
    this.pollMs = opts.pollMs ?? 500;
    this.leaseSeconds = opts.leaseSeconds ?? 30;
    this.maxAttempts = opts.maxAttempts ?? 12;
  }

  start(): void {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.inFlight = this.tick()
        .then((published) => published >= this.batchSize)
        .catch((err) => {
          this.opts.logger.error({ err }, "outbox relay tick failed");
          return false;
        })
        .then((more) => {
          if (!this.stopped) this.timer = setTimeout(loop, more ? 0 : this.pollMs);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  /** Publishes one batch; returns how many rows were claimed. Exposed for tests and manual draining. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await this.opts.db.$queryRawUnsafe<OutboxRow[]>(CLAIM_SQL, this.batchSize, this.leaseSeconds);
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const row of rows) await this.publishRow(row);
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  private async publishRow(row: OutboxRow): Promise<void> {
    const { db, logger } = this.opts;
    try {
      const envelope: EventEnvelope = eventEnvelopeSchema.parse({
        eventId: row.eventId,
        eventType: row.eventType,
        version: row.version,
        timestamp: row.createdAt.toISOString(),
        producer: this.opts.producer,
        correlationId: row.correlationId,
        causationId: row.causationId,
        payload: row.payload
      });
      await this.opts.publisher.publish(topicFor(row.eventType), row.aggregateId, envelope);
      await db.$executeRawUnsafe(
        `UPDATE "OutboxEvent" SET "status" = 'PUBLISHED', "publishedAt" = now(), "lockedUntil" = NULL WHERE "id" = $1`,
        row.id
      );
      outboxPublished.inc({ event_type: row.eventType, outcome: "published" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A row that can never be built (unknown type, invalid envelope) is parked immediately.
      const permanent = err instanceof PermanentError || (err instanceof Error && err.name === "ZodError") || message.startsWith("Unknown event type");
      const backoffSeconds = Math.min(2 ** row.retryCount, 60);
      await db.$executeRawUnsafe(
        `UPDATE "OutboxEvent"
         SET "retryCount" = "retryCount" + 1, "lastError" = $2, "lockedUntil" = NULL,
             "nextAttemptAt" = now() + make_interval(secs => $3::float8),
             "status" = CASE WHEN $5::boolean OR "retryCount" + 1 >= $4::int THEN 'FAILED' ELSE 'PENDING' END
         WHERE "id" = $1`,
        row.id,
        message.slice(0, 500),
        backoffSeconds,
        this.maxAttempts,
        permanent
      );
      outboxPublished.inc({ event_type: row.eventType, outcome: "failed" });
      logger.error({ err, eventId: row.eventId, eventType: row.eventType }, "outbox publish failed");
    }
  }
}

/** Exposes backlog size as scrape-time gauges so alerts can fire on stuck or dead events. */
export function registerOutboxGauges(db: SqlExecutor, service: string): void {
  const gauge = (status: "PENDING" | "FAILED", name: string, help: string) =>
    new client.Gauge({
      name,
      help,
      labelNames: ["service"],
      registers: [registry],
      async collect() {
        const rows = await db.$queryRawUnsafe<Array<{ c: number }>>(
          `SELECT count(*)::int AS c FROM "OutboxEvent" WHERE "status" = '${status}'`
        );
        this.set({ service }, rows[0]?.c ?? 0);
      }
    });
  gauge("PENDING", "outbox_pending_events", "Events waiting to be published");
  gauge("FAILED", "outbox_failed_events", "Events that exhausted retries and need attention");
}

export interface RetentionOptions {
  outbox: boolean;
  processed: boolean;
  /** Published outbox rows are kept this long for debugging. */
  outboxDays?: number;
  /**
   * Dedupe rows must outlive Kafka's retention (7 days by default); otherwise a replayed old event could be
   * processed twice. Keep this comfortably larger than the topic retention.
   */
  processedDays?: number;
  batch?: number;
}

/** Deletes old bookkeeping rows in bounded batches so the tables do not grow forever. */
export async function pruneEventTables(db: SqlExecutor, opts: RetentionOptions): Promise<{ outbox: number; processed: number }> {
  const batch = opts.batch ?? 5000;
  let outbox = 0;
  let processed = 0;
  if (opts.outbox) {
    outbox = await db.$executeRawUnsafe(
      `DELETE FROM "OutboxEvent" WHERE "id" IN (
         SELECT "id" FROM "OutboxEvent"
         WHERE "status" = 'PUBLISHED' AND "publishedAt" < now() - make_interval(days => $1::int) LIMIT $2::int)`,
      opts.outboxDays ?? 7,
      batch
    );
  }
  if (opts.processed) {
    processed = await db.$executeRawUnsafe(
      `DELETE FROM "ProcessedEvent" WHERE ("eventId", "consumerName") IN (
         SELECT "eventId", "consumerName" FROM "ProcessedEvent"
         WHERE "processedAt" < now() - make_interval(days => $1::int) LIMIT $2::int)`,
      opts.processedDays ?? 30,
      batch
    );
  }
  return { outbox, processed };
}

export function startRetention(db: SqlExecutor, logger: Logger, opts: RetentionOptions, everyMs = 3_600_000): () => void {
  const run = () =>
    pruneEventTables(db, opts)
      .then((n) => (n.outbox || n.processed) && logger.info(n, "pruned event tables"))
      .catch((err) => logger.error({ err }, "event table pruning failed"));
  const timer = setInterval(() => void run(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
