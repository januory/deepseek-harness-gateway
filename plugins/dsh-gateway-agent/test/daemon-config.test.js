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
check(posix.autoRevive === false, 'auto-revive defaults to off (stop means stopped)')
check(posix.scripts.start.includes('{port}'), 'default start script carries the {port} placeholder')
check(defaultScripts('win32').shell === 'cmd', 'windows defaults use cmd')
// Windows must NOT kill by image name: on a checkout install there is no
// dsh.exe, and a name-based kill could hit the supervisor's own node process.
const winScripts = defaultScripts('win32')
check(!winScripts.stop.includes('taskkill'), 'windows stop default never kills by image name')
check(winScripts.stop.includes('dsh-lifecycle.ps1'), 'windows stop default goes through the shipped helper')
check(winScripts.status.includes('dsh-lifecycle.ps1'), 'windows status default goes through the shipped helper')
check(winScripts.start.includes('{port}'), 'windows start default carries the {port} placeholder')
check(defaultScripts('linux').stop.includes('pkill'), 'posix stop default uses pkill')

// ---- round trip -------------------------------------------------------------
{
  const dir = scratch()
  try {
    writeDaemonConfig(dir, {
      enabled: true,
      autoRevive: true,
      stopTimeoutMs: 5000,
      scripts: { start: 'echo start', stop: 'echo stop', restart: '', status: '' },
      child: { command: 'dsh web --port {port}', cwd: '/tmp', env: { A: '1', B: 2 } },
    })
    const read = readDaemonConfig(dir)
    check(read.enabled === true, 'enabled survives the round trip')
    check(read.autoRevive === true, 'autoRevive survives the round trip')
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
