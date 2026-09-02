// Framework-less tests for reconnect backoff policy.
// Run: node test/backoff.test.js

import { nextBackoff, backoffDelay } from '../src/backoff.js'

let passed = 0
function check(cond, msg) {
  if (cond) {
    passed++
  } else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

check(nextBackoff(1000, 30000) === 2000, 'backoff doubles')
check(nextBackoff(16000, 30000) === 30000, 'backoff caps at max')
check(nextBackoff(30000, 30000) === 30000, 'backoff stays at max')

let b = 1000
const seq = []
for (let i = 0; i < 6; i++) {
  b = nextBackoff(b, 30000)
  seq.push(b)
}
check(JSON.stringify(seq) === JSON.stringify([2000, 4000, 8000, 16000, 30000, 30000]), 'sequence doubles then caps')

check(backoffDelay(1000, 30000, () => 0) === 1000, 'min delay = current backoff')
check(backoffDelay(1000, 30000, () => 0.999999) === 1500, 'max jitter = +500ms')
check(backoffDelay(90000, 30000, () => 0) === 30000, 'delay capped at max')
check(backoffDelay(1000, 30000, () => 0, 0) === 1000, 'jitterMs=0 disables jitter')

console.log(`dsh-gateway-agent backoff: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
