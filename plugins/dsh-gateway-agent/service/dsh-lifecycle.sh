#!/bin/sh
# dsh-gateway-agent -- POSIX dsh lifecycle helper (macOS and Linux).
#
# The POSIX defaults in the plugin settings card call this script instead of a
# `pkill -f "dsh web"` one-liner. That one-liner is wrong on every install style
# except a global `dsh` CLI:
#   * a checkout runs `node --import tsx/esm apps/cli/src/bin.ts web`, whose
#     command line does not contain "dsh web" at all;
#   * `pnpm dsh web` leaves only the wrapper matching, so a stop reports success
#     while the real dsh keeps listening;
#   * a machine-wide `pkill` would also hit every OTHER dsh web on the machine.
#
# A process counts as dsh when it LISTENS on the configured port -- true for
# `dsh web`, `pnpm dsh web` and `node ... bin.ts web` alike. The command-line
# match is only the fallback for a dsh that is still booting or has lost its
# socket. The supervisor's own process and this helper are always excluded, so
# `stop` can never take the supervisor down with dsh.
#
# Usage: sh dsh-lifecycle.sh status|stop|start [PORT]
# Exit codes: status -> 0 running, 1 not running.
#             stop   -> 0 always (idempotent).
#             start  -> 0 when a start was issued; 1 when it could not be (so the
#                       supervisor reports the real error instead of waiting for
#                       a dsh that will never come up).
#
# macOS note: launchd starts agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a
# Homebrew/nvm `dsh` is invisible unless the plist's PATH includes its directory
# (service/install-supervisor-launchd.sh records the installer's PATH for exactly
# this reason). find_dsh() also looks in the common install locations.

set -u

action=${1:-}
port=${2:-3080}

case "$port" in
  '' | *[!0-9]*)
    echo "dsh: invalid port '$port'" >&2
    exit 2
    ;;
esac

data_dir=${DSH_HOME:-$HOME/.dsh}/dsh-gateway-agent

# The supervisor runs as `node <plugin>/src/daemon.js` (or through the published
# `dsh-gateway-supervisor` bin), and this helper is itself launched as
# `sh .../dsh-lifecycle.sh <action> <port>`. None of these is ever dsh.
is_excluded() {
  case "$1" in
    *dsh-gateway-agent*daemon.js*) return 0 ;;
    *dsh-gateway-supervisor*) return 0 ;;
    *dsh-lifecycle.sh*) return 0 ;;
  esac
  return 1
}

# Pids listening on the port. lsof is present on macOS and most Linux installs;
# `ss` covers minimal Linux images, and the command-line scan below is the last
# resort.
pids_by_port() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p'
    return 0
  fi
  return 0
}

# Fallback only: `dsh web` / `dsh.exe web` / `pnpm dsh web`, and the checkout
# form `node ... bin.ts web`. Deliberately narrow -- a bare `dsh` word would also
# match every command line carrying a `.dsh` path.
pids_by_command() {
  # One grep for the whole table, not one per process: this runs on every
  # 15s status probe.
  ps -A -o pid=,command= 2>/dev/null |
    grep -E '(^|[[:space:]/])dsh(\.exe|\.cmd)?[[:space:]]+web([[:space:]]|$)|bin\.ts[[:space:]]+web([[:space:]]|$)' |
    while read -r pid command; do
      [ -n "$pid" ] || continue
      case "$pid" in *[!0-9]*) continue ;; esac
      is_excluded "$command" && continue
      echo "$pid"
    done
}

# The listener on the port wins: it identifies THIS dsh whatever launched it.
# Only when nothing listens do we scan command lines, which cannot distinguish
# two dsh instances on one machine.
dsh_pids() {
  port_pids=$(
    pids_by_port | while read -r pid; do
      [ -n "$pid" ] || continue
      line=$(ps -p "$pid" -o command= 2>/dev/null || true)
      is_excluded "$line" && continue
      echo "$pid"
    done | sort -n -u
  )
  if [ -n "$port_pids" ]; then
    echo "$port_pids"
    return 0
  fi
  pids_by_command | sort -n -u
}

