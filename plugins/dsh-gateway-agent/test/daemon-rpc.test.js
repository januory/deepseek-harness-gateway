// Host-side daemon RPC seam: what the settings card actually calls.
//
// `apply()` is invoked with a stub ctx that captures the provided service, so
// this exercises the REAL wiring (service methods, INVOCATIONS contract, shared
// daemon.json writes) without a dsh host. No gateway connection is attempted
// because the config has no gatewayUrl.
// Run: node test/daemon-rpc.test.js

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dshgw-daemon-rpc-'))
process.env.DSH_HOME = scratch

let passed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

const mod = await import('../src/index.js')

// Stub ctx: capture what apply() provides and drive the 'connection' inject arm.
let service = null
const provided = {}
const ctx = {
  provide(key, value) {
    provided[key] = value
    if (key === 'gatewayAgent') service = value
  },
  inject(deps, cb) {
    if (deps.includes('typert')) return () => {}
    if (deps.includes('connection')) {
      // No connection service available: the plugin logs and skips connect.
      cb({ get: () => undefined })
      return () => {}
    }
    return () => {}
  },
}

mod.default(ctx)
check(!!service, 'apply() provides the gatewayAgent service')

// ---- the remote contract the browser half mirrors -----------------------------
// src/index.js and src/client.js each hold a verbatim copy of the invocation
// list (the header says "must match"): drift means the settings card gets
// "远程方法 X 不可用" at runtime. Parse both and compare.
function invocationNames(source) {
  const names = new Set()
  for (const m of source.matchAll(/invocation\(\s*'([A-Za-z0-9_]+)'/g)) names.add(m[1])
  return [...names].sort()
}

const hostSrc = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const clientSrc = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const hostInvocations = invocationNames(hostSrc)
const clientInvocations = invocationNames(clientSrc)
check(hostInvocations.length >= 6, 'host declares the full invocation list')
check(
  hostInvocations.join(',') === clientInvocations.join(','),
  `host and client invocation lists match (host=${hostInvocations.join('|')} client=${clientInvocations.join('|')})`,
)
check(hostInvocations.includes('saveDaemonConfig'), 'saveDaemonConfig is in the shared contract')
check(hostInvocations.includes('getDaemonConfig'), 'getDaemonConfig is in the shared contract')

// Every method the client calls must exist on the service.
for (const method of ['status', 'getConfig', 'applyConfig', 'onboard', 'getDaemonConfig', 'saveDaemonConfig']) {
  check(typeof service[method] === 'function', `service exposes ${method}()`)
}

// ---- getDaemonConfig ---------------------------------------------------------
const initial = await service.getDaemonConfig()
check(initial.ok === true, 'getDaemonConfig returns an ok envelope')
check(initial.enabled === false, 'daemon supervision starts disabled')
check(typeof initial.supervisorCommand === 'string' && initial.supervisorCommand.includes('daemon.js'), 'supervisor command names daemon.js')
check(initial.config && initial.config.scripts, 'getDaemonConfig carries the script defaults')
check(initial.config.scripts.start.length > 0, 'a default start script is present')
check(initial.config.autoRevive === false, 'auto-revive defaults to off')

// ---- saveDaemonConfig: enable + first script ---------------------------------
const enabled = await service.saveDaemonConfig({ enabled: true, scripts: { start: 'dsh web --port {port}' } })
check(enabled.ok === true && enabled.saved === true, 'saveDaemonConfig reports ok/saved')
check(enabled.enabled === true, 'the saved config reports enabled')
check(enabled.config.scripts.start === 'dsh web --port {port}', 'the edited start script is stored')
check(enabled.config.scripts.stop.length > 0, 'untouched stop script survives the partial patch')

// ---- saveDaemonConfig: a second partial patch must not wipe earlier fields ---
const second = await service.saveDaemonConfig({ child: { command: 'node dsh.js' } })
check(second.config.scripts.start === 'dsh web --port {port}', 'a child-only patch keeps the start script')
check(second.config.child.command === 'node dsh.js', 'the child command is stored')
check(second.enabled === true, 'enabled survives a patch that omits it')

// ---- the file the standalone supervisor reads --------------------------------
const onDisk = JSON.parse(readFileSync(join(scratch, 'dsh-gateway-agent', 'daemon.json'), 'utf8'))
check(onDisk.enabled === true, 'daemon.json on disk is enabled')
check(onDisk.scripts.start === 'dsh web --port {port}', 'daemon.json on disk has the edited start script')
check(onDisk.child.command === 'node dsh.js', 'daemon.json on disk has the child command')

// ---- status() carries the daemon snapshot for the settings card ---------------
const status = await service.status()
check(status.ok === true, 'status returns an ok envelope')
check(status.daemon && typeof status.daemon === 'object', 'status includes the daemon snapshot')
check(status.daemon.enabled === true, 'the daemon snapshot reflects the saved enabled flag')
check(status.daemon.state && status.daemon.state.state, 'the daemon snapshot carries a runtime state')

// ---- disabling ---------------------------------------------------------------
const off = await service.saveDaemonConfig({ enabled: false })
check(off.enabled === false, 'supervision can be switched back off')
check(off.config.scripts.start === 'dsh web --port {port}', 'disabling does not drop the scripts')

rmSync(scratch, { recursive: true, force: true })
console.log(`dsh-gateway-agent daemon-rpc: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
