import { describe, expect, it, vi } from "vitest";
import { PermanentError } from "../src/errors";
import { eventEnvelopeSchema, outboxRecord } from "../src/events";
import { loadConfig, baseEnv } from "../src/config";
import { createMessageProcessor, on, type RawMessage } from "../src/kafka";
import { createLogger } from "../src/logger";
import { lineTotalMinor, sumMinor } from "../src/money";
import { safeEqual } from "../src/http";

const logger = createLogger("test", "silent");
const orderId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function message(envelope: unknown): RawMessage {
  return { topic: "orders.events", partition: 0, offset: "7", key: orderId, value: JSON.stringify(envelope) };
}
const envelope = (over: Record<string, unknown> = {}) => ({
  eventId: "33333333-3333-4333-8333-333333333333",
  eventType: "OrderConfirmed",
  version: 1,
  timestamp: new Date().toISOString(),
  producer: "order-service",
  correlationId: "44444444-4444-4444-8444-444444444444",
  causationId: null,
  payload: { orderId, userId },
  ...over
});

describe("outboxRecord", () => {
  it("builds a valid outbox row", () => {
    const rec = outboxRecord("OrderConfirmed", { orderId, userId }, { aggregateId: orderId, correlationId: envelope().correlationId });
    expect(rec).toMatchObject({ eventType: "OrderConfirmed", version: 1, aggregateId: orderId, causationId: null });
    expect(eventEnvelopeSchema.safeParse({ ...rec, timestamp: new Date().toISOString(), producer: "x" }).success).toBe(true);
  });
  it("rejects a payload that violates the contract", () => {
    expect(() =>
      outboxRecord("OrderConfirmed", { orderId: "nope", userId } as never, { aggregateId: orderId, correlationId: envelope().correlationId })
    ).toThrow();
  });
});

describe("message processor", () => {
  const make = (fn: () => Promise<void>, maxAttempts = 3) => {
    const dlq = { sendRaw: vi.fn().mockResolvedValue(undefined) };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const run = createMessageProcessor({
      consumerName: "t",
      handlers: [on("OrderConfirmed", fn)],
      dlq,
      logger,
      maxAttempts,
      sleep
    });
    return { run, dlq, sleep };
  };

  it("processes a valid event", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { run, dlq } = make(fn);
    await run(message(envelope()));
    expect(fn).toHaveBeenCalledOnce();
    expect(dlq.sendRaw).not.toHaveBeenCalled();
  });
  it("retries transient failures then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const { run, dlq, sleep } = make(fn);
    await run(message(envelope()));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(dlq.sendRaw).not.toHaveBeenCalled();
  });
  it("dead-letters after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("db down"));
    const { run, dlq } = make(fn, 3);
    await run(message(envelope()));
    expect(fn).toHaveBeenCalledTimes(3);
    expect(dlq.sendRaw).toHaveBeenCalledWith("orders.events.dlq", orderId, expect.any(String), expect.objectContaining({ "x-error": "db down" }));
  });
  it("dead-letters permanent errors without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new PermanentError("bad"));
    const { run, dlq } = make(fn);
    await run(message(envelope()));
    expect(fn).toHaveBeenCalledOnce();
    expect(dlq.sendRaw).toHaveBeenCalledOnce();
  });
  it("dead-letters invalid envelopes, unsupported versions and invalid payloads", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { run, dlq } = make(fn);
    await run({ ...message({}), value: "not json" });
    await run(message(envelope({ version: 2 })));
    await run(message(envelope({ payload: { orderId: "x" } })));
    expect(fn).not.toHaveBeenCalled();
    expect(dlq.sendRaw).toHaveBeenCalledTimes(3);
  });
  it("ignores event types it has no handler for", async () => {
    const fn = vi.fn();
    const { run, dlq } = make(fn);
    await run(message(envelope({ eventType: "SomethingElse" })));
    expect(fn).not.toHaveBeenCalled();
    expect(dlq.sendRaw).not.toHaveBeenCalled();
  });
});

describe("config", () => {
  const env = { INTERNAL_SERVICE_TOKEN: "x".repeat(40), NODE_ENV: "production" };
  it("accepts strong secrets", () => {
    expect(loadConfig(baseEnv, env).NODE_ENV).toBe("production");
  });
  it("rejects short secrets", () => {
    expect(() => loadConfig(baseEnv, { ...env, INTERNAL_SERVICE_TOKEN: "short" })).toThrow(/32 characters/);
  });
  it("rejects placeholder secrets in production only", () => {
    const placeholder = { ...env, INTERNAL_SERVICE_TOKEN: "replace-with-32-plus-random-chars-xx" };
    expect(() => loadConfig(baseEnv, placeholder)).toThrow(/placeholder/);
    expect(loadConfig(baseEnv, { ...placeholder, NODE_ENV: "development" }).NODE_ENV).toBe("development");
  });
});

describe("helpers", () => {
  it("compares secrets in constant time regardless of length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("does integer money maths and detects overflow", () => {
    expect(sumMinor([lineTotalMinor(1999, 3), 1])).toBe(5998);
    expect(() => lineTotalMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });
});
