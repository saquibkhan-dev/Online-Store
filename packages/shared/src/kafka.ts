import { CompressionTypes, Kafka, logLevel, type Producer } from "kafkajs";
import { ZodError } from "zod";
import { PermanentError } from "./errors";
import {
  dlqTopic,
  eventContracts,
  eventEnvelopeSchema,
  type EventEnvelope,
  type EventPayload,
  type EventType
} from "./events";
import type { Logger } from "./logger";
import { eventsConsumed } from "./metrics";

export function createKafka(clientId: string, brokers: string[], logger: Logger): Kafka {
  return new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 8 },
    logCreator: () => ({ level, log }) => {
      const { message, ...extra } = log as { message: string } & Record<string, unknown>;
      const fn = level === logLevel.ERROR ? "error" : "warn";
      logger[fn]({ kafka: extra }, `kafka: ${message}`);
    }
  });
}

/** Creates topics (and their DLQs) explicitly; broker-side auto-creation is disabled in every environment. */
export async function ensureTopics(kafka: Kafka, topics: string[], partitions: number, replicationFactor: number) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        ...topics.map((topic) => ({ topic, numPartitions: partitions, replicationFactor })),
        ...topics.map((topic) => ({ topic: dlqTopic(topic), numPartitions: 1, replicationFactor }))
      ]
    });
  } finally {
    await admin.disconnect();
  }
}

export interface Publisher {
  publish(topic: string, key: string, envelope: EventEnvelope): Promise<void>;
}

export class KafkaPublisher implements Publisher {
  private readonly producer: Producer;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
  }

  connect() {
    return this.producer.connect();
  }

  disconnect() {
    return this.producer.disconnect();
  }

  async publish(topic: string, key: string, envelope: EventEnvelope): Promise<void> {
    await this.sendRaw(topic, key, JSON.stringify(envelope), {
      eventType: envelope.eventType,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      version: String(envelope.version)
    });
  }

  async sendRaw(topic: string, key: string | null, value: string, headers: Record<string, string> = {}) {
    await this.producer.send({
      topic,
      acks: -1,
      compression: CompressionTypes.GZIP,
      messages: [{ key, value, headers }]
    });
  }
}

export interface Handler {
  eventType: EventType;
  run(envelope: EventEnvelope, log: Logger): Promise<void>;
}

/**
 * Binds a typed handler to an event contract. Unsupported versions and invalid payloads are permanent failures
 * (they go to the DLQ); any other thrown error is treated as transient and retried.
 */
export function on<T extends EventType>(
  type: T,
  fn: (payload: EventPayload<T>, envelope: EventEnvelope, log: Logger) => Promise<void>
): Handler {
  const contract = eventContracts[type];
  return {
    eventType: type,
    async run(envelope, log) {
      if (envelope.version !== contract.version) {
        throw new PermanentError(`Unsupported version ${envelope.version} for ${type}`);
      }
      const payload = contract.schema.parse(envelope.payload) as EventPayload<T>;
      await fn(payload, envelope, log);
    }
  };
}

export interface DeadLetterSink {
  sendRaw(topic: string, key: string | null, value: string, headers?: Record<string, string>): Promise<void>;
}

export interface ProcessorOptions {
  consumerName: string;
  handlers: Handler[];
  dlq: DeadLetterSink;
  logger: Logger;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RawMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
}

/** The consume pipeline, separated from kafkajs so retry/DLQ behaviour is unit-testable. */
export function createMessageProcessor(opts: ProcessorOptions) {
  const byType = new Map(opts.handlers.map((h) => [h.eventType as string, h]));
  const maxAttempts = opts.maxAttempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadLetter = async (msg: RawMessage, reason: string, eventType = "unknown") => {
    await opts.dlq.sendRaw(dlqTopic(msg.topic), msg.key, msg.value ?? "", {
      "x-error": reason.slice(0, 500),
      "x-consumer": opts.consumerName,
      "x-source-partition": String(msg.partition),
      "x-source-offset": msg.offset
    });
    eventsConsumed.inc({ consumer: opts.consumerName, event_type: eventType, outcome: "dead_lettered" });
    opts.logger.error({ topic: msg.topic, offset: msg.offset, reason, eventType }, "event moved to DLQ");
  };

  return async (msg: RawMessage): Promise<void> => {
    let envelope: EventEnvelope;
    try {
      envelope = eventEnvelopeSchema.parse(JSON.parse(msg.value ?? ""));
    } catch {
      return deadLetter(msg, "invalid envelope");
    }
    const handler = byType.get(envelope.eventType);
    if (!handler) {
      eventsConsumed.inc({ consumer: opts.consumerName, event_type: envelope.eventType, outcome: "ignored" });
      return; // another consumer's event on a shared topic
    }
    const log = opts.logger.child({
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      correlationId: envelope.correlationId
    });
    for (let attempt = 1; ; attempt++) {
      try {
        await handler.run(envelope, log);
        eventsConsumed.inc({ consumer: opts.consumerName, event_type: envelope.eventType, outcome: "processed" });
        return;
      } catch (err) {
        const permanent = err instanceof PermanentError || err instanceof ZodError;
        const reason = err instanceof Error ? err.message : String(err);
        if (permanent || attempt >= maxAttempts) return deadLetter(msg, reason, envelope.eventType);
        log.warn({ err, attempt }, "event handler failed, retrying");
        await sleep(Math.min(250 * 2 ** (attempt - 1), 5000));
      }
    }
  };
}

export interface RunningConsumer {
  stop(): Promise<void>;
}

export async function startConsumer(opts: {
  kafka: Kafka;
  groupId: string;
  topics: string[];
  handlers: Handler[];
  dlq: DeadLetterSink;
  logger: Logger;
}): Promise<RunningConsumer> {
  const consumer = opts.kafka.consumer({ groupId: opts.groupId, sessionTimeout: 30_000, allowAutoTopicCreation: false });
  const process = createMessageProcessor({
    consumerName: opts.groupId,
    handlers: opts.handlers,
    dlq: opts.dlq,
    logger: opts.logger
  });
  await consumer.connect();
  for (const topic of opts.topics) await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) =>
      process({
        topic,
        partition,
        offset: message.offset,
        key: message.key?.toString() ?? null,
        value: message.value?.toString() ?? null
      })
  });
  // kafkajs retries retriable failures itself; a crash it will not restart from means this process is useless,
  // so exit and let the orchestrator replace it rather than sit idle while events pile up.
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    opts.logger.fatal({ err: payload.error, restart: payload.restart }, "kafka consumer crashed");
    if (!payload.restart) globalThis.process.exit(1);
  });
  return { stop: () => consumer.disconnect() };
}
