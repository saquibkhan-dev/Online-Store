import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";
import { z } from "zod";
import type { Role } from "./auth";
import { roleSchema } from "./auth";
import { AppError, Errors } from "./errors";
import type { Logger } from "./logger";
import { httpDuration, registry } from "./metrics";

export interface RequestContext {
  requestId: string;
  correlationId: string;
  log: Logger;
  user?: { id: string; role: Role };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's documented augmentation point
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUIET_PATHS = new Set(["/health", "/ready", "/metrics"]);
const uuidOr = (value: string | undefined) => (value && UUID.test(value) ? value : randomUUID());

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Assigns request/correlation IDs, logs one line per request and records latency metrics. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = uuidOr(req.header("x-request-id"));
    const correlationId = uuidOr(req.header("x-correlation-id"));
    req.ctx = { requestId, correlationId, log: logger.child({ requestId, correlationId }) };
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-correlation-id", correlationId);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Gateways dispatch from middleware, so they can name the route themselves via res.locals.route.
      const route = (res.locals.route as string | undefined) ?? (`${req.baseUrl}${req.route?.path ?? ""}` || "unmatched");
      httpDuration.observe({ method: req.method, route, status: res.statusCode }, seconds);
      const level = QUIET_PATHS.has(req.path) ? "debug" : "info";
      req.ctx.log[level]({ method: req.method, route, status: res.statusCode, durationMs: Math.round(seconds * 1000) }, "request");
    });
    next();
  };
}

/** Rejects any request that did not come through the gateway (shared internal token). */
export function requireGateway(token: string): RequestHandler {
  return (req, _res, next) => {
    const given = req.header("x-internal-auth");
    if (!given || !safeEqual(given, token)) return next(Errors.forbidden("Direct access is not allowed"));
    next();
  };
}

/** Reads the identity the gateway verified. Only call after requireGateway. */
export const gatewayIdentity: RequestHandler = (req, _res, next) => {
  const id = req.header("x-user-id");
  const role = roleSchema.safeParse(req.header("x-user-role"));
  if (id && UUID.test(id) && role.success) req.ctx.user = { id, role: role.data };
  next();
};

export const requireUser: RequestHandler = (req, _res, next) =>
  req.ctx.user ? next() : next(Errors.unauthorized());

export const requireRole =
  (role: Role): RequestHandler =>
  (req, _res, next) => {
    if (!req.ctx.user) return next(Errors.unauthorized());
    if (req.ctx.user.role !== role) return next(Errors.forbidden());
    next();
  };

/** The authenticated user. Throws if called on a route without requireUser. */
export function currentUser(req: express.Request): { id: string; role: Role } {
  if (!req.ctx.user) throw Errors.unauthorized();
  return req.ctx.user;
}

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.validation(result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(Errors.notFound("Route"));

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const log = req.ctx?.log ?? logger;
    const requestId = req.ctx?.requestId;
    const body = (code: string, message: string, details?: unknown) => ({ error: { code, message, requestId, details } });
    if (err instanceof AppError) {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (err.status === 429 && retry) res.setHeader("retry-after", String(retry));
      return void res.status(err.status).json(body(err.code, err.message, err.details));
    }
    const type = (err as { type?: string }).type;
    if (type === "entity.too.large") return void res.status(413).json(body("PAYLOAD_TOO_LARGE", "Request body too large"));
    if (type === "entity.parse.failed") return void res.status(400).json(body("INVALID_JSON", "Malformed JSON body"));
    // Hostile input that slips past validation (e.g. a NUL byte Postgres refuses to store) is the client's fault.
    if (err instanceof Error && /invalid byte sequence|null character|\\u0000|0x00/i.test(err.message)) {
      return void res.status(400).json(body("VALIDATION_ERROR", "Request contains invalid characters"));
    }
    log.error({ err }, "unhandled error");
    res.status(500).json(body("INTERNAL_ERROR", "Something went wrong"));
  };
}

export type ReadinessChecks = Record<string, () => Promise<unknown>>;

/**
 * /health is public (liveness, reveals nothing). /ready returns only a status code unless the caller presents the
 * internal token, and /metrics requires it: both would otherwise leak topology and traffic data.
 */
export function healthRoutes(service: string, internalToken: string, checks: ReadinessChecks = {}): Router {
  const router = express.Router();
  const trusted = (req: express.Request) => {
    const given = req.header("x-internal-auth");
    return Boolean(given) && safeEqual(given as string, internalToken);
  };
  router.get("/health", (_req, res) => void res.json({ status: "ok", service }));
  router.get("/ready", async (req, res) => {
    const results = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000).unref())
          ]);
          return [name, true] as const;
        } catch {
          return [name, false] as const;
        }
      })
    );
    const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
    const status = failed.length ? "unavailable" : "ready";
    res.status(failed.length ? 503 : 200).json(trusted(req) ? { status, service, failed } : { status });
  });
  router.get("/metrics", async (req, res) => {
    if (!trusted(req)) return void res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
    res.setHeader("content-type", registry.contentType);
    res.send(await registry.metrics());
  });
  return router;
}
