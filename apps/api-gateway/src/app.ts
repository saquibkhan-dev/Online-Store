import cors from "cors";
import express, { type RequestHandler } from "express";
import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import helmet from "helmet";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { Redis } from "ioredis";
import { RedisStore } from "rate-limit-redis";
import {
  AppError,
  errorHandler,
  Errors,
  healthRoutes,
  notFoundHandler,
  requestContext,
  verifyAccessToken,
  type Logger
} from "@commerce/shared";
import type { Config } from "./config";
import { findRule, type Service } from "./routes";
import { SessionVerifier } from "./session";

const IDENTITY_HEADERS = ["x-user-id", "x-user-role", "x-internal-auth"];
const MAX_DECLARED_BODY_BYTES = 1_000_000;

function bearer(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}

export function createApp(deps: { config: Config; logger: Logger; redis?: Redis }): express.Express {
  const { config, logger, redis } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(requestContext(logger));
  // API responses are private by default; only routes flagged `cache` in routes.ts opt in (see proxyRes below).
  app.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });
  app.use(
    healthRoutes("api-gateway", config.INTERNAL_SERVICE_TOKEN, redis ? { redis: () => redis.ping() } : {})
  );

  if (config.CORS_ORIGINS.length > 0) {
    app.use(cors({ origin: config.CORS_ORIGINS, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"], exposedHeaders: ["x-request-id", "idempotent-replay"], maxAge: 600 }));
  }

  // Shared counters when Redis is configured; per-process counters otherwise. Both fail open if the store errors,
  // because an outage of the limiter must not become an outage of the shop.
  const store = (prefix: string): Store | undefined =>
    redis ? new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as never }) : undefined;
  const limiter = (prefix: string, limit: number, windowMs: number, keyByUser = false) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      passOnStoreError: true,
      store: store(prefix),
      keyGenerator: (req) => (keyByUser && req.ctx?.user ? `u:${req.ctx.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`),
      validate: { xForwardedForHeader: false, trustProxy: false },
      handler: (req, res) => {
        res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests, slow down", requestId: req.ctx.requestId } });
      }
    });
  app.use(limiter("global", config.RATE_LIMIT_PER_MINUTE, 60_000));
  app.use("/api/auth", limiter("auth", config.AUTH_RATE_LIMIT_PER_15_MIN, 15 * 60_000));

  const proxies = Object.fromEntries(
    (
      [
        ["user", config.USER_SERVICE_URL],
        ["product", config.PRODUCT_SERVICE_URL],
        ["inventory", config.INVENTORY_SERVICE_URL],
        ["order", config.ORDER_SERVICE_URL],
        ["payment", config.PAYMENT_SERVICE_URL],
        ["notification", config.NOTIFICATION_SERVICE_URL]
      ] as Array<[Service, string]>
    ).map(([service, target]) => [
      service,
      createProxyMiddleware({
        target,
        changeOrigin: false,
        proxyTimeout: config.UPSTREAM_TIMEOUT_MS,
        timeout: config.UPSTREAM_TIMEOUT_MS,
        on: {
          proxyReq: (proxyReq, req) => {
            const r = req as express.Request;
            // Drop anything the client could use to impersonate a user or the gateway, then set our own.
            for (const h of IDENTITY_HEADERS) proxyReq.removeHeader(h);
            proxyReq.removeHeader("authorization");
            proxyReq.setHeader("x-internal-auth", config.INTERNAL_SERVICE_TOKEN);
            proxyReq.setHeader("x-request-id", r.ctx.requestId);
            proxyReq.setHeader("x-correlation-id", r.ctx.correlationId);
            if (r.ctx.user) {
              proxyReq.setHeader("x-user-id", r.ctx.user.id);
              proxyReq.setHeader("x-user-role", r.ctx.user.role);
            }
          },
          proxyRes: (proxyRes, _req, res) => {
            const r = res as express.Response;
            if (r.locals.cacheable && proxyRes.statusCode === 200) {
              // The cache key is the URL alone, so this must never be set on anything user-specific.
              proxyRes.headers["cache-control"] = "public, max-age=15, stale-while-revalidate=60";
            } else {
              proxyRes.headers["cache-control"] = "no-store";
            }
          },
          error: (err, req, res) => {
            const r = req as express.Request;
            const timedOut = (err as NodeJS.ErrnoException).code === "ECONNRESET" || /timeout/i.test(err.message);
            r.ctx.log.error({ err, service: target }, "upstream error");
            if ("headersSent" in res && !res.headersSent && "status" in res) {
              (res as express.Response).status(timedOut ? 504 : 502).json({
                error: { code: timedOut ? "UPSTREAM_TIMEOUT" : "BAD_GATEWAY", message: "The service is temporarily unavailable", requestId: r.ctx.requestId }
              });
            }
          }
        }
      })
    ])
  ) as unknown as Record<Service, RequestHandler>;

  const authenticate: RequestHandler = (req, _res, next) => {
    const token = bearer(req.header("authorization"));
    if (token) {
      const claims = verifyAccessToken(token, config.JWT_ACCESS_SECRET);
      if (claims) req.ctx.user = { id: claims.sub, role: claims.role };
      else if (req.header("authorization")) return next(new AppError(401, "INVALID_TOKEN", "Invalid or expired access token"));
    } else if (req.header("authorization")) {
      return next(new AppError(401, "INVALID_TOKEN", "Invalid or expired access token"));
    }
    next();
  };

  app.use(authenticate);
  app.use(limiter("user", 120, 60_000, true));
  // Abuse-prone endpoints get their own, tighter budgets (in addition to the global and per-user limits).
  app.post("/api/auth/register", limiter("register", 10, 60 * 60_000));
  app.post(["/api/checkout", "/api/orders"], limiter("checkout", 10, 60_000, true));
  app.post("/api/payments/webhook", limiter("webhook", 600, 60_000));

  const sessions = new SessionVerifier(config.USER_SERVICE_URL, config.INTERNAL_SERVICE_TOKEN, logger, config.SESSION_CACHE_SECONDS);

  app.use(async (req, res, next) => {
    const rule = findRule(req.method, req.path);
    if (!rule) return next(Errors.notFound("Route"));
    res.locals.route = `/${rule.service}`; // low-cardinality label for logs and metrics
    if (rule.access !== "public" && !req.ctx.user) return next(Errors.unauthorized());
    if (rule.access !== "public" && req.ctx.user) {
      const live = await sessions.lookup(req.ctx.user.id, req.ctx);
      if (live === null) return next(new AppError(401, "INVALID_TOKEN", "Invalid or expired access token"));
      if (live === "unavailable") {
        // Fail closed for admin routes; for customers carry on with the least privilege the token could grant.
        if (rule.access === "admin") return next(Errors.unavailable());
        req.ctx.user.role = "CUSTOMER";
      } else {
        req.ctx.user.role = live.role; // the live role wins over whatever the token claims
      }
    }
    if (rule.access === "admin" && req.ctx.user?.role !== "ADMIN") return next(Errors.forbidden());
    res.locals.cacheable = Boolean(rule.cache);
    const declared = Number(req.header("content-length") ?? 0);
    if (declared > MAX_DECLARED_BODY_BYTES) return next(new AppError(413, "PAYLOAD_TOO_LARGE", "Request body too large"));
    return proxies[rule.service](req, res, next);
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
