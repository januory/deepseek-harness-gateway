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

console.log(`dsh-gateway-agent daemon: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
