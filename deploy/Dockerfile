# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @bursar/web build && pnpm --filter @bursar/server build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@bursar/server..."

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BURSAR_HOST=0.0.0.0 \
    BURSAR_PORT=8080 \
    BURSAR_DATA_DIR=/data \
    BURSAR_MIGRATIONS_DIR=/app/apps/server/drizzle \
    BURSAR_WEB_DIST=/app/apps/web/dist
WORKDIR /app/apps/server
COPY --from=prod-deps /src/node_modules /app/node_modules
COPY --from=prod-deps /src/apps/server/node_modules /app/apps/server/node_modules
COPY --from=build /src/apps/server/package.json /app/apps/server/package.json
COPY --from=build /src/apps/server/dist /app/apps/server/dist
COPY --from=build /src/apps/server/drizzle /app/apps/server/drizzle
COPY --from=build /src/apps/web/dist /app/apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
