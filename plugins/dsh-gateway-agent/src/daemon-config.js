// dsh-gateway-agent — daemon-supervision config + runtime state (ADR-0010 §3).
//
// Two files, both under `$DSH_HOME/dsh-gateway-agent/`, shared by the in-dsh
// plugin half and the standalone supervisor process:
//
//   daemon.json  — what to run and how to start/stop/restart it. Written by the
//                  plugin (settings card → saveDaemonConfig) and read by the
//                  supervisor. User-owned: the supervisor never rewrites it.
//   daemon-state.json — the supervisor's runtime state (state, pid, last error,
//                  last control result). Written by the supervisor only, so the
//                  plugin settings card can show it without an extra socket.
//
// The scripts are deliberately plain command strings shown in the UI with
// offline-safe defaults: the operator can always read and edit exactly what the
// gateway will execute on this machine.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaemonState } from './protocol.js'
import { configDir } from './config.js'

export { DaemonState }

export const DAEMON_CONFIG_FILE = 'daemon.json'
export const DAEMON_STATE_FILE = 'daemon-state.json'

/** Where the standalone supervisor entry lives, resolved at plugin load time. */
export const SUPERVISOR_ENTRY_FILE = 'daemon.js'

/** Stop escalation default: how long a graceful stop may take before SIGKILL. */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000

/**
 * Default start/stop/restart/status scripts, per platform. They are only
 * defaults — the settings card renders them as editable text and the supervisor
 * executes exactly what is stored.
 *
 * Placeholders (expanded by the supervisor at run time): `{port}` (dsh web
 * port), `{home}` (dsh home, usually `$DSH_HOME`), `{dshHome}` (same value),
 * `{pid}` (managed child pid, empty in script mode).
 *
 * The Windows defaults match dsh BY COMMAND LINE and explicitly exclude the
 * supervisor's own process (`--dsh-gateway-supervisor`). A bare
 * `taskkill /im dsh.exe` would be wrong twice over on a machine that runs dsh
 * from a checkout (`node … bin.ts web`) and could take the supervisor down with
 * it, so the defaults never kill by image name.
 */
export function defaultScripts(platform = process.platform) {
  if (platform === 'win32') {
    // The Windows path goes through the shipped lifecycle helper (service/
    // dsh-lifecycle.ps1) instead of a cmd one-liner: it matches dsh by command
    // line, never by image name, and always excludes the supervisor's own
    // process so a stop can never take the supervisor down with dsh.
    const helper = join(dirname(fileURLToPath(import.meta.url)), '..', 'service', 'dsh-lifecycle.ps1')
    // `{port}` reaches the helper as its positional PORT argument.
    const ps = (action) => `powershell -NoProfile -ExecutionPolicy Bypass -File "${helper}" ${action} {port}`
    return {
      shell: 'cmd',
      start: ps('start'),
      stop: ps('stop'),
      restart: '',
      status: ps('status'),
    }
  }
  return {
    // POSIX. `nohup … &` so the child survives the invoking shell; the
    // supervisor tracks the real pid itself when it can.
    shell: 'sh',
    start: 'nohup dsh web --port {port} >/dev/null 2>&1 &',
    stop: 'pkill -f "dsh web"',
    restart: '',
    // Optional liveness probe: exit 0 when dsh is running. Without it the
    // supervisor only knows what it last started/stopped itself (in "script"
    // mode), so a crash outside its control is reported as still running.
    status: 'pgrep -f "dsh web" >/dev/null',
  }
}

export function daemonConfigPath(dir) {
  return join(dir, DAEMON_CONFIG_FILE)
}

export function daemonStatePath(dir) {
  return join(dir, DAEMON_STATE_FILE)
}

/**
 * The full daemon config shape, with defaults applied. `enabled` is the
 * checkbox in the settings card; `supervise` holds the editable lifecycle
 * commands; `child` optionally spawns dsh directly as a managed child.
 */
export function defaultDaemonConfig(platform = process.platform) {
  const scripts = defaultScripts(platform)
  return {
    enabled: false,
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
    // Off by default: "关闭" must mean stopped, not "comes back by itself".
    autoRevive: false,
    logFile: '',
    child: { command: '', cwd: '', env: {} },
    scripts: { ...scripts, restart: scripts.restart || '' },
  }
}

function readJson(path) {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), mode ? { mode } : undefined)
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1_000) return DEFAULT_STOP_TIMEOUT_MS
  return Math.min(Math.round(n), 120_000)
}

function envMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Normalize an untrusted daemon config (browser input, hand-edited file) into
 * the canonical shape. Unknown keys are dropped; every field type is coerced.
 */
export function normalizeDaemonConfig(input, platform = process.platform) {
  const defaults = defaultDaemonConfig(platform)
  const cfg = input && typeof input === 'object' ? input : {}
  const scripts = cfg.scripts && typeof cfg.scripts === 'object' ? cfg.scripts : {}
  const child = cfg.child && typeof cfg.child === 'object' ? cfg.child : {}
  return {
    enabled: cfg.enabled === true,
    stopTimeoutMs: clampTimeout(cfg.stopTimeoutMs ?? defaults.stopTimeoutMs),
    autoRevive: cfg.autoRevive === true,
    logFile: str(cfg.logFile),
    child: {
      command: str(child.command),
      cwd: str(child.cwd),
      env: envMap(child.env),
    },
    scripts: {
      shell: str(scripts.shell, defaults.scripts.shell) || defaults.scripts.shell,
      start: str(scripts.start, defaults.scripts.start),
      stop: str(scripts.stop, defaults.scripts.stop),
      restart: str(scripts.restart),
      status: str(scripts.status, defaults.scripts.status),
    },
  }
}

export function readDaemonConfig(dir) {
  return normalizeDaemonConfig(readJson(daemonConfigPath(dir)))
}

export function writeDaemonConfig(dir, config) {
  const normalized = normalizeDaemonConfig(config)
  writeJson(daemonConfigPath(dir), normalized, 0o600)
  return normalized
}

/** Supervisor runtime state, with defaults. Missing file ⇒ never supervised. */
export function normalizeDaemonRuntime(input) {
  const cfg = input && typeof input === 'object' ? input : {}
  const state = Object.values(DaemonState).includes(cfg.state) ? cfg.state : DaemonState.UNKNOWN
  return {
    state,
    pid: Number.isInteger(cfg.pid) ? cfg.pid : null,
    supervisorPid: Number.isInteger(cfg.supervisorPid) ? cfg.supervisorPid : null,
    startedAt: typeof cfg.startedAt === 'string' ? cfg.startedAt : null,
    updatedAt: typeof cfg.updatedAt === 'string' ? cfg.updatedAt : null,
    lastAction: typeof cfg.lastAction === 'string' ? cfg.lastAction : null,
    lastError: typeof cfg.lastError === 'string' ? cfg.lastError : null,
    lastActionAt: typeof cfg.lastActionAt === 'string' ? cfg.lastActionAt : null,
  }
}

export function readDaemonRuntime(dir) {
  return normalizeDaemonRuntime(readJson(daemonStatePath(dir)))
}

/**
 * Persist supervisor runtime state. Only the supervisor calls this — the plugin
 * reads it. Kept as an alias-free pair with readDaemonRuntime so the two halves
 * cannot disagree about the file shape.
 */
export function writeDaemonRuntime(dir, state) {
  const normalized = normalizeDaemonRuntime(state)
  writeJson(daemonStatePath(dir), normalized, 0o600)
  return normalized
}

/** Convenience for both halves: the shared data directory for this plugin. */
export function daemonDir() {
  return configDir()
}
