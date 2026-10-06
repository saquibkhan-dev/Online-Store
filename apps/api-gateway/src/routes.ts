export type Service = "user" | "product" | "inventory" | "order" | "payment" | "notification";
export type Access = "public" | "user" | "admin";

export interface Rule {
  methods: readonly string[];
  /** Matches the path with no trailing slash. */
  pattern: RegExp;
  service: Service;
  access: Access;
  /** Shared caches (nginx/CDN) may store this response for a short time. Only for data identical for every caller. */
  cache?: boolean;
}

const READ = ["GET", "HEAD"] as const;
const WRITE = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * The gateway's whole public surface. Anything not listed here is a 404, so a new internal endpoint is never
 * exposed by accident, and /internal/* can never be reached from outside.
 */
export const rules: readonly Rule[] = [
  // auth
  { methods: ["POST"], pattern: /^\/api\/auth\/(register|login|refresh|logout)$/, service: "user", access: "public" },
  { methods: READ, pattern: /^\/api\/auth\/me$/, service: "user", access: "user" },
  // catalogue
  { methods: READ, pattern: /^\/api\/(products|categories)(\/[0-9a-f-]{36})?$/i, service: "product", access: "public", cache: true },
  { methods: WRITE, pattern: /^\/api\/(products|categories)(\/[0-9a-f-]{36})?$/i, service: "product", access: "admin" },
  // cart, checkout, orders
  { methods: [...READ, ...WRITE], pattern: /^\/api\/cart(\/items(\/[0-9a-f-]{36})?)?$/i, service: "order", access: "user" },
  { methods: ["POST"], pattern: /^\/api\/(checkout|orders)$/, service: "order", access: "user" },
  { methods: READ, pattern: /^\/api\/orders(\/[0-9a-f-]{36})?$/i, service: "order", access: "user" },
  { methods: ["POST"], pattern: /^\/api\/orders\/[0-9a-f-]{36}\/cancel$/i, service: "order", access: "user" },
  // payments: authenticated by HMAC signature in the payment service, not by a user token
  { methods: ["POST"], pattern: /^\/api\/payments\/webhook$/, service: "payment", access: "public" },
  // notifications
  { methods: READ, pattern: /^\/api\/notifications$/, service: "notification", access: "user" },
  { methods: ["POST"], pattern: /^\/api\/notifications\/[0-9a-f-]{36}\/read$/i, service: "notification", access: "user" },
  // admin
  { methods: READ, pattern: /^\/api\/admin\/users$/, service: "user", access: "admin" },
  { methods: READ, pattern: /^\/api\/admin\/orders$/, service: "order", access: "admin" },
  { methods: READ, pattern: /^\/api\/admin\/inventory$/, service: "inventory", access: "admin" },
  { methods: ["PUT"], pattern: /^\/api\/admin\/inventory\/[0-9a-f-]{36}$/i, service: "inventory", access: "admin" }
];

export function findRule(method: string, path: string): Rule | undefined {
  const normalised = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return rules.find((r) => r.methods.includes(method) && r.pattern.test(normalised));
}
