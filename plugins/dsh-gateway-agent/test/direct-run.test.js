// The entry guard must survive a linked install.
//
// A pnpm `link:` dependency points node_modules/<pkg> at the local plugin
// checkout, so `node <link>/src/daemon.js` gets a junction path in argv[1] while
// Node resolves import.meta.url to the real file. Comparing them raw made
// main() never run: the process exited 0 with no output at all, which is how a
// linked install turned the supervisor into a silent no-op.
//
// Run: node test/direct-run.test.js
import { spawn } from 'node:child_process'
import { mkdtempSync, rmdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'dshgw-link-'))
const linkRoot = join(home, 'linked-plugin')

try {
  // A directory symlink/junction needs no elevation on Windows; a file symlink
  // does, so the link points at the plugin directory and the entry is reached
  // through it.
  symlinkSync(pluginDir, linkRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const entry = join(linkRoot, 'src', 'daemon.js')

  const child = spawn(process.execPath, [entry], {
    // An isolated home: the supervisor must not touch the machine's own state.
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (err += c))
  await new Promise((resolve) => setTimeout(resolve, 6000))
  try {
    child.kill()
  } catch {
    /* already gone */
  }

  check(
    /dsh-gateway-agent supervisor \d/.test(out),
    'an entry reached through a link/junction still runs main() and logs its startup line',
  )
  check(out.includes('enabled='), 'the startup line carries the daemon config it read')
  check(err.trim() === '', `the linked entry logs no error (got: ${JSON.stringify(err.slice(0, 200))})`)
} finally {
  // rmdirSync removes the junction itself and can never recurse into the plugin.
  try {
    rmdirSync(linkRoot)
  } catch {
    /* best effort */
  }
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* temp litter only */
  }
}

console.log(`dsh-gateway-agent direct-run: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
