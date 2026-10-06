import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@commerce/shared";
import { createApp } from "../src/app";
import { loadGatewayConfig } from "../src/config";
import { connectRedis } from "../src/redis";

// Runs only when a Redis is available (CI provides one): REDIS_TEST_URL=redis://localhost:6379
const url = process.env.REDIS_TEST_URL;
const upstream = http.createServer((_req, res) => void res.end("{}"));
let redis: Redis;
let base = "";

beforeAll(async () => {
  if (!url) return;
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const connected = await connectRedis(url, createLogger("test", "silent"));
  if (!connected) throw new Error("test redis unreachable");
  redis = connected;
  await redis.flushdb();
});
afterAll(async () => {
  if (!url) return;
  await new Promise((r) => upstream.close(r));
  redis.disconnect();
});

const config = (extra: Record<string, string> = {}) =>
  loadGatewayConfig({
    NODE_ENV: "test", INTERNAL_SERVICE_TOKEN: "i".repeat(40), JWT_ACCESS_SECRET: "j".repeat(40), TRUST_PROXY_HOPS: "0",
    USER_SERVICE_URL: base, PRODUCT_SERVICE_URL: base, INVENTORY_SERVICE_URL: base, ORDER_SERVICE_URL: base, PAYMENT_SERVICE_URL: base, NOTIFICATION_SERVICE_URL: base,
    RATE_LIMIT_PER_MINUTE: "5", ...extra
  });

describe.skipIf(!url)("redis-backed rate limiting", () => {
  it("shares counters between gateway instances", async () => {
    const logger = createLogger("test", "silent");
    const a = createApp({ config: config(), logger, redis });
    const b = createApp({ config: config(), logger, redis });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await request(i % 2 ? a : b).get("/api/products")).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429); // the 6th request hit the OTHER instance but the shared limit applied
    expect(await redis.keys("rl:*")).not.toHaveLength(0);
  });

  it("starts without Redis (in-memory limits) when it is unreachable at boot", async () => {
    expect(await connectRedis("redis://127.0.0.1:1", createLogger("test", "silent"), 800)).toBeUndefined();
  });

  it("fails open when Redis goes away after startup instead of taking the shop down", async () => {
    const logger = createLogger("test", "silent");
    const victim = await connectRedis(url as string, logger);
    if (!victim) throw new Error("test redis unreachable");
    const app = createApp({ config: config({ RATE_LIMIT_PER_MINUTE: "1" }), logger, redis: victim });
    await request(app).get("/ready").expect(200);
    victim.disconnect(); // simulate the connection dying under a running gateway
    for (let i = 0; i < 4; i++) await request(app).get("/api/products").expect(200); // limiter store errors are passed through
    expect((await request(app).get("/ready")).status).toBe(503); // readiness reports it, traffic still flows
  });
});
