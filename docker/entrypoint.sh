#!/usr/bin/env sh
set -eu

# deepseek-harness-gateway container entrypoint.
#
# Hot-update depends on whether the source directory is a git checkout:
#   - DSH_GATEWAY_SRC_DIR has .git → a git checkout (e.g. a mounted repo); install,
#     build and run with hot-update enabled.
#   - otherwise → run the source bundled into the image (no .git); hot-update
#     disabled.

SRC_DIR="${DSH_GATEWAY_SRC_DIR:-/app/source}"

if [ -d "$SRC_DIR/.git" ]; then
  echo "[gateway] source dir is a git repo ($SRC_DIR) → hot-update enabled"
  cd "$SRC_DIR"
  echo "[gateway] installing dependencies…"
  # Keep pnpm's store out of the source tree so the checkout stays clean.
  pnpm install --frozen-lockfile --store-dir "${DSH_GATEWAY_PNPM_STORE:-/data/pnpm-store}"
  echo "[gateway] building…"
  pnpm -r build
else
  echo "[gateway] source dir is not a git repo ($SRC_DIR) → hot-update disabled"
  if [ ! -d "$SRC_DIR" ] || [ -z "$(ls -A "$SRC_DIR" 2>/dev/null)" ]; then
    echo "[gateway] error: no source at $SRC_DIR" >&2
    exit 1
  fi
  cd "$SRC_DIR"
fi

echo "[gateway] starting gateway (tsx watch, hot-reload on git pull)…"
exec pnpm --filter dsh-gateway-server dev