# `dsh` may be installed where the supervisor's PATH does not look (launchd's
# minimal PATH is the common case). Prefer PATH, then the usual locations.
find_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi
  for candidate in \
    "$HOME/.local/bin/dsh" \
    "$HOME/.npm-global/bin/dsh" \
    "$HOME/.volta/bin/dsh" \
    "$HOME"/.nvm/versions/node/*/bin/dsh \
    /usr/local/bin/dsh \
    /opt/homebrew/bin/dsh \
    /usr/bin/dsh; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

case "$action" in
  status)
    pids=$(dsh_pids)
    if [ -n "$pids" ]; then
      echo "dsh: running (pid $(printf '%s' "$pids" | tr '\n' ' '))"
      exit 0
    fi
    echo 'dsh: not running'
    exit 1
    ;;

  stop)
    pids=$(dsh_pids)
    if [ -z "$pids" ]; then
      echo 'dsh: not running'
      exit 0
    fi
    # Freeze the pid set NOW. Re-discovering processes while waiting would let
    # the command-line fallback pick up a DIFFERENT dsh once this one exits.
    for pid in $pids; do
      echo "dsh: stopping pid=$pid"
      kill -TERM "$pid" 2>/dev/null || true
    done
    deadline=$(( $(date +%s) + 8 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      alive=0
      for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then alive=1; fi
      done
      [ "$alive" -eq 0 ] && break
      sleep 0.3
    done
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        echo "dsh: force-stopping pid=$pid"
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
    exit 0
    ;;

  start)
    pids=$(dsh_pids)
    if [ -n "$pids" ]; then
      echo 'dsh: already running'
      exit 0
    fi
    mkdir -p "$data_dir" 2>/dev/null || true
    log="$data_dir/dsh.log"
    : >>"$log" 2>/dev/null || log=/dev/null
    # --no-open: a supervisor start is remote; the machine's default browser must
    # not pop open. nohup + & keeps dsh alive when the supervisor exits, and the
    # log file (not a pipe) avoids EPIPE when the supervisor goes away.
    if dsh_bin=$(find_dsh); then
      echo "dsh: starting ($dsh_bin web --no-open --port $port)"
      nohup "$dsh_bin" web --no-open --port "$port" >>"$log" 2>&1 &
      exit 0
    fi
    # A source checkout has no global `dsh` on PATH: the machine runs
    # `node --import tsx/esm apps/cli/src/bin.ts web` (or the built lib entry)
    # from the checkout root. The supervisor runs this helper with child.cwd (or,
    # when started by the plugin, the dsh checkout itself), so resolve that here
    # instead of making the operator retype the launch command.
    if command -v node >/dev/null 2>&1; then
      if [ -f ./apps/cli/src/bin.ts ]; then
        echo "dsh: starting (checkout: node --import tsx/esm apps/cli/src/bin.ts web --no-open --port $port)"
        nohup node --import tsx/esm apps/cli/src/bin.ts web --no-open --port "$port" >>"$log" 2>&1 &
        exit 0
      fi
      if [ -f ./apps/cli/lib/bin.js ]; then
        echo "dsh: starting (checkout: node apps/cli/lib/bin.js web --no-open --port $port)"
        nohup node apps/cli/lib/bin.js web --no-open --port "$port" >>"$log" 2>&1 &
        exit 0
      fi
    fi
    echo "dsh: neither 'dsh' on PATH nor a checkout in '$PWD' (no ./apps/cli/src/bin.ts) -- put dsh on PATH, set scripts.start to the full command, or set child.cwd to the checkout root"
    exit 1
    ;;

  *)
    echo "usage: sh $0 status|stop|start [PORT]" >&2
    exit 2
    ;;
esac
