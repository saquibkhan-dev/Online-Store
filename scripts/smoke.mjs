#!/usr/bin/env node
// End-to-end smoke test against a RUNNING stack (docker compose). Exercises the real path including Kafka:
// register -> admin creates product + stock -> cart -> checkout -> (reserve) -> signed payment webhook -> CONFIRMED.
//
//   BASE_URL=http://localhost:8080 ADMIN_EMAIL=... ADMIN_PASSWORD=... PAYMENT_WEBHOOK_SECRET=... node scripts/smoke.mjs
import { createHmac, randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const need = (k) => process.env[k] ?? (console.error(`missing ${k}`), process.exit(2));
const ADMIN_EMAIL = need("ADMIN_EMAIL");
const ADMIN_PASSWORD = need("ADMIN_PASSWORD");
const SECRET = need("PAYMENT_WEBHOOK_SECRET");

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const ok = (res, expected, what) => {
  if (res.status !== expected) throw new Error(`${what}: expected ${expected}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
async function until(what, fn, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const step = (m) => console.log(`✓ ${m}`);

const admin = ok(await call("POST", "/api/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }), 200, "admin login");
step("admin signed in");
const email = `smoke-${randomUUID().slice(0, 8)}@example.com`;
const user = ok(await call("POST", "/api/auth/register", { body: { email, password: "smoke-test-password", name: "Smoke Test" } }), 201, "register");
step("customer registered");

const product = ok(await call("POST", "/api/products", { token: admin.accessToken, body: { name: "Smoke Lamp", slug: `smoke-lamp-${randomUUID().slice(0, 6)}`, priceMinor: 2500 } }), 201, "create product");
ok(await call("PUT", `/api/admin/inventory/${product.id}`, { token: admin.accessToken, body: { quantity: 3 } }), 200, "set stock");
step("product + stock created");

ok(await call("POST", "/api/cart/items", { token: user.accessToken, body: { productId: product.id, quantity: 2 } }), 201, "add to cart");
const { orderId } = ok(await call("POST", "/api/checkout", { token: user.accessToken, headers: { "idempotency-key": `smoke-${randomUUID()}` } }), 202, "checkout");
step(`order ${orderId} placed`);

await until("order PAYMENT_PENDING (inventory reserved via Kafka)", async () => (await call("GET", `/api/orders/${orderId}`, { token: user.accessToken })).body?.status === "PAYMENT_PENDING");
step("stock reserved, awaiting payment");

const raw = JSON.stringify({ id: `evt_smoke_${orderId}`, type: "payment.succeeded", data: { orderId, reference: "smoke", amountMinor: 5000, currency: "INR" } });
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", SECRET).update(`${t}.`).update(raw).digest("hex");
// The payment record is created from a Kafka event, so the provider webhook may briefly get 409 and must be retried.
await until("webhook accepted", async () => (await call("POST", "/api/payments/webhook", { body: raw, headers: { "x-signature": `t=${t},v1=${v1}` } })).status === 200, 20_000);
step("signed webhook accepted");

await until("order CONFIRMED", async () => (await call("GET", `/api/orders/${orderId}`, { token: user.accessToken })).body?.status === "CONFIRMED");
step("order confirmed");
const stock = ok(await call("GET", "/api/admin/inventory?limit=100", { token: admin.accessToken }), 200, "inventory").items.find((i) => i.productId === product.id);
if (stock.quantity !== 1 || stock.reservedQuantity !== 0) throw new Error(`stock wrong: ${JSON.stringify(stock)}`);
step("stock decremented (3 -> 1)");
await until("confirmation notification", async () => (await call("GET", "/api/notifications", { token: user.accessToken })).body?.items?.some((n) => n.type === "ORDER_CONFIRMED"));
step("customer notified");
console.log("\nSMOKE TEST PASSED");
