# syntax=docker/dockerfile:1.7
# One Dockerfile for every backend service. Build from the repository root:
#   docker build -f infrastructure/docker/service.Dockerfile --build-arg SERVICE=order-service .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
ARG SERVICE
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo
COPY . .
# Prisma only reads this to generate types; no connection is made at build time.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm install --frozen-lockfile --filter "@commerce/${SERVICE}..." \
 && pnpm --filter @commerce/shared build \
 && pnpm --filter "@commerce/${SERVICE}" build \
 && pnpm --filter "@commerce/${SERVICE}" deploy --prod --legacy /out

FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node infrastructure/docker/entrypoint.sh /entrypoint.sh
USER node
ENTRYPOINT ["/sbin/tini", "--", "sh", "/entrypoint.sh"]
