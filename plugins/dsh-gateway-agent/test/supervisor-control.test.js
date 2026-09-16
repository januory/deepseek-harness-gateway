// Framework-less tests for the plugin-side supervisor control that "保存守护设置"
// uses. The start/stop round trip spawns the REAL daemon.js (with a temp DSH_HOME and
// no gateway configured, so it just idles), so it also proves the detached spawn works.
// Run: node test/supervisor-control.test.js

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  SUPERVISOR_ENTRY,
  applySupervision,
  isOurSupervisor,
  knownSupervisorPid,
  startSupervisor,
  stopSupervisor,
  supervisorRunning,
} from '../src/supervisor-control.js'
import { writeDaemonConfig } from '../src/daemon-config.js'

const WIN = process.platform === 'win32'

let passed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

/** A DSH_HOME-shaped temp tree: the plugin's config dir is <home>/dsh-gateway-agent. */
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dshgw-sc-home-'))
  const dir = join(home, 'dsh-gateway-agent')
  mkdirSync(dir, { recursive: true })
  return { home, dir }
}

// ---- identity ---------------------------------------------------------------
check((await isOurSupervisor(process.pid)) === false, 'the test process itself is not the supervisor')
check((await isOurSupervisor(0)) === false, 'pid 0 is never the supervisor')
{
  const { home, dir } = tempHome()
  check(knownSupervisorPid(dir) === null, 'no daemon-state.json ⇒ no known supervisor pid')
  rmSync(home, { recursive: true, force: true })
}

// ---- nothing to stop --------------------------------------------------------
{
  const { home, dir } = tempHome()
  const res = await stopSupervisor(dir)
  check(res.action === 'not-running', 'stop with no supervisor reports not-running')
  rmSync(home, { recursive: true, force: true })
}

// ---- a foreign pid is refused, never killed ---------------------------------
{
  const { home, dir } = tempHome()
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  try {
    writeFileSync(join(dir, 'daemon-state.json'), JSON.stringify({ state: 'running', supervisorPid: decoy.pid }))
    const res = await stopSupervisor(dir)
    check(res.action === 'refused', 'a pid whose command line is not our supervisor is refused')
    check(decoy.exitCode === null, 'the foreign process is still alive')
  } finally {
    decoy.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
}

// ---- start / already-running / stop ----------------------------------------
if (WIN) {
  console.log('dsh-gateway-agent supervisor-control: start/stop checks skipped on win32')
} else {
  const { home, dir } = tempHome()
  try {
    writeDaemonConfig(dir, {
      enabled: true,
      scripts: { shell: 'sh', start: '', stop: '', restart: '', status: '' },
    })
    check(SUPERVISOR_ENTRY.endsWith('daemon.js'), 'the supervisor entry points at daemon.js')

    const started = await startSupervisor(dir)
    check(started.ok === true && started.action === 'started', `startSupervisor spawns a detached supervisor (${started.action})`)
    check((await supervisorRunning(dir)) === true, 'the spawned process is recognised as our supervisor')

    const again = await startSupervisor(dir)
    check(again.action === 'already-running', 'a second save does not spawn a duplicate supervisor')

    const stopped = await applySupervision(dir, false)
    check(stopped.action === 'stopped', `applySupervision(false) stops it (${stopped.action})`)
    check((await supervisorRunning(dir)) === false, 'no supervisor process is left behind')
  } finally {
    await applySupervision(dir, false)
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(`dsh-gateway-agent supervisor-control: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
