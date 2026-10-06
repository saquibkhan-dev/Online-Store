import express from "express";
import { z } from "zod";
import {
  currentUser,
  errorHandler,
  gatewayIdentity,
  healthRoutes,
  notFoundHandler,
  parse,
  requestContext,
  requireGateway,
  requireRole,
  requireUser,
  text,
  passwordBytesOk,
  type Logger
} from "@commerce/shared";
import { AuthService } from "./auth-service";
import type { Config } from "./config";
import type { Db } from "./db";

// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this check
const email = z.string().trim().max(254).email().refine((e) => !/[\u0000-\u001F]/.test(e), "invalid email");
const registerBody = z.object({
  email,
  password: z.string().min(10, "must be at least 10 characters").max(128).refine(passwordBytesOk, "must be at most 72 bytes"),
  name: text(2, 80)
});
const loginBody = z.object({ email, password: z.string().min(1).max(128) });
const userIdParam = z.object({ id: z.string().uuid() });
const tokenBody = z.object({ refreshToken: z.string().min(20).max(200) });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export function createApp(deps: { db: Db; config: Config; logger: Logger; auth?: AuthService }): express.Express {
  const { db, config, logger } = deps;
  const auth = deps.auth ?? new AuthService(db, config);
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(healthRoutes("user-service", config.INTERNAL_SERVICE_TOKEN, { database: () => db.$queryRaw`SELECT 1` }));
  app.use(requireGateway(config.INTERNAL_SERVICE_TOKEN));
  app.use(express.json({ limit: "50kb" }));
  app.use(gatewayIdentity);

  app.post("/api/auth/register", async (req, res) => {
    res.status(201).json(await auth.register(parse(registerBody, req.body)));
  });
  app.post("/api/auth/login", async (req, res) => {
    res.json(await auth.login(parse(loginBody, req.body)));
  });
  app.post("/api/auth/refresh", async (req, res) => {
    res.json(await auth.refresh(parse(tokenBody, req.body).refreshToken));
  });
  app.post("/api/auth/logout", async (req, res) => {
    await auth.logout(parse(tokenBody, req.body).refreshToken);
    res.status(204).end();
  });
  app.get("/api/auth/me", requireUser, async (req, res) => {
    res.json(await auth.me(currentUser(req).id));
  });
  // Internal: the gateway re-checks every session against the live account (deleted user, changed role).
  app.get("/internal/users/:id/access", async (req, res) => {
    const access = await auth.access(parse(userIdParam, req.params).id);
    if (!access) return void res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found" } });
    res.json(access);
  });
  app.get("/api/admin/users", requireRole("ADMIN"), async (req, res) => {
    const { page, limit } = parse(pageQuery, req.query);
    res.json(await auth.listUsers(page, limit));
  });

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
