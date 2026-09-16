// Host-side typert contract guard.
//
// DSH's typert registry validates a strict codec through `create()` (returning
// a schema whose `parse` runs at the boundary) after schemas became lazily
// materialized; hosts before that read `schema` directly. Both halves declare a
// strict JSON codec by hand (no generated artifacts), so a regression here
// breaks mounting with:
//   typert: gatewayAgent/status result strict codec has no create() factory
// This test drives the REAL apply() with a stub ctx, captures the contribution
// handed to typert.register(), and asserts the codec satisfies both host
// generations. The client half is guarded by iife-isolation.mjs.
// Run: node test/typert-codec.test.js

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dshgw-typert-codec-'))
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

let contribution = null
const typert = {
  register(value) {
    contribution = value
    return () => {}
  },
}
const ctx = {
  provide() {},
  inject(deps, cb) {
    if (deps.includes('typert')) return cb({ get: () => typert })
    if (deps.includes('connection')) return cb({ get: () => undefined })
    return () => {}
  },
}

mod.default(ctx)

check(contribution !== null, 'apply() registers a typert contribution')
check(contribution.package === '@januory/dsh-gateway-agent', 'contribution carries the scoped package name')
check(contribution.face === 'host', 'contribution declares the host face')

const descriptors = contribution.invocations
check(descriptors.length >= 6, 'contribution declares the full invocation list')

function codecsOf(descriptor) {
  const codecs = [{ subject: `${descriptor.id} result`, codec: descriptor.result }]
  for (const parameter of descriptor.parameters) {
    codecs.push({ subject: `${descriptor.id} parameter ${parameter.name}`, codec: parameter.codec })
  }
  return codecs
}

for (const descriptor of descriptors) {
  for (const { subject, codec } of codecsOf(descriptor)) {
    // New host generation: `create()` must be a factory returning a schema.
    check(typeof codec.create === 'function', `${subject} strict codec exposes create()`)
    const schema = typeof codec.create === 'function' ? codec.create() : undefined
    check(schema !== null && typeof schema === 'object' && typeof schema.parse === 'function',
      `${subject} create() returns a schema with parse()`)
    check(typeof codec.schema === 'object' && codec.schema !== null && typeof codec.schema.parse === 'function',
      `${subject} keeps the legacy schema for older hosts`)
    // The codec is identity JSON: parse must not mangle a JSON value.
    if (schema && typeof schema.parse === 'function') {
      const value = { ok: true, nested: [1, 'two', null] }
      check(schema.parse(value) === value, `${subject} parse() is identity JSON`)
    }
    check(codec.mode === 'strict', `${subject} stays a strict codec (client mount requires it)`)
    check(codec.typeSymbol === 'JsonValue', `${subject} declares the JsonValue type symbol`)
  }
}

console.log(`${passed} checks passed`)
