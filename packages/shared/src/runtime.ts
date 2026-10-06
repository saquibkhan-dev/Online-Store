import { kafkaEnv } from "./config";
import type { z } from "zod";
import { createKafka, ensureTopics, KafkaPublisher, startConsumer, type Handler, type RunningConsumer } from "./kafka";
import type { Logger } from "./logger";
import { OutboxRelay, registerOutboxGauges, startRetention, type SqlExecutor } from "./outbox";
import { Topics } from "./events";

export type KafkaConfig = z.infer<typeof kafkaEnv>;

export interface EventRuntime {
  stop(): Promise<void>;
  /** Drains one outbox batch immediately (tests, manual operations). */
  relay?: OutboxRelay;
}

/**
 * Boots the event plumbing every service shares: topics, producer (events + DLQ), outbox relay and consumer.
 * Shutdown order is consumer -> relay -> producer so in-flight work finishes before connections close.
 */
export async function startEventRuntime(opts: {
  service: string;
  kafka: KafkaConfig;
  logger: Logger;
  consume?: { topics: string[]; handlers: Handler[] };
  outbox?: SqlExecutor;
  /** The service's own database, used to prune OutboxEvent/ProcessedEvent. */
  db?: SqlExecutor;
}): Promise<EventRuntime> {
  const { service, logger } = opts;
  const kafka = createKafka(service, opts.kafka.KAFKA_BROKERS, logger);
  await ensureTopics(kafka, Object.values(Topics), opts.kafka.KAFKA_TOPIC_PARTITIONS, opts.kafka.KAFKA_REPLICATION_FACTOR);
  const publisher = new KafkaPublisher(kafka);
  await publisher.connect();

  let relay: OutboxRelay | undefined;
  if (opts.outbox) {
    relay = new OutboxRelay({ db: opts.outbox, publisher, producer: service, logger });
    registerOutboxGauges(opts.outbox, service);
    relay.start();
  }
  let consumer: RunningConsumer | undefined;
  if (opts.consume) {
    consumer = await startConsumer({
      kafka,
      groupId: service,
      topics: opts.consume.topics,
      handlers: opts.consume.handlers,
      dlq: publisher,
      logger
    });
  }
  const stopRetention = opts.db ? startRetention(opts.db, logger, { outbox: Boolean(opts.outbox), processed: Boolean(opts.consume) }) : undefined;
  return {
    relay,
    async stop() {
      stopRetention?.();
      await consumer?.stop();
      await relay?.stop();
      await publisher.disconnect();
    }
  };
}
