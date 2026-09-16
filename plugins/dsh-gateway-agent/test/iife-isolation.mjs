// Simulate the classic-script concatenation: remote-workspaces is loaded AFTER
// dsh-gateway-agent in the bundle, so its top-level `var NAMESPACE` would
// overwrite ours — unless our client.js isolates them in an IIFE.
import { readFileSync } from 'node:fs'

const regs = []
globalThis.window = { __ModuleLoader__: { load: (r) => regs.push(r) } }

// remote-workspaces stub (top-level vars, wins the shared scope).
var PACKAGE = 'remote-workspaces'
var NAMESPACE = 'remoteWorkspaces'
var INVOCATIONS = [{ method: 'listMachines', namespace: 'remoteWorkspaces' }]

// dsh-gateway-agent client.js (IIFE-wrapped) — evaluated in the SAME scope.
const code = readFileSync('./src/client.js', 'utf8')
new Function('window', code)(globalThis.window)

console.log('global NAMESPACE still =', NAMESPACE, '(should be remoteWorkspaces — our IIFE did not leak)')

const myReg = regs.find((r) => r.id === '@januory/dsh-gateway-agent')
if (!myReg) {
  console.log('FAIL: no @januory/dsh-gateway-agent registration')
  process.exit(1)
}

let mountArg = null
const ctx = {
  remote: { $mount: (arg) => { mountArg = arg; return Promise.resolve(() => {}) } },
  get: (key) => key,
  slots: { inject: (_n, cb) => cb(), register: (_m, _f) => ({}) },
}

const mod = myReg.factory((spec) => {
  if (spec === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }
  throw new Error('unexpected require ' + spec)
})
mod.apply(ctx)

console.log('$mount package =', mountArg.package, '(should be @januory/dsh-gateway-agent)')
console.log('$mount namespace =', mountArg.descriptors[0].namespace, '(should be gatewayAgent)')
console.log('$mount method[0] =', mountArg.descriptors[0].method, '(should be status)')

// Codec guard: $mount validates descriptors client-side, and a strict codec
// without create() fails with "strict codec has no create() factory" (the
// settings card then shows "Remote 命名空间挂载失败"). Every captured codec must
// satisfy the current host contract and keep the legacy `schema` field.
let codecsOk = true
for (const descriptor of mountArg.descriptors) {
  const codecs = [descriptor.result, ...descriptor.parameters.map((p) => p.codec)]
  for (const codec of codecs) {
    const schema = typeof codec.create === 'function' ? codec.create() : null
    if (
      codec.mode !== 'strict' ||
      typeof codec.create !== 'function' ||
      !schema || typeof schema.parse !== 'function' ||
      typeof codec.schema?.parse !== 'function'
    ) {
      console.log('FAIL: codec is not mountable:', descriptor.method, JSON.stringify(Object.keys(codec)))
      codecsOk = false
    }
  }
}
console.log('codecs expose create():', codecsOk, '(should be true)')

const ok =
  mountArg.package === '@januory/dsh-gateway-agent' &&
  mountArg.descriptors[0].namespace === 'gatewayAgent' &&
  mountArg.descriptors[0].method === 'status' &&
  codecsOk
console.log(ok ? 'PASS: variables are correctly isolated' : 'FAIL: variables still collide')
process.exit(ok ? 0 : 1)
