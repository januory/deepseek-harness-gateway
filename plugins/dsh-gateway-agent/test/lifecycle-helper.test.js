// Framework-less tests for the shipped dsh lifecycle helpers.
// Run: node test/lifecycle-helper.test.js
//
// The POSIX helper is exercised with a CONTROLLED listener on a random port, not
// against a real dsh: `stop` must only ever signal the pids it found at the
// start, so this also proves the port probe wins over the command-line fallback.

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const shHelper = fileURLToPath(new URL('../service/dsh-lifecycle.sh', import.meta.url))
const psHelper = fileURLToPath(new URL('../service/dsh-lifecycle.ps1', import.meta.url))
const launchdInstaller = fileURLToPath(new URL('../service/install-supervisor-launchd.sh', import.meta.url))
const taskInstaller = fileURLToPath(new URL('../service/install-supervisor-task.ps1', import.meta.url))

let passed = 0
let failed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    failed++
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

function runHelper(args) {
  return spawnSync('sh', [shHelper, ...args], { encoding: 'utf8', timeout: 20_000 })
}

const shSrc = readFileSync(shHelper, 'utf8')
const psSrc = readFileSync(psHelper, 'utf8')
const launchdSrc = readFileSync(launchdInstaller, 'utf8')
const taskSrc = readFileSync(taskInstaller, 'utf8')

// The headers explain WHY the old one-liners are wrong, so they name the very
// commands the code must not run. Assert against executable lines only.
function codeOf(src) {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}
const shCode = codeOf(shSrc)
const taskCode = codeOf(taskSrc)

// ---- POSIX helper: static guarantees ----------------------------------------
check(!/\bpkill\b/.test(shCode), 'POSIX helper never uses pkill')
check(!/\bpgrep\b/.test(shCode), 'POSIX helper never probes with pgrep')
check(shSrc.includes('lsof') && shSrc.includes('ss'), 'POSIX helper identifies dsh by the listening port')
check(/dsh-gateway-agent\*daemon\.js/.test(shSrc), 'POSIX helper excludes the supervisor process')
check(shSrc.includes('--no-open'), 'POSIX start suppresses the browser handoff')
check(shSrc.includes('apps/cli/src/bin.ts'), 'POSIX start can fall back to a source checkout')
check(shSrc.includes('--import tsx/esm'), 'the checkout fallback mirrors the dev launch command')
check(/dsh\s*web/.test(shSrc) && shSrc.includes('bin\\.ts'), 'POSIX fallback matches both the CLI and the checkout form')
check(/for pid in \$pids/.test(shSrc), 'POSIX stop freezes its pid set instead of re-discovering mid-wait')

// ---- POSIX helper: argument validation is safe to run ----------------------
{
  const badAction = runHelper(['bogus', '3080'])
  check(badAction.status === 2, 'an unknown action exits 2')
  const badPort = runHelper(['status', '3080; rm -rf /'])
  check(badPort.status === 2, 'a non-numeric port is rejected before any command runs')
  check((badPort.stderr || '').includes('invalid port'), 'the invalid port is named on stderr')
}

// ---- POSIX helper: port probe / stop against a controlled listener ----------
function lsofPid(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  return (r.stdout || '').trim().split('\n').filter(Boolean)[0] || ''
}

async function stopRoundTrip() {
  if (process.platform === 'win32') return // the POSIX helper is not for Windows
  const lsof = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' })
  if (lsof.status !== 0) {
    console.log('skip: lsof unavailable, cannot isolate a controlled listener')
    return
  }
  const port = 32000 + Math.floor(Math.random() * 20000)
  const server = spawn(
    process.execPath,
    ['-e', `require('http').createServer((_,res)=>res.end('ok')).listen(${port}, '127.0.0.1')`],
    { stdio: 'ignore' },
  )
  try {
    // Wait for the listener, then PROVE lsof sees it: without that proof the
    // helper would fall back to a machine-wide command-line scan.
    const deadline = Date.now() + 5_000
    let pid = ''
    while (Date.now() < deadline) {
      pid = lsofPid(port)
      if (pid) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!pid) {
      console.log('skip: could not bind a controlled listener')
      return
    }
    const status = runHelper(['status', String(port)])
    check(status.status === 0, 'status reports running for a listener on the port')
    check((status.stdout || '').includes(pid), 'status names the listening pid')

    const stop = runHelper(['stop', String(port)])
    check(stop.status === 0, 'stop exits 0 for a listener on the port')
    check((stop.stdout || '').includes(`stopping pid=${pid}`), 'stop signals exactly the listening pid')
    await new Promise((r) => setTimeout(r, 500))
    check(!lsofPid(port), 'the controlled listener is gone after stop')
  } finally {
    try {
      server.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

// ---- Windows helper: no visible console, no browser -------------------------
check(psSrc.includes('wscript.exe') && psSrc.includes('start-dsh-hidden.vbs'), 'Windows start goes through the windowless wscript host')
// Every dsh start path we ship must suppress the default-browser handoff. The
// gateway server itself has no browser code; `dsh web` is what opens one.
const clientSrc = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
check(clientSrc.includes('dsh web --no-open --port {port}'), 'the child-command placeholder passes --no-open')
check(!/placeholder: 'dsh web --port \{port\}'/.test(clientSrc), 'no shipped dsh start hint omits --no-open')
check(psSrc.includes(', 0, False'), 'Windows launcher uses window style 0 (hidden)')
check(psSrc.includes('--no-open'), 'Windows start suppresses the browser handoff')
check(psSrc.includes('apps\\cli\\src\\bin.ts'), 'Windows start can fall back to a source checkout')
check(psSrc.includes('--import tsx/esm'), 'the Windows checkout fallback mirrors the dev launch command')
check(!/CommandLine\s*=\s*"cmd \/c dsh web/.test(psSrc), 'Windows never hands a bare `cmd /c dsh web` to WMI (that allocates a visible console)')
check(taskSrc.includes('supervisor-hidden.vbs') && taskSrc.includes(', 0, True'), 'the task fallback runs through a windowless waiting launcher')
check(!taskCode.includes('-WindowStyle Hidden'), 'the task fallback no longer flashes a PowerShell window')

// ---- macOS installer: absolute paths, no env lookup ------------------------
check(launchdSrc.includes('ProgramArguments') && launchdSrc.includes('$node_bin'), 'launchd installer writes an absolute node path')
check(launchdSrc.includes('launchctl bootstrap') && launchdSrc.includes('launchctl bootout'), 'launchd installer uses the supported launchctl API')
check(launchdSrc.includes('<key>PATH</key>'), 'launchd installer records a PATH the lifecycle helper can use')

await stopRoundTrip()

console.log(`lifecycle-helper: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
