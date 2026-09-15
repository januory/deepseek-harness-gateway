#!/usr/bin/env node
// dsh-gateway-agent — standalone dsh lifecycle supervisor (守护进程服务).
//
// ADR-0010 listed "不自管 dsh 子进程/不做守护" as a v1 non-goal: the plugin lives
// INSIDE dsh, so it dies with dsh and can never restart it. This process is the
// missing layer that lets the gateway offer start / stop / restart per machine:
//
//   gateway  ⇄ (wss, role=supervisor)  ⇄  THIS PROCESS  ⇄  dsh process
//   gateway  ⇄ (wss, role=console)     ⇄  plugin (inside dsh)  → data plane
//
// Because the supervisor holds its own socket, it stays reachable while dsh is
// stopped — which is the only reason "关闭" is reversible from the portal.
//
// It must therefore NOT be a child of dsh: run it as its own OS service (see the
// `service/` samples in this package) or as a detached foreground process.
//
// What it does:
//   - reads the shared daemon config ($DSH_HOME/dsh-gateway-agent/daemon.json)
//     written by the plugin's settings card, plus the node identity from
//     config.json in the same directory
//   - keeps an outbound wss to the gateway and heartbeats its daemon state
//   - runs exactly the configured start/stop/restart/status commands, either as
//     a managed child process (`child.command`) or as shell scripts (`scripts.*`)
//   - writes its runtime state to daemon-state.json for the settings card
//
// Usage:
//   node daemon.js            # foreground; a service manager supervises it
//   node daemon.js --once     # connect, report state, exit (debug)
//
// Only dependency is `ws`, which the plugin already depends on.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  HALF_OPEN_TIMEOUT_MS,
  ControlType,
  DaemonType,
  NodeRole,
  DaemonState,
  isDaemonAction,
} from './protocol.js'
import { configDir, createConfigStore } from './config.js'
import { readDaemonConfig, readDaemonRuntime, writeDaemonRuntime } from './daemon-config.js'
import { nextBackoff, backoffDelay } from './backoff.js'
import { createLogger } from './log.js'

/**
 * Resolve the `ws` constructor lazily, from the plugin's own install first. The
 * supervisor runs OUTSIDE the dsh plugin host (that is the whole point), so under
 * pnpm's strict layout the hoisted root may not contain `ws` — resolving against
 * this file's URL (/…/dsh-gateway-agent/src/daemon.js →
 * /…/dsh-gateway-agent/node_modules/ws) finds it wherever the plugin was
 * installed. Lazy so that importing this module (tests) never needs the deps.
 */
let wsClientCtor
function wsClient() {
  if (wsClientCtor) return wsClientCtor
  try {
    wsClientCtor = createRequire(import.meta.url)('ws')
  } catch (e) {
    throw new Error(
      `cannot load the "ws" dependency from the plugin install (${e && e.message ? e.message : e}); ` +
        'reinstall the plugin: dsh plugin --profile web add @januory/dsh-gateway-agent',
    )
  }
  return wsClientCtor
}

const SUPERVISOR_VERSION = '0.1.0'
/**
 * Command-line marker that identifies the supervisor for lifecycle scripts.
 * `service/dsh-lifecycle.ps1` refuses to touch any process whose command line
 * carries it, so `stop` can never kill the supervisor itself.
 */
export const SUPERVISOR_MARKER = 'dsh-gateway-supervisor'
const ONCE = process.argv.includes('--once')
const DEBUG = ['1', 'true', 'yes'].includes(String(process.env.DSH_AGENT_DEBUG || '').toLowerCase())

/** Grace period between SIGTERM and SIGKILL for a managed child. */
const KILL_GRACE_MS = 3_000

