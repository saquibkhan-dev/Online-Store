import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry]
});

export const eventsConsumed = new client.Counter({
  name: "events_consumed_total",
  help: "Consumed events by outcome",
  labelNames: ["consumer", "event_type", "outcome"],
  registers: [registry]
});

export const outboxPublished = new client.Counter({
  name: "outbox_published_total",
  help: "Outbox events published to Kafka",
  labelNames: ["event_type", "outcome"],
  registers: [registry]
});
