#!/bin/sh
# dsh-gateway-agent -- install the dsh LIFECYCLE SUPERVISOR as a macOS LaunchAgent.
#
# What this supervises is the SUPERVISOR (daemon.js), not dsh itself: the
# supervisor is what starts/stops/restarts dsh when the gateway portal asks. Do
# not also register dsh with launchd -- pick ONE owner.
#
# Why a script instead of the sample plist: launchd starts an agent with
# PATH=/usr/bin:/bin:/usr/sbin:/sbin, so the sample's `/usr/bin/env node` cannot
# find a Homebrew (/opt/homebrew/bin, /usr/local/bin) or nvm node -- the agent
# crash-loops under KeepAlive and the supervisor never comes up. This script
# writes the ABSOLUTE node and supervisor paths, records the installer's PATH in
# the plist (so the lifecycle helper can find `dsh`), and uses the modern
# launchctl bootstrap/bootout API.
#
# Usage:
#   ./install-supervisor-launchd.sh                       # install (default)
#   ./install-supervisor-launchd.sh install
#   ./install-supervisor-launchd.sh uninstall
#   ./install-supervisor-launchd.sh status
#   ./install-supervisor-launchd.sh install --dsh-home /Volumes/Data/dsh-home
#
# NODE=/path/to/node overrides node discovery.

set -u

LABEL=com.januory.dsh-gateway-supervisor
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"

action=${1:-install}
case "$action" in
  install | uninstall | status) shift ;;
  -h | --help)
    sed -n '2,24p' "$0"
    exit 0
    ;;
  *)
    echo "usage: $0 install|uninstall|status [--dsh-home PATH]" >&2
    exit 2
    ;;
esac

dsh_home=${DSH_HOME:-$HOME/.dsh}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dsh-home)
      [ "$#" -ge 2 ] || { echo "$0: --dsh-home needs a path" >&2; exit 2; }
      dsh_home=$2
      shift 2
      ;;
    --dsh-home=*)
      dsh_home=${1#--dsh-home=}
      shift
      ;;
    *)
      echo "$0: unexpected argument '$1' (a bare word is an ACTION: install | uninstall | status)" >&2
      exit 2
      ;;
  esac
done

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

supervisor_pid() {
  # daemon.js sets process.title, which REPLACES the argv in ps/pgrep output on
  # macOS, so matching only the entry path never finds a running supervisor.
  # The title (`dsh-gateway-agent-supervisor …`) and the published bin
  # (`dsh-gateway-supervisor`) both carry a marker; match either.
  pgrep -f 'dsh-gateway-agent-supervisor|dsh-gateway-agent.*daemon\.js' 2>/dev/null | head -1 || true
}

# The pid THIS LaunchAgent owns. Prefer it over the global pgrep: another
# supervisor (a second DSH_HOME, or one started from the settings card) can be
# running at the same time on this machine.
launchd_pid() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p' | head -1
}

print_status() {
  echo "label    : $LABEL"
  if [ -f "$PLIST" ]; then
    echo "plist    : $PLIST"
  else
    echo 'plist    : not installed'
  fi
  state=$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -1)
  if [ -n "$state" ]; then
    pid=$(launchd_pid)
    echo "launchd  : $state${pid:+ (pid $pid)}"
  else
    echo 'launchd  : not loaded'
  fi
  pid=$(launchd_pid)
  if [ -z "$pid" ]; then
    pid=$(supervisor_pid)
    [ -n "$pid" ] && echo "supervisor: running (pid $pid, not owned by launchd)"
  else
    echo "supervisor: running (pid $pid)"
  fi
  [ -n "$pid" ] || echo 'supervisor: not running'
  echo "DSH_HOME : $dsh_home"
}

