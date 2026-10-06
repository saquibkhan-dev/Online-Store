import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OutboxRelay, outboxRecord, type EventEnvelope, type Publisher } from "@commerce/shared";
import { db, logger, resetDb } from "./helpers";
import { enqueue } from "../src/outbox";

beforeAll(() => db.$connect());
afterAll(() => db.$disconnect());
beforeEach(resetDb);

class FakePublisher implements Publisher {
  published: Array<{ topic: string; key: string; envelope: EventEnvelope }> = [];
  failWith: Error | null = null;
  async publish(topic: string, key: string, envelope: EventEnvelope) {
    if (this.failWith) throw this.failWith;
    this.published.push({ topic, key, envelope });
  }
}

async function seed(n: number) {
  for (let i = 0; i < n; i++) {
    const orderId = randomUUID();
    await db.$transaction((tx) =>
      enqueue(tx, outboxRecord("OrderConfirmed", { orderId, userId: randomUUID() }, { aggregateId: orderId, correlationId: randomUUID() }))
    );
  }
}
const relay = (publisher: Publisher, extra: Partial<ConstructorParameters<typeof OutboxRelay>[0]> = {}) =>
  new OutboxRelay({ db, publisher, producer: "inventory-service", logger, ...extra });

describe("outbox relay", () => {
  it("publishes pending events in order with a full envelope and marks them PUBLISHED", async () => {
    await seed(3);
    const pub = new FakePublisher();
    expect(await relay(pub).tick()).toBe(3);
    expect(pub.published).toHaveLength(3);
    expect(pub.published[0]).toMatchObject({ topic: "orders.events" });
    expect(pub.published[0]?.envelope).toMatchObject({ eventType: "OrderConfirmed", version: 1, producer: "inventory-service", causationId: null });
    expect(pub.published[0]?.key).toBe(pub.published[0]?.envelope.payload.orderId);
    expect(await db.outboxEvent.count({ where: { status: "PUBLISHED" } })).toBe(3);
    expect(await relay(pub).tick()).toBe(0);
  });

  it("backs off and retries when Kafka is unavailable, then recovers without losing the event", async () => {
    await seed(1);
    const pub = new FakePublisher();
    pub.failWith = new Error("broker down");
    await relay(pub).tick();
    const failed = await db.outboxEvent.findFirstOrThrow();
    expect(failed).toMatchObject({ status: "PENDING", retryCount: 1, lastError: "broker down", lockedUntil: null });
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await relay(pub).tick()).toBe(0); // still backing off
    await db.outboxEvent.updateMany({ data: { nextAttemptAt: new Date() } });
    pub.failWith = null;
    await relay(pub).tick();
    expect(pub.published).toHaveLength(1);
    expect((await db.outboxEvent.findFirstOrThrow()).status).toBe("PUBLISHED");
  });

  it("parks an event as FAILED after max attempts, and immediately when it can never be built", async () => {
    await seed(1);
    const pub = new FakePublisher();
    pub.failWith = new Error("broker down");
    await relay(pub, { maxAttempts: 1 }).tick();
    expect((await db.outboxEvent.findFirstOrThrow()).status).toBe("FAILED");

    await resetDb();
    await db.outboxEvent.create({
      data: { eventId: randomUUID(), eventType: "NotARealEvent", aggregateId: randomUUID(), correlationId: randomUUID(), payload: {} }
    });
    await relay(new FakePublisher()).tick();
    expect((await db.outboxEvent.findFirstOrThrow()).status).toBe("FAILED");
  });

  it("publishes each row exactly once when several relays run concurrently", async () => {
    await seed(60);
    const pub = new FakePublisher();
    const relays = Array.from({ length: 4 }, () => relay(pub, { batchSize: 10 }));
    await Promise.all(relays.map(async (r) => { for (let i = 0; i < 8; i++) await r.tick(); }));
    const ids = pub.published.map((p) => p.envelope.eventId);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  it("re-claims events whose lease expired after a relay crash", async () => {
    await seed(1);
    await db.outboxEvent.updateMany({ data: { lockedUntil: new Date(Date.now() + 60_000) } });
    const pub = new FakePublisher();
    expect(await relay(pub).tick()).toBe(0);
    await db.outboxEvent.updateMany({ data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await relay(pub).tick()).toBe(1);
  });
});

describe("retention", () => {
  it("prunes old published outbox rows and old dedupe rows but keeps recent and unpublished ones", async () => {
    const { pruneEventTables } = await import("@commerce/shared");
    await seed(3);
    await relay(new FakePublisher()).tick(); // all three published
    const [a, b] = await db.outboxEvent.findMany({ orderBy: { createdAt: "asc" } });
    await db.outboxEvent.update({ where: { id: a!.id }, data: { publishedAt: new Date(Date.now() - 10 * 86_400_000) } });
    await db.outboxEvent.update({ where: { id: b!.id }, data: { status: "PENDING", publishedAt: new Date(Date.now() - 10 * 86_400_000) } }); // unpublished must survive
    await db.processedEvent.createMany({
      data: [
        { eventId: randomUUID(), consumerName: "x", processedAt: new Date(Date.now() - 40 * 86_400_000) },
        { eventId: randomUUID(), consumerName: "x", processedAt: new Date() }
      ]
    });
    expect(await pruneEventTables(db, { outbox: true, processed: true })).toEqual({ outbox: 1, processed: 1 });
    expect(await db.outboxEvent.count()).toBe(2);
    expect(await db.processedEvent.count()).toBe(1);
  });
});
