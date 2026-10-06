# Event-driven e-commerce platform

Next.js storefront + API gateway + six Node/Express/Prisma services (user, product, inventory, order, payment,
notification) coordinated by Kafka using the transactional-outbox and idempotent-consumer patterns.


## Run it
```sh
cp .env.example .env          # fill secrets: openssl rand -hex 32
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
# open http://localhost:8080 ; place an order, then use the sandbox "Simulate payment" button
```

## Develop
```sh
pnpm install
sh scripts/test-db.sh         # needs a local Postgres (PGHOST/PGUSER/PGPASSWORD, default postgres/postgres@localhost)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
REDIS_TEST_URL=redis://localhost:6379 pnpm test   # also runs the Redis rate-limit tests
```
Each service: `apps/<svc>/src` (`app.ts` HTTP, `*-service.ts` rules, `consumers.ts` events), `prisma/` schema + SQL migrations.
Shared contracts, outbox relay, consumer framework: `packages/shared`. Cross-service tests: `tests/saga`.

## Layout
`apps/*` services and web · `packages/shared` · `tests/saga` · `infrastructure/` Dockerfiles, nginx, Postgres init · `docs/`