/** How long a start script may take to make dsh appear before we call it failed. */
const START_PROBE_ATTEMPTS = 10
const START_PROBE_INTERVAL_MS = 500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Command helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Substitute `{port}` / `{dshPort}` / `{home}` / `{pid}` placeholders. */
export function expandCommand(command, vars) {
  return String(command).replace(/\{(\w+)\}/g, (all, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all,
  )
}

/**
 * Split a configured command into argv, honouring single/double quotes so a
 * path with spaces survives. Used only for the shell-free `child.command` path.
 */
export function splitCommand(command) {
  const out = []
  let cur = ''
  let quote = ''
  for (const ch of String(command)) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Run a configured lifecycle script through the shell.
 * Resolves { code, stdout, stderr, skipped }; never throws on a non-zero exit.
 */
export function runScript(script, shell, cwd, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    if (!script || !String(script).trim()) {
      resolve({ code: 0, stdout: '', stderr: '', skipped: true })
      return
    }
    const useCmd = shell === 'cmd'
    const file = useCmd ? process.env.ComSpec || 'cmd.exe' : shell || 'sh'
    const args = useCmd ? ['/d', '/s', '/c', script] : ['-c', script]
    let child
    try {
      child = spawn(file, args, { cwd: cwd || undefined, windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ code: -1, stdout, stderr: `${stderr}\n[supervisor] script timed out` })
    }, timeoutMs)
    child.stdout?.on('data', (c) => {
      stdout += c.toString()
    })
    child.stderr?.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (e) => finish({ code: -1, stdout, stderr: stderr + String((e && e.message) || e) }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Run the optional liveness probe. Returns true/false, or null when no probe is
 * configured (the caller then trusts its own bookkeeping).
 */
export async function probeRunning(scripts, vars, cwd) {
  if (!scripts || !scripts.status || !String(scripts.status).trim()) return null
  const { code } = await runScript(expandCommand(scripts.status, vars), scripts.shell, cwd)
  return code === 0
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export class Supervisor {
  constructor({ dir, store, logger }) {
    this.dir = dir
    this.store = store
    this.log = logger
    this.config = readDaemonConfig(dir)
    this.child = null
    this.machineId = ''
    this.nodeKey = ''
    this.gatewayUrl = ''
    this.ws = null
    this.state = DaemonState.UNKNOWN
    this.lastError = null
    this.lastAction = null
    this.lastActionAt = null
    this.startedAt = null
    this.stopRequested = false
    this.backoffMs = RECONNECT_BASE_MS
    this.heartbeat = null
    this.watchdog = null
    this.reconnectTimer = null
    this.reviveTimer = null
    this.probeTimer = null
    this.lastSeen = 0
    this.shuttingDown = false
  }

  // -- config / state -------------------------------------------------------

  reloadConfig() {
    this.config = readDaemonConfig(this.dir)
    return this.config
  }

  machineConfig() {
    try {
      return this.store.read()
    } catch {
      return {}
    }
  }

  vars() {
    const cfg = this.machineConfig()
    const dataDir = configDir()
    return {
      port: cfg.dshPort || 3080,
      dshPort: cfg.dshPort || 3080,
      // `{home}` is the plugin's own data dir; `{dshHome}` is its parent (the
      // dsh home proper) — the value a lifecycle script usually wants.
      home: dataDir,
      dshHome: dirname(dataDir),
      pid: this.child && this.child.pid ? this.child.pid : '',
    }
  }

  setState(state, error) {
    this.state = state
    // An explicit call without `error` clears the previous failure (e.g. a
    // successful action); pass `undefined` to keep it.
    if (error !== undefined) this.lastError = error
    this.persistState()
    if (DEBUG) this.log.info(`state=${state}${this.lastError ? ' error=' + this.lastError : ''}`)
  }

  persistState() {
    try {
      writeDaemonRuntime(this.dir, {
        state: this.state,
        pid: this.child && this.child.pid ? this.child.pid : null,
        supervisorPid: process.pid,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
        lastAction: this.lastAction,
        lastActionAt: this.lastActionAt,
        lastError: this.lastError,
      })
    } catch (e) {
      this.log.error(`cannot write daemon state: ${e && e.message ? e.message : e}`)
    }
  }

  // -- lifecycle actions ----------------------------------------------------

  isChildRunning() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed)
  }

  /** Probe-based truth for script mode; a managed child is truth itself. */
  async refreshState() {
    if (this.state === DaemonState.STARTING) return
    if (this.isChildRunning()) {
      if (this.state !== DaemonState.RUNNING) this.setState(DaemonState.RUNNING, null)
      return
    }
    const probe = await probeRunning(this.config.scripts, this.vars(), this.config.child.cwd)
    if (probe === null) return
    if (probe && this.state !== DaemonState.RUNNING) this.setState(DaemonState.RUNNING, null)
    if (!probe && this.state === DaemonState.RUNNING) this.setState(DaemonState.EXITED, 'dsh is no longer running')
  }

  /**
   * Start dsh: prefers a managed child process (`child.command`), otherwise runs
   * the configured start script. Refuses when supervision is switched off.
   */
  async start() {
    this.reloadConfig()
    this.stopRequested = false
    if (!this.config.enabled) throw new Error('daemon supervision is disabled in the machine settings')
    if (this.isChildRunning()) return DaemonState.RUNNING
    this.setState(DaemonState.STARTING, null)
    const vars = this.vars()

    if (this.config.child.command) {
      const argv = splitCommand(expandCommand(this.config.child.command, vars))
      if (argv.length === 0) throw new Error('child command is empty')
      this.log.info(`starting child: ${argv.join(' ')}`)
      const child = spawn(argv[0], argv.slice(1), {
        cwd: this.config.child.cwd || undefined,
        env: { ...process.env, ...this.config.child.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      })
      child.stdout?.on('data', (c) => this.log.info(`dsh: ${String(c).trimEnd()}`))
      child.stderr?.on('data', (c) => this.log.error(`dsh: ${String(c).trimEnd()}`))
      child.on('exit', (code, signal) => this.onChildExit(code, signal))
      this.child = child
      this.startedAt = new Date().toISOString()
      this.setState(DaemonState.RUNNING, null)
      return this.state
    }

    const script = expandCommand(this.config.scripts.start, vars)
    if (!script.trim()) throw new Error('no start command configured (set 启动脚本 or 子进程命令)')
    const res = await runScript(script, this.config.scripts.shell, this.config.child.cwd)
    if (res.code !== 0) {
      this.setState(DaemonState.EXITED, `start script failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`)
      throw new Error(this.lastError)
    }
    this.startedAt = new Date().toISOString()
    this.setState(DaemonState.RUNNING, null)

    // A start script normally backgrounds dsh; confirm with the probe when one
    // is configured so a broken script reports `exited` instead of a lie.
    for (let i = 0; i < START_PROBE_ATTEMPTS; i++) {
      await sleep(START_PROBE_INTERVAL_MS)
      const probe = await probeRunning(this.config.scripts, this.vars(), this.config.child.cwd)
      if (probe === null) return this.state
      if (probe === true) return this.state
    }
    if ((await probeRunning(this.config.scripts, this.vars(), this.config.child.cwd)) === false) {
      this.setState(DaemonState.EXITED, 'dsh did not come up after the start script')
      throw new Error(this.lastError)
    }
    return this.state
  }

  /** Stop dsh: kill a managed child (TERM → KILL), else run the stop script. */
  async stop() {
    this.reloadConfig()
    this.setState(DaemonState.STARTING, null)
    const timeout = this.config.stopTimeoutMs

    if (this.isChildRunning()) {
      const child = this.child
      this.stopRequested = true
      this.log.info(`stopping child pid=${child.pid}`)
      const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
      try {
        child.kill('SIGTERM')
      } catch (e) {
        this.log.error(`SIGTERM failed: ${e && e.message ? e.message : e}`)
      }
      const graceful = await Promise.race([exited, sleep(timeout).then(() => false)])
      if (!graceful) {
        this.log.error(`child pid=${child.pid} ignored SIGTERM; sending SIGKILL`)
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        await Promise.race([exited, sleep(KILL_GRACE_MS)])
      }
    } else {
      const script = expandCommand(this.config.scripts.stop, this.vars())
      if (script.trim()) {
        const res = await runScript(script, this.config.scripts.shell, this.config.child.cwd)
        if (res.code !== 0) {
          this.log.error(`stop script exit=${res.code} ${res.stderr.trim() || res.stdout.trim()}`)
        }
      } else if (this.state === DaemonState.RUNNING) {
        this.setState(DaemonState.RUNNING, 'no stop command configured — dsh was not stopped')
        throw new Error('no stop command configured (set 停止脚本)')
      }
    }

    this.startedAt = null
    this.stopRequested = false
    this.setState(DaemonState.STOPPED, null)
    return this.state
  }

  async restart() {
    await this.stop()
    return this.start()
  }

  /** A managed child exited on its own (crash) or because we stopped it. */
  onChildExit(code, signal) {
    const wasStop = this.stopRequested
    this.child = null
    this.persistState()
    if (wasStop) return // stop() owns the final state
    const detail = `dsh exited (code=${code} signal=${signal || '-'})`
    this.log.error(detail)
    this.setState(DaemonState.EXITED, detail)
    if (this.config.autoRevive && this.config.enabled && !this.shuttingDown) {
      this.log.info('auto-revive is on; restarting dsh')
      if (this.reviveTimer) clearTimeout(this.reviveTimer)
      this.reviveTimer = setTimeout(() => {
        this.reviveTimer = null
        if (this.shuttingDown) return
        this.start().catch((e) => this.log.error(`auto-revive failed: ${e && e.message ? e.message : e}`))
      }, 2_000)
    }
  }

  // -- gateway connection ---------------------------------------------------

  gatewayConfig() {
    const cfg = this.machineConfig()
    return {
      gatewayUrl: cfg.gatewayUrl || '',
      pairingCode: cfg.pairingCode || '',
      machineId: cfg.machineId || '',
      nodeKey: cfg.nodeKey || '',
      machineName: cfg.machineName || `${hostname()} (supervisor)`,
    }
  }

  agentWebSocketUrl(base) {
    if (!base) return base
    const s = String(base).trim().replace(/\/+$/, '')
    if (s.endsWith('/agent')) return s
    return `${s}/agent`
  }

  connect() {
    const cfg = this.gatewayConfig()
    this.gatewayUrl = cfg.gatewayUrl
    if (!cfg.gatewayUrl) {
      this.log.info('no gatewayUrl configured yet; waiting for the plugin settings card')
      this.scheduleReconnect()
      return
    }
    this.machineId = cfg.machineId
    this.nodeKey = cfg.nodeKey
    this.log.info(`connecting ${this.agentWebSocketUrl(cfg.gatewayUrl)} machineId=${cfg.machineId || '(none)'}`)

    let ws
    try {
      ws = new (wsClient())(this.agentWebSocketUrl(cfg.gatewayUrl))
    } catch (e) {
      this.log.error(`connect failed: ${e && e.message ? e.message : e}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.lastSeen = Date.now()
    this.startWatchdog(ws)

    ws.on('open', () => this.log.info('socket open'))

    ws.on('message', (raw) => {
      if (this.ws !== ws) return
      this.lastSeen = Date.now()
      let msg
      try {
        msg = JSON.parse(raw.toString('utf8'))
      } catch {
        return
      }
      this.onMessage(ws, msg)
    })

    ws.on('close', (code) => {
      if (this.ws !== ws) return
      this.log.error(`socket closed code=${code}`)
      this.stopHeartbeat()
      this.ws = null
      this.scheduleReconnect()
    })
    ws.on('error', (e) => {
      if (this.ws !== ws) return
      this.log.error(`socket error: ${e && e.message ? e.message : e}`)
    })
  }

  onMessage(ws, msg) {
    const payload = msg.payload || {}
    if (msg.type === ControlType.CHALLENGE) {
      // Reconnect with the issued node key; otherwise onboard with the pairing
      // code the operator entered in the plugin settings card.
      const cfg = this.gatewayConfig()
      const identity =
        this.machineId && this.nodeKey
          ? { machineId: this.machineId, nodeKey: this.nodeKey }
          : { code: cfg.pairingCode, machineName: cfg.machineName }
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: ControlType.CHALLENGE_RESPONSE,
          payload: { ...identity, nonce: payload.nonce, role: NodeRole.SUPERVISOR },
        }),
      )
      return
    }

    if (msg.type === ControlType.REGISTRATION_STATUS) {
      if (payload.machineId) this.machineId = payload.machineId
      if (payload.nodeKey) {
        this.nodeKey = payload.nodeKey
        // Persist the issued identity into the SAME shared config the plugin
        // uses, so later restarts reconnect instead of re-onboarding.
        try {
          this.store.write({ ...this.store.read(), machineId: payload.machineId, nodeKey: payload.nodeKey })
        } catch (e) {
          this.log.error(`cannot persist node identity: ${e && e.message ? e.message : e}`)
        }
      }
      this.backoffMs = RECONNECT_BASE_MS
      this.startHeartbeat(ws)
      this.log.info(`registered state=${payload.state} machineId=${this.machineId || '(none)'}`)
      return
    }

    if (msg.type === ControlType.LEASE) return

    if (msg.type === DaemonType.DAEMON_CONTROL) {
      void this.handleControl(ws, payload)
    }
  }

  async handleControl(ws, payload) {
    const { id, action } = payload
    if (!isDaemonAction(action)) {
      this.reply(ws, { id, ok: false, error: `unsupported action ${action}` })
      return
    }
    this.lastAction = action
    this.lastActionAt = new Date().toISOString()
    this.log.info(`control action=${action} id=${id}`)
    try {
      let state
      if (action === 'start') state = await this.start()
      else if (action === 'stop') state = await this.stop()
      else state = await this.restart()
      this.setState(state, null)
      this.reply(ws, { id, ok: true, state: this.state })
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      this.log.error(`control action=${action} failed: ${message}`)
      this.lastError = message
      this.persistState()
      this.reply(ws, { id, ok: false, error: message, state: this.state })
    }
  }

  reply(ws, payload) {
    if (ws.readyState === wsClient().OPEN) {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DaemonType.DAEMON_RESULT, payload }))
    }
  }

  scheduleReconnect() {
    if (this.shuttingDown || ONCE || this.reconnectTimer) return
    const delay = backoffDelay(this.backoffMs, RECONNECT_MAX_MS)
    this.backoffMs = nextBackoff(this.backoffMs, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  startWatchdog(ws) {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = setInterval(() => {
      if (ws.readyState === wsClient().OPEN && Date.now() - this.lastSeen > HALF_OPEN_TIMEOUT_MS) {
        this.log.error('half-open socket; reconnecting')
        ws.close(4006, 'half-open connection')
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  startHeartbeat(ws) {
    this.stopHeartbeat()
    const beat = () => {
      if (ws.readyState !== wsClient().OPEN) return
      this.reloadConfig()
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: ControlType.HEARTBEAT,
          payload: {
            machineId: this.machineId,
            role: NodeRole.SUPERVISOR,
            supervisorVersion: SUPERVISOR_VERSION,
            daemonState: this.state,
            daemonEnabled: this.config.enabled === true,
          },
        }),
      )
    }
    beat()
    this.heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  async shutdown() {
    this.shuttingDown = true
    this.stopHeartbeat()
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.reviveTimer) clearTimeout(this.reviveTimer)
    if (this.probeTimer) clearInterval(this.probeTimer)
    if (this.ws) {
      try {
        this.ws.close(1000, 'supervisor exiting')
      } catch {
        /* ignore */
      }
    }
    // dsh is deliberately NOT stopped here: restarting the supervisor service
    // must never take the machine's dsh down.
    this.persistState()
  }

  /** Reconcile with reality on boot and bring dsh up when supervision is on. */
  async bootstrap() {
    this.reloadConfig()
    const previous = readDaemonRuntime(this.dir)
    if (!this.config.enabled) {
      this.setState(DaemonState.UNKNOWN, null)
      this.log.info('daemon supervision is disabled; reporting state only')
      return
    }
    const probe = await probeRunning(this.config.scripts, this.vars(), this.config.child.cwd)
    if (probe === true) {
      this.setState(DaemonState.RUNNING, null)
      return
    }
    if (probe === null && previous.state === DaemonState.RUNNING && this.config.child.command) {
      // No probe and no child of ours: we cannot own the process we reported.
      this.setState(DaemonState.EXITED, 'supervisor restarted; dsh ownership unknown (set 状态探测脚本)')
      return
    }
    this.log.info('dsh is not running; starting it')
    try {
      await this.start()
    } catch (e) {
      this.log.error(`bootstrap start failed: ${e && e.message ? e.message : e}`)
    }
  }

  /** Reconcile state periodically in script mode (no managed child to watch). */
  startProbeLoop(intervalMs = 15_000) {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = setInterval(() => {
      this.refreshState().catch((e) => this.log.error(`state probe failed: ${e && e.message ? e.message : e}`))
    }, intervalMs)
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const dir = configDir()
  const store = createConfigStore(dir)
  const initial = readDaemonConfig(dir)
  const logger = createLogger(initial.logFile)
  const sup = new Supervisor({ dir, store, logger })
  // Best-effort marker: lifecycle scripts (service/dsh-lifecycle.ps1) exclude a
  // command line carrying this so a stop can never take the supervisor down with
  // dsh. `process.title` is informational here; the authoritative marker is the
  // `dsh-gateway-supervisor` argv[1] of the published bin.
  process.title = `dsh-gateway-agent-supervisor ${SUPERVISOR_MARKER}`
  logger.info(
    `dsh-gateway-agent supervisor ${SUPERVISOR_VERSION} pid=${process.pid} dir=${dir} enabled=${initial.enabled} mode=${
      initial.child.command ? 'child' : 'script'
    }`,
  )

  const shutdown = async (signal) => {
    logger.info(`received ${signal}; exiting`)
    await sup.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await sup.bootstrap()
  sup.connect()
  sup.startProbeLoop()
  if (ONCE) {
    setTimeout(() => {
      sup.persistState()
      logger.info('--once: exiting')
      process.exit(0)
    }, 3_000)
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((e) => {
    console.error('[supervisor] fatal:', e && e.stack ? e.stack : e)
    process.exit(1)
  })
}
