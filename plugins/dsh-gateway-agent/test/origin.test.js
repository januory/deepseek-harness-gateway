// Framework-less tests for the relay's loopback same-origin normalization.
// Run: node test/origin.test.js

import { loopbackAuthority, loopbackOrigin, loopbackSameOriginHeaders } from '../src/origin.js'

let passed = 0
function check(cond, msg) {
  if (cond) {
    passed++
  } else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

check(loopbackAuthority(3080) === '127.0.0.1:3080', 'authority is host:port')
check(loopbackOrigin(3080) === 'http://127.0.0.1:3080', 'origin is the http form of the authority')
check(loopbackOrigin(4000) === 'http://127.0.0.1:4000', 'origin follows the configured port')

// The exact shape the gateway relays: Host rewritten, every browser marker
// stripped. dshmarket answered this with 403 untrusted origin.
const markerless = loopbackSameOriginHeaders({ 'user-agent': 'Mozilla/5.0', accept: '*/*' }, 3080)
check(markerless.host === '127.0.0.1:3080', 'markerless request gets the loopback Host')
check(markerless.origin === 'http://127.0.0.1:3080', 'markerless request gets a matching Origin')
check(markerless.referer === undefined, 'no Referer is invented')
check(markerless['user-agent'] === 'Mozilla/5.0', 'unrelated headers survive')

const relayed = loopbackSameOriginHeaders(
  {
    host: 'gw.example:3300',
    origin: 'https://gw.example:3300',
    referer: 'https://gw.example:3300/console/m1/settings?tab=market',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    cookie: 'gw=1',
  },
  3080,
)
check(relayed.host === '127.0.0.1:3080', 'public Host is replaced')
check(relayed.origin === 'http://127.0.0.1:3080', 'public Origin is replaced by the same authority as Host')
check(relayed.referer === 'http://127.0.0.1:3080/console/m1/settings?tab=market', 'Referer keeps its path and query on the loopback authority')
check(relayed['sec-fetch-site'] === 'same-origin', 'Fetch-Metadata passes through untouched')
check(relayed.cookie === 'gw=1', 'the agent-owned cookie slot is left to the caller')

// A cross-site marker must still reach dsh's fence (which refuses it) rather
// than be silently rewritten into a same-origin claim.
const crossSite = loopbackSameOriginHeaders({ 'sec-fetch-site': 'cross-site' }, 3080)
check(crossSite['sec-fetch-site'] === 'cross-site', 'a cross-site marker is not laundered')

check(loopbackSameOriginHeaders({ referer: 'not a url' }, 3080).referer === undefined, 'an unparsable Referer is dropped')
check(loopbackSameOriginHeaders({ referer: 'https://gw.example/x' }, 3080).referer === 'http://127.0.0.1:3080/x', 'a Referer without a query keeps its path')
check(loopbackSameOriginHeaders(undefined, 3080).host === '127.0.0.1:3080', 'a missing header map is tolerated')
check(loopbackSameOriginHeaders({}, 3080).origin === 'http://127.0.0.1:3080', 'an empty header map still gets Host and Origin')

// Wire headers can arrive in any case; the helper must collapse them instead
// of emitting both spellings to the upstream request.
const mixed = loopbackSameOriginHeaders({ Host: 'gw.example', Origin: 'https://gw.example', Referer: 'https://gw.example/a' }, 3080)
const names = Object.keys(mixed)
check(names.filter((n) => n === 'host').length === 1 && names.filter((n) => n === 'origin').length === 1 && names.filter((n) => n === 'referer').length === 1, 'case variants collapse to one lowercase header each')
check(mixed.origin === 'http://127.0.0.1:3080' && mixed.referer === 'http://127.0.0.1:3080/a', 'case variants are rewritten, not passed through')

const input = { host: 'gw.example', origin: 'https://gw.example' }
loopbackSameOriginHeaders(input, 3080)
check(input.origin === 'https://gw.example' && input.host === 'gw.example', 'the input header map is not mutated')

console.log(`dsh-gateway-agent origin: ${passed} checks passed`)
if (process.exitCode) process.exit(process.exitCode)
