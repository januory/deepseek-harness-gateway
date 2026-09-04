#!/usr/bin/env sh
set -eu

# deepseek-harness-gateway container entrypoint.
#
# Two modes:
#   git (default) — DSH_GATEWAY_GIT_REPO defaults to this project's repo; clone or
#                   pull it into DSH_GATEWAY_SRC_DIR, install, build and run. The
#                   running checkout has a git remote, so hot-update works.
#   baked — DSH_GATEWAY_GIT_REPO set to empty ("") runs the source bundled into the
#           image; it has no .git, so hot-update is disabled.

GIT_REPO="${DSH_GATEWAY_GIT_REPO:-https://github.com/januory/deepseek-harness-gateway.git}"
GIT_REF="${DSH_GATEWAY_GIT_REF:-main}"
SRC_DIR="${DSH_GATEWAY_SRC_DIR:-/app/source}"

if [ -n "$GIT_REPO" ]; then
  echo "[gateway] git mode: repo=$GIT_REPO ref=$GIT_REF dir=$SRC_DIR"
  if [ -d "$SRC_DIR/.git" ]; then
    echo "[gateway] updating existing checkout…"
    git -C "$SRC_DIR" fetch --tags origin "$GIT_REF"
    if git -C "$SRC_DIR" show-ref --verify --quiet "refs/remotes/origin/$GIT_REF"; then
      git -C "$SRC_DIR" checkout -fB "$GIT_REF" "origin/$GIT_REF"
    else
      git -C "$SRC_DIR" checkout -f "$GIT_REF"
    fi
  else
    echo "[gateway] cloning…"
    rm -rf "$SRC_DIR"
    git clone --branch "$GIT_REF" "$GIT_REPO" "$SRC_DIR"
  fi

  cd "$SRC_DIR"
  echo "[gateway] installing dependencies…"
  pnpm install --frozen-lockfile
  echo "[gateway] building…"
  pnpm -r build
else
  echo "[gateway] baked mode: using source bundled into the image (DSH_GATEWAY_GIT_REPO empty → hot-update disabled)"
  if [ ! -d "$SRC_DIR" ] || [ -z "$(ls -A "$SRC_DIR" 2>/dev/null)" ]; then
    echo "[gateway] error: no source at $SRC_DIR — set DSH_GATEWAY_GIT_REPO or mount a source volume" >&2
    exit 1
  fi
  cd "$SRC_DIR"
fi

echo "[gateway] starting gateway (tsx watch, hot-reload on git pull)…"
exec pnpm --filter dsh-gateway-server dev
