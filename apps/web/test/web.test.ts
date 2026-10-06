import { describe, expect, it } from "vitest";
import { isAllowedBffPath, isSameOrigin } from "../lib/csrf";
import { formatMoney, isTerminal } from "../lib/format";
import { safeNext } from "../components/auth-form";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("money", () => {
  it("formats minor units without float drift", () => {
    expect(formatMoney(199900)).toBe("₹1,999.00");
    expect(formatMoney(1)).toBe("₹0.01");
  });
});

describe("csrf", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("accepts same-origin and rejects cross-site or header-less requests", () => {
    expect(isSameOrigin(h({ host: "shop.test", origin: "https://shop.test" }))).toBe(true);
    expect(isSameOrigin(h({ host: "shop.test", referer: "https://shop.test/cart" }))).toBe(true);
    expect(isSameOrigin(h({ "x-forwarded-host": "shop.test", host: "web:3000", origin: "https://shop.test" }))).toBe(true);
    expect(isSameOrigin(h({ host: "shop.test", origin: "https://evil.test" }))).toBe(false);
    expect(isSameOrigin(h({ host: "shop.test", origin: "https://shop.test.evil.test" }))).toBe(false);
    expect(isSameOrigin(h({ host: "shop.test" }))).toBe(false);
    expect(isSameOrigin(h({ host: "shop.test", origin: "not a url" }))).toBe(false);
  });
});

describe("bff allow-list", () => {
  it("allows storefront endpoints only", () => {
    for (const p of ["api/products", `api/products/${uuid}`, "api/cart", `api/cart/items/${uuid}`, "api/checkout", `api/orders/${uuid}/cancel`, "api/notifications"]) expect(isAllowedBffPath(p)).toBe(true);
    for (const p of ["api/auth/login", "api/payments/webhook", "api/admin/orders", "internal/products/batch", "api/../internal", `api/orders/${uuid}/../x`, "api/products/abc/def"]) expect(isAllowedBffPath(p)).toBe(false);
  });
});

describe("redirects and status", () => {
  it("refuses open redirects", () => {
    expect(safeNext("/cart")).toBe("/cart");
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("https://evil.test")).toBe("/");
    expect(safeNext("/\\evil.test")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
  it("knows terminal order states", () => {
    expect(isTerminal("CONFIRMED") && isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("PAYMENT_PENDING")).toBe(false);
  });
});

import { clientIp, forwardedFor } from "../lib/client-ip";
import { validate } from "../components/auth-form";

describe("visitor IP forwarding (so the gateway rate-limits people, not the web container)", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("uses the entry our own proxy wrote and rejects non-IPs", () => {
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9"); // spoofed prefix ignored
    expect(clientIp(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(h({ "x-forwarded-for": "not-an-ip" }))).toBeUndefined();
    expect(clientIp(h({}))).toBeUndefined();
    expect(forwardedFor(h({}))).toEqual({});
    expect(forwardedFor(h({ "x-real-ip": "198.51.100.7" }))).toEqual({ "x-forwarded-for": "198.51.100.7" });
  });
});

describe("form validation", () => {
  it("gives specific field messages for registration", () => {
    expect(validate("register", { name: "A", email: "nope", password: "short" })).toEqual({
      name: expect.stringContaining("name"), email: expect.stringContaining("valid email"), password: expect.stringContaining("10 characters")
    });
    expect(validate("register", { name: "Ada Lovelace", email: "ada@example.com", password: "correct horse battery" })).toEqual({});
  });
  it("enforces the 72-byte password limit using bytes, not characters", () => {
    expect(validate("register", { name: "Ada", email: "ada@example.com", password: "é".repeat(40) }).password).toContain("72");
  });
  it("only requires a password on login", () => {
    expect(validate("login", { name: "", email: "ada@example.com", password: "x" })).toEqual({});
    expect(validate("login", { name: "", email: "ada@example.com", password: "" }).password).toBeDefined();
  });
});
