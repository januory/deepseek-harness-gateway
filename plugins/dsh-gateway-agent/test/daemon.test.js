// Framework-less tests for the supervisor's command helpers. Importing daemon.js
// must NOT start the supervisor — that guard is covered here too.
//
// NOTE: `exit N` in a POSIX shell terminates the shell instead of recording an
// exit status (the child never reports a code we can assert on), so the
// non-zero path is exercised through a command that really fails.
// Run: node test/daemon.test.js

import { expandCommand, splitCommand, runScript, probeRunning, Supervisor } from '../src/daemon.js'

const WIN = process.platform === 'win32'
const SHELL = WIN ? 'cmd' : 'sh'

let passed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

// ---- import guard ------------------------------------------------------------
check(typeof Supervisor === 'function', 'daemon.js exports Supervisor without auto-starting')
check(typeof globalThis.__supervisorStarted === 'undefined', 'importing daemon.js did not run the entry point')

// ---- expandCommand -----------------------------------------------------------
check(expandCommand('dsh web --port {port}', { port: 3080 }) === 'dsh web --port 3080', 'substitutes {port}')
check(expandCommand('cd {home} && dsh', { home: '/home/u/.dsh' }) === 'cd /home/u/.dsh && dsh', 'substitutes {home}')
check(expandCommand('echo {nope}', { port: 1 }) === 'echo {nope}', 'unknown placeholder is left untouched')

// ---- splitCommand ------------------------------------------------------------
check(splitCommand('dsh web --port 3080').join('|') === 'dsh|web|--port|3080', 'splits on whitespace')
check(splitCommand('"C:\\Program Files\\dsh\\dsh.exe" web')[0] === 'C:\\Program Files\\dsh\\dsh.exe', 'keeps a quoted Windows path')
check(splitCommand("'/opt/my dsh/dsh' web")[0] === '/opt/my dsh/dsh', 'keeps a quoted POSIX path')
check(splitCommand('  a   b  ').join('|') === 'a|b', 'collapses repeated whitespace')
check(splitCommand('').length === 0, 'empty command yields no argv')

// ---- runScript / probeRunning -------------------------------------------------
const ok = await runScript('echo supervisor-ok', SHELL)
check(ok.code === 0, 'a successful script reports exit 0')
check(ok.stdout.includes('supervisor-ok'), 'a successful script captures stdout')

const bad = await runScript('this-command-does-not-exist-xyz', SHELL)
check(bad.code !== 0, 'a failing script reports a non-zero code instead of throwing')

const empty = await runScript('', SHELL)
check(empty.skipped === true && empty.code === 0, 'an empty script is skipped, not spawned')

check((await probeRunning({ status: '' }, {}, undefined)) === null, 'no probe configured yields null')
check((await probeRunning({}, {}, undefined)) === null, 'missing probe config yields null')
check((await probeRunning({ shell: SHELL, status: 'echo up' }, {}, undefined)) === true, 'a probe that succeeds means running')
check((await probeRunning({ shell: SHELL, status: 'this-command-does-not-exist-xyz' }, {}, undefined)) === false, 'a probe that fails means not running')

