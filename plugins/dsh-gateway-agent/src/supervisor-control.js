// dsh-gateway-agent — start/stop the standalone supervisor from the plugin.
//
// The settings card's "保存守护设置" acts on the "启用守护进程服务" checkbox: ticked it
// starts the supervisor, unticked it stops it. Two rules shape the implementation:
//
//   1. the supervisor must OUTLIVE dsh (that is its entire purpose), so it is spawned
//      detached and this plugin never becomes its owner;
//   2. we therefore never blindly kill a pid out of daemon-state.json — a recycled pid
//      would be someone else's process. The signal only goes out after the command line
//      proves the process really is our supervisor entry.
//
// A supervisor installed as a service (systemd / launchd / scheduled task) may be
// restarted by that manager right after we stop it; the result says so instead of
// pretending the stop worked.

import { spawn, execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDaemonRuntime } from './daemon-config.js'

/** The supervisor entry shipped next to this plugin, for link:, npm and workspace installs. */
export const SUPERVISOR_ENTRY = fileURLToPath(new URL('./daemon.js', import.meta.url))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM') // exists, just not ours to signal
  }
}

/** Command line of a pid, or '' when it cannot be read. */
function commandLine(pid) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const bin = win ? 'powershell.exe' : 'ps'
    const args = win
      ? ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]
      : ['-p', String(pid), '-o', 'command=']
    execFile(bin, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim())
    })
  })
}

/**
 * True only when `pid` is alive AND its command line proves it is this plugin's
 * supervisor. The published bin (`dsh-gateway-supervisor`) is accepted too.
 */
export async function isOurSupervisor(pid) {
  if (!alive(pid)) return false
  const line = await commandLine(pid)
  if (!line) return false
  return (
    line.includes(SUPERVISOR_ENTRY) ||
    line.includes('dsh-gateway-supervisor') ||
    (line.includes('dsh-gateway-agent') && line.includes('daemon.js'))
  )
}

/** The pid the supervisor last wrote into daemon-state.json, if any. */
export function knownSupervisorPid(dir) {
  const rt = readDaemonRuntime(dir)
  return Number.isInteger(rt.supervisorPid) ? rt.supervisorPid : null
}

/** Is a supervisor for this dsh home running right now? */
export async function supervisorRunning(dir) {
  const pid = knownSupervisorPid(dir)
  return pid ? await isOurSupervisor(pid) : false
}

/**
 * Sync liveness of the recorded pid — for the settings card's status line, which
 * cannot await. It does not verify the command line (that is `isOurSupervisor`), so
 * treat it as "the pid we recorded still exists", not as proof of identity.
 */
export function supervisorAlive(dir) {
  return alive(knownSupervisorPid(dir))
}

/**
 * Start the supervisor unless one is already running. Detached on purpose: it has to
 * survive this dsh process.
 */
export async function startSupervisor(dir, { timeoutMs = 10_000 } = {}) {
  if (await supervisorRunning(dir)) return { action: 'already-running', ok: true }
  try {
    const child = spawn(process.execPath, [SUPERVISOR_ENTRY], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // The supervisor resolves its own config from DSH_HOME — hand it the same home
      // this plugin used, so a card on a non-default home still lines up.
      env: { ...process.env, DSH_HOME: dirname(dir) },
    })
    child.unref()
  } catch (e) {
    return { action: 'failed', ok: false, detail: String((e && e.message) || e) }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(250)
    const pid = knownSupervisorPid(dir)
    if (pid && (await isOurSupervisor(pid))) return { action: 'started', ok: true, detail: `pid ${pid}` }
  }
  return { action: 'failed', ok: false, detail: `the supervisor did not register within ${timeoutMs}ms` }
}

/** Stop the supervisor, but only after proving the pid is really ours. */
export async function stopSupervisor(dir, { timeoutMs = 8_000 } = {}) {
  const pid = knownSupervisorPid(dir)
  if (!pid || !alive(pid)) return { action: 'not-running', ok: true }
  if (!(await isOurSupervisor(pid))) {
    return { action: 'refused', ok: false, detail: `pid ${pid} is not this plugin's supervisor` }
  }
  try {
    process.kill(pid, 'SIGTERM') // Windows: forceful; POSIX: graceful, escalated below
  } catch (e) {
    return { action: 'failed', ok: false, detail: String((e && e.message) || e) }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(250)
    if (!alive(pid)) return { action: 'stopped', ok: true }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
  await sleep(300)
  return alive(pid)
    ? { action: 'failed', ok: false, detail: `pid ${pid} ignored SIGTERM` }
    : { action: 'stopped', ok: true }
}

/**
 * What "保存守护设置" does with the checkbox: ticked ⇒ make sure a supervisor runs,
 * unticked ⇒ stop it. A service manager may bring it straight back, so that case is
 * reported (`restartedByService`) instead of being hidden.
 */
export async function applySupervision(dir, enabled) {
  if (enabled) return startSupervisor(dir)
  const result = await stopSupervisor(dir)
  if (result.action === 'stopped') {
    await sleep(1_200)
    if (await supervisorRunning(dir)) return { ...result, restartedByService: true }
  }
  return result
}
