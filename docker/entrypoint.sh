#!/usr/bin/env sh
set -eu

# deepseek-harness-gateway container entrypoint.
#
# Two modes:
#   baked (default) — no DSH_GATEWAY_GIT_REPO set. Run the source bundled into the
#                     image. It has no .git, so hot-update is disabled.
#   git — DSH_GATEWAY_GIT_REPO set. Clone/pull that repo into DSH_GATEWAY_SRC_DIR
#         at startup so the running checkout has a git remote and hot-update works.

SRC_DIR="${DSH_GATEWAY_SRC_DIR:-/app/source}"
GIT_REF="${DSH_GATEWAY_GIT_REF:-main}"

if [ -n "${DSH_GATEWAY_GIT_REPO:-}" ]; then
  echo "[gateway] git mode: repo=$DSH_GATEWAY_GIT_REPO ref=$GIT_REF dir=$SRC_DIR"
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
    git clone --branch "$GIT_REF" "$DSH_GATEWAY_GIT_REPO" "$SRC_DIR"
  fi

  cd "$SRC_DIR"
  echo "[gateway] installing dependencies…"
  pnpm install --frozen-lockfile
  echo "[gateway] building…"
  pnpm -r build
else
  echo "[gateway] baked mode: using source bundled into the image (no DSH_GATEWAY_GIT_REPO → hot-update disabled)"
  cd "$SRC_DIR"
fi

echo "[gateway] starting gateway (tsx watch, hot-reload on git pull)…"
exec pnpm --filter dsh-gateway-server dev