// Windows: the cmd layer must not re-escape the quotes inside a configured
// script. The shipped Windows defaults wrap the helper path in quotes, and the
// old spawn(cmd, ['/d','/s','/c', script]) turned that into `\"C:\...\"`, which
// cmd does not unescape: `powershell -File` then failed with "invalid characters
// in path", so status/start/stop all failed on a plain Windows install. The temp
// dir deliberately contains a space.
if (WIN) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshgw quote test-'))
  const probe = join(dir, 'probe.ps1')
  writeFileSync(probe, 'Write-Output quoted-ok\r\n')
  const quoted = await runScript(`powershell -NoProfile -ExecutionPolicy Bypass -File "${probe}"`, SHELL)
  check(quoted.code === 0 && quoted.stdout.includes('quoted-ok'), 'cmd: a quoted -File path survives the cmd layer')
  rmSync(dir, { recursive: true, force: true })
}
// ---- start() never duplicates a dsh that is already up ----------------------
// The probe is the arbiter: a hand-started dsh (or one this supervisor no longer
// owns) must make start() answer `running` instead of spawning a second instance
// that can only lose the port race.
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { writeDaemonConfig } = await import('../src/daemon-config.js')
  const quiet = { info() {}, error() {}, warn() {} }
  const dir = mkdtempSync(join(tmpdir(), 'dshgw-already-up-'))
  writeDaemonConfig(dir, {
    enabled: true,
    child: { command: `${process.execPath} -e "setTimeout(() => {}, 30000)"`, cwd: dir, env: {} },
    // Always succeeds: "dsh is up, in someone else's hands".
    scripts: { shell: SHELL, start: '', stop: '', restart: '', status: 'node -e "process.exit(0)"' },
  })
  const sup = new Supervisor({ dir, store: { read: () => ({ dshPort: 3998 }) }, logger: quiet })
  const state = await sup.start()
  check(state === 'running', 'start() answers `running` when the probe says dsh is already up')
  check(sup.child === null, 'start() must not duplicate a hand-started dsh')
  rmSync(dir, { recursive: true, force: true })
}
// ---- readiness: spawned ≠ ready -------------------------------------------------
// `start` must not answer `running` while dsh is still booting: the portal would
// then offer a console whose first request answers
// {"error":"relay failed","detail":"node not connected"}.
if (WIN) {
  console.log('dsh-gateway-agent daemon: readiness checks skipped on win32')
} else {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { writeDaemonConfig } = await import('../src/daemon-config.js')
  const quiet = { info() {}, error() {}, warn() {} }
  const dir = mkdtempSync(join(tmpdir(), 'dshgw-readiness-'))
  const sentinel = join(dir, 'up')
  const probe = `node -e "process.exit(require('fs').existsSync('${sentinel}')?0:1)"`
  const store = { read: () => ({ dshPort: 3999 }) }
  const scripts = { shell: SHELL, start: '', stop: '', restart: '', status: probe }

  // (1) live child + a probe that turns true ⇒ starting, then running.
  writeDaemonConfig(dir, {
    enabled: true,
    child: { command: 'node -e "setTimeout(()=>{}, 8000)"', cwd: dir, env: {} },
    scripts,
  })
  const sup = new Supervisor({ dir, store, logger: quiet })
  const first = await sup.start()
  check(first === 'starting', 'start() answers `starting`, not `running`, right after spawning')
  setTimeout(() => writeFileSync(sentinel, 'up'), 300)
  await new Promise((r) => setTimeout(r, 1_200))
  check(sup.state === 'running', 'state flips to `running` once the readiness probe passes')
  await sup.stop()
  check(sup.state === 'stopped', 'stop() reports `stopped` after the child exits')

  // (2) child that dies at once ⇒ exited, never a false `running`.
  // A *fresh* sentinel: `start()` now asks the probe first and answers `running`
  // when dsh is already up, so reusing the (already true) sentinel from (1) would
  // short-circuit before the child is ever spawned.
  const sentinel2 = join(dir, 'up-2')
  writeDaemonConfig(dir, {
    enabled: true,
    child: { command: 'node -e "process.exit(3)"', cwd: dir, env: {} },
    scripts: Object.assign({}, scripts, {
      status: `node -e "process.exit(require('fs').existsSync('${sentinel2}')?0:1)"`,
    }),
  })
  const sup2 = new Supervisor({ dir, store, logger: quiet })
  const second = await sup2.start()
  check(second === 'starting', 'start() is still `starting` for a child that dies immediately')
  await new Promise((r) => setTimeout(r, 900))
  check(sup2.state === 'exited', 'a child that dies during startup ends in `exited`, not `running`')
  rmSync(dir, { recursive: true, force: true })
}

console.log(`dsh-gateway-agent daemon: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