find_node() {
  if [ -n "${NODE:-}" ] && [ -x "$NODE" ]; then
    printf '%s\n' "$NODE"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [ "$action" = status ]; then
  print_status
  exit 0
fi

if [ "$action" = uninstall ]; then
  # Remember THIS agent's pid: other supervisors (another DSH_HOME, or one
  # started from the settings card) may be running and must not be confused
  # with ours.
  pid=$(launchd_pid)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  sleep 1
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Removed $LABEL, but its supervisor (pid $pid) is still running."
  else
    echo "Removed $LABEL."
  fi
  exit 0
fi

# ---- install -----------------------------------------------------------------
node_bin=$(find_node) || {
  echo 'cannot find node. Install Node.js, or run with NODE=/absolute/path/to/node.' >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
entry="$script_dir/../src/daemon.js"
if [ ! -f "$entry" ]; then
  # A different layout (e.g. a symlinked service dir): ask the package itself.
  entry=$("$node_bin" -e "console.log(require.resolve('@januory/dsh-gateway-agent/daemon'))" 2>/dev/null || true)
fi
if [ ! -f "$entry" ]; then
  echo "cannot find daemon.js next to this script ($script_dir/../src/daemon.js)" >&2
  exit 1
fi
entry=$(CDPATH= cd -- "$(dirname -- "$entry")" && pwd)/$(basename -- "$entry")

# launchd's PATH is minimal; a Homebrew/nvm `dsh` is otherwise invisible to the
# lifecycle helper the supervisor runs. Record this shell's PATH, and make sure
# the obvious install directories are present even when the installer was
# started from a GUI context.
plist_path=$PATH
for dir in "$(dirname -- "$node_bin")" /opt/homebrew/bin /usr/local/bin; do
  case ":$plist_path:" in
    *":$dir:"*) ;;
    *) plist_path="$dir:$plist_path" ;;
  esac
done
dsh_bin=$(command -v dsh 2>/dev/null || true)
if [ -z "$dsh_bin" ]; then
  for candidate in /opt/homebrew/bin/dsh /usr/local/bin/dsh "$HOME/.local/bin/dsh"; do
    if [ -x "$candidate" ]; then
      dsh_bin=$candidate
      break
    fi
  done
fi
if [ -n "$dsh_bin" ]; then
  dsh_dir=$(dirname -- "$dsh_bin")
  case ":$plist_path:" in
    *":$dsh_dir:"*) ;;
    *) plist_path="$dsh_dir:$plist_path" ;;
  esac
else
  echo "note: 'dsh' was not found; the start script will need an absolute command (see the dsh settings card)."
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by install-supervisor-launchd.sh; re-run it after moving node or the plugin. -->
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
      <string>$(xml_escape "$node_bin")</string>
      <string>$(xml_escape "$entry")</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>DSH_HOME</key>
      <string>$(xml_escape "$dsh_home")</string>
      <key>PATH</key>
      <string>$(xml_escape "$plist_path")</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$(xml_escape "$HOME/Library/Logs/dsh-gateway-supervisor.log")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "$HOME/Library/Logs/dsh-gateway-supervisor.err.log")</string>
  </dict>
</plist>
EOF

echo "Supervisor entry : $entry"
echo "Node             : $node_bin"
echo "DSH_HOME         : $dsh_home"
echo "PATH (launchd)   : $plist_path"

# Boot out an older agent first (modern API, with the legacy unload as fallback),
# so a stale definition cannot keep fighting the new one.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  launchctl load -w "$PLIST" || {
    echo "cannot load $PLIST" >&2
    exit 1
  }
fi
launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true

# Registering is not proof: confirm THIS agent's process really is alive.
# Only launchd's own pid counts here -- a global pgrep could find an unrelated
# supervisor (another DSH_HOME, or one started from the settings card) and
# report success for an agent that never came up.
sleep 2
pid=$(launchd_pid)
if [ -n "$pid" ]; then
  echo "Installed and started $LABEL (supervisor pid $pid)."
  echo "Logs: $HOME/Library/Logs/dsh-gateway-supervisor.log"
else
  echo "Installed $LABEL, but no supervisor process is running." >&2
  echo "Check: launchctl print $DOMAIN/$LABEL   and   $HOME/Library/Logs/dsh-gateway-supervisor.{log,err.log}" >&2
  exit 1
fi
