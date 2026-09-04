# syntax=docker/dockerfile:1

# deepseek-harness-gateway — thin runtime shell.
#
# Default: the entrypoint clones/pulls DSH_GATEWAY_GIT_REPO (defaults to this
# project's repo below) into DSH_GATEWAY_SRC_DIR, installs deps, builds and runs —
# the container is a git checkout, so the portal's "设置 → 更新" hot-update works.
#
# Baked fallback: set DSH_GATEWAY_GIT_REPO="" (empty) to run the source bundled
# into the image instead — no .git, so hot-update is disabled (git: false).

# ---- builder: install deps + build the baked source (produces Linux node_modules + dist) ----
FROM node:22-bookworm-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.7.0
WORKDIR /app/source
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -r build

# ---- runtime: baked source + entrypoint; git/pnpm/build toolchain kept for hot-update mode ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.7.0

WORKDIR /app
COPY --from=builder /app/source /app/source
COPY docker/entrypoint.sh /usr/local/bin/gateway-entrypoint.sh
RUN chmod +x /usr/local/bin/gateway-entrypoint.sh && mkdir -p /data

# DSH_GATEWAY_HOST must be 0.0.0.0 so the port is reachable from outside the container.
ENV DSH_GATEWAY_SRC_DIR=/app/source \
    DSH_GATEWAY_GIT_REPO=https://github.com/januory/deepseek-harness-gateway.git \
    DSH_GATEWAY_GIT_REF=main \
    DSH_GATEWAY_HOST=0.0.0.0 \
    DSH_GATEWAY_PORT=3300 \
    DSH_GATEWAY_DB_PATH=/data/gateway.db \
    DSH_GATEWAY_BUILD_CMD="pnpm -r build" \
    NODE_ENV=production

EXPOSE 3300
VOLUME ["/data"]

ENTRYPOINT ["gateway-entrypoint.sh"]
