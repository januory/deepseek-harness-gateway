// Framework-less tests for the shared daemon config/state seam (browser card ↔
// supervisor). Run: node test/daemon-config.test.js

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultDaemonConfig,
  defaultScripts,
  normalizeDaemonConfig,
  normalizeDaemonRuntime,
  readDaemonConfig,
  readDaemonRuntime,
  writeDaemonConfig,
  writeDaemonRuntime,
} from '../src/daemon-config.js'

let passed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'dshgw-daemon-'))
}

// ---- defaults ---------------------------------------------------------------
const posix = defaultDaemonConfig('linux')
check(posix.enabled === false, 'supervision defaults to off')
// There is no auto-revive switch: a crashed dsh stays `exited` until an
// operator starts it (see daemon.js onChildExit).
check(!('autoRevive' in posix), 'no auto-revive option in the config shape')
check(posix.scripts.start.includes('{port}'), 'default start script carries the {port} placeholder')
check(defaultScripts('win32').shell === 'cmd', 'windows defaults use cmd')
// Windows must NOT kill by image name: on a checkout install there is no
// dsh.exe, and a name-based kill could hit the supervisor's own node process.
const winScripts = defaultScripts('win32')
check(!winScripts.stop.includes('taskkill'), 'windows stop default never kills by image name')
check(winScripts.stop.includes('dsh-lifecycle.ps1'), 'windows stop default goes through the shipped helper')
check(winScripts.status.includes('dsh-lifecycle.ps1'), 'windows status default goes through the shipped helper')
check(winScripts.start.includes('{port}'), 'windows start default carries the {port} placeholder')
// POSIX must not match by the `dsh web` command line: a checkout runs
// `node … bin.ts web` (no match at all) and `pnpm dsh web` leaves only the
// wrapper matching, so a stop reported success while dsh kept listening.
const posixScripts = defaultScripts('linux')
check(posixScripts.stop.includes('dsh-lifecycle.sh'), 'posix stop default goes through the shipped helper')
check(posixScripts.status.includes('dsh-lifecycle.sh'), 'posix status default goes through the shipped helper')
check(posixScripts.start.includes('dsh-lifecycle.sh'), 'posix start default goes through the shipped helper')
check(!posixScripts.stop.includes('pkill'), 'posix defaults never kill by the too-broad "dsh web" pattern')
check(!posixScripts.status.includes('pgrep'), 'posix defaults never probe by the too-broad "dsh web" pattern')
check(defaultScripts('darwin').start === posixScripts.start, 'macOS uses the same POSIX helper as Linux')

// Versions up to 0.2.2 persisted those defaults verbatim, so existing machines
// never saw the helper (or its --no-open). An exact match is upgraded on read;
// anything the operator actually edited is left alone.
const legacy = normalizeDaemonConfig(
  {
    scripts: {
      start: 'nohup dsh web --port {port} >/dev/null 2>&1 &',
      stop: 'pkill -f "dsh web"',
      status: 'pgrep -f "dsh web" >/dev/null',
    },
  },
  'darwin',
)
check(legacy.scripts.start.includes('dsh-lifecycle.sh'), 'a legacy POSIX start default is upgraded on read')
check(legacy.scripts.stop.includes('dsh-lifecycle.sh'), 'a legacy POSIX stop default is upgraded on read')
check(legacy.scripts.status.includes('dsh-lifecycle.sh'), 'a legacy POSIX status default is upgraded on read')
const customStart = normalizeDaemonConfig({ scripts: { start: 'nohup dsh web --no-open --port {port} &' } }, 'darwin')
check(customStart.scripts.start === 'nohup dsh web --no-open --port {port} &', 'a customized start script is preserved')
const winLegacy = normalizeDaemonConfig({ scripts: { start: 'nohup dsh web --port {port} >/dev/null 2>&1 &' } }, 'win32')
check(winLegacy.scripts.start.includes('nohup dsh web'), 'the POSIX upgrade is not applied on Windows')

// ---- round trip -------------------------------------------------------------
{
  const dir = scratch()
  try {
    writeDaemonConfig(dir, {
      enabled: true,
      // A stale file may still carry the removed autoRevive switch; it must be
      // dropped rather than kept alive as a silent behaviour.
      autoRevive: true,
      stopTimeoutMs: 5000,
      scripts: { start: 'echo start', stop: 'echo stop', restart: '', status: '' },
      child: { command: 'dsh web --port {port}', cwd: '/tmp', env: { A: '1', B: 2 } },
    })
    const read = readDaemonConfig(dir)
    check(read.enabled === true, 'enabled survives the round trip')
    check(!('autoRevive' in read), 'a stale autoRevive key is dropped, silently ignored')
    check(read.stopTimeoutMs === 5000, 'stopTimeoutMs survives the round trip')
    check(read.scripts.start === 'echo start', 'start script survives the round trip')
    check(read.child.command === 'dsh web --port {port}', 'child command survives the round trip')
    check(JSON.stringify(read.child.env) === '{"A":"1"}', 'non-string env values are dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- hardening against hand-edited / hostile input ---------------------------
check(readDaemonConfig(scratch()).enabled === false, 'missing config reads as disabled')
check(normalizeDaemonConfig({ enabled: 'yes' }).enabled === false, 'only literal true enables supervision')
check(normalizeDaemonConfig({ stopTimeoutMs: 10 }).stopTimeoutMs === 10000, 'too-small stop timeout is clamped')
check(normalizeDaemonConfig({ stopTimeoutMs: 999999 }).stopTimeoutMs === 120000, 'absurd stop timeout is clamped')
check(typeof normalizeDaemonConfig({ scripts: { start: 5 } }).scripts.start === 'string', 'non-string script becomes a string')

// ---- runtime state -----------------------------------------------------------
{
  const dir = scratch()
  try {
    const fresh = readDaemonRuntime(dir)
    check(fresh.state === 'unknown', 'no state file reads as unknown')
    check(fresh.pid === null && fresh.supervisorPid === null, 'no state file has no pids')

    writeDaemonRuntime(dir, {
      state: 'stopped',
      pid: null,
      supervisorPid: 4242,
      startedAt: null,
      updatedAt: '2026-09-10T00:00:00.000Z',
      lastAction: 'stop',
      lastActionAt: '2026-09-10T00:00:00.000Z',
      lastError: null,
    })
    const read = readDaemonRuntime(dir)
    check(read.state === 'stopped', 'stopped state survives the round trip')
    check(read.supervisorPid === 4242, 'supervisor pid survives the round trip')
    check(read.lastAction === 'stop', 'last action survives the round trip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
check(normalizeDaemonRuntime({ state: 'exploded' }).state === 'unknown', 'unknown state string is rejected')
check(normalizeDaemonRuntime({ state: 'exited' }).state === 'exited', 'valid state string is kept')

console.log(`dsh-gateway-agent daemon-config: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
