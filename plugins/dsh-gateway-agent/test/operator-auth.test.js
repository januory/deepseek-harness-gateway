// Operator admission across dsh host generations.
//
// dsh ≥ 0.2.2-rc.2 removed BrowserAuth (`authenticatedUrl` / `authorizeIndex`)
// from the `connection` service; credentials are now providers registered on
// `connection.authentication`. Without a provider every relayed request gets
// 401 — the console "unauthorized" after a dsh update. This test drives the
// REAL apply() against a fake gateway and an echo upstream, once per host
// generation, and asserts the relayed HTTP request and WS upgrade carry
// exactly the credential the host admits (and that a browser-supplied copy of
// the operator header is overwritten, never trusted).
// Run: node test/operator-auth.test.js

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import {
  createOperatorCredential, credentialMatches, hasProviderApi, registerOperatorProvider, OPERATOR_HEADER,
} from '../src/operator-auth.js'
import { PROTOCOL_VERSION, ControlType, DataType, BinaryFrameParser } from '../src/protocol.js'

// Hard watchdog: a hung socket must fail the run, not stall CI.
setTimeout(() => { console.error('FAIL: global timeout'); process.exit(1) }, 30_000)

let passed = 0
function check(cond, msg) {
  if (cond) passed++
  else {
    console.error('FAIL: ' + msg)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Pure credential / provider checks
// ---------------------------------------------------------------------------
const cred = createOperatorCredential()
check(cred.header === OPERATOR_HEADER, 'credential carries the operator header name')
check(typeof cred.secret === 'string' && cred.secret.length >= 32, 'credential secret is a long random string')
check(createOperatorCredential().secret !== cred.secret, 'each activation mints a fresh secret')

check(credentialMatches({ [OPERATOR_HEADER]: cred.secret }, cred), 'lowercase record header matches')
check(credentialMatches({ 'X-Dsh-Gateway-Agent-Operator': cred.secret }, cred), 'header name is case-insensitive')
check(credentialMatches(new Headers({ [OPERATOR_HEADER]: cred.secret }), cred), 'Fetch Headers carrier matches')
check(credentialMatches({ [OPERATOR_HEADER]: [cred.secret] }, cred), 'single-value array header matches')
check(!credentialMatches({ [OPERATOR_HEADER]: [cred.secret, cred.secret] }, cred), 'repeated header is refused')
check(!credentialMatches({}, cred), 'missing header is refused')
check(!credentialMatches({ [OPERATOR_HEADER]: 'wrong' }, cred), 'wrong secret is refused')
check(!credentialMatches({ [OPERATOR_HEADER]: cred.secret.slice(0, -1) }, cred), 'truncated secret is refused')
check(!credentialMatches({ [OPERATOR_HEADER]: cred.secret + 'x' }, cred), 'overlong secret is refused')
check(!credentialMatches(undefined, cred), 'missing headers are refused')
check(!credentialMatches({ [OPERATOR_HEADER]: cred.secret }, null), 'no credential means no admission')

check(!hasProviderApi(null), 'no connection service → legacy path')
check(!hasProviderApi({ authenticatedUrl() {}, authorizeIndex() {} }), 'BrowserAuth-only host → legacy path')
check(!hasProviderApi({ createPeer() {}, authentication: {} }), 'host without register() → legacy path')
check(hasProviderApi({ createPeer() {}, authentication: { register() {} } }), 'provider host is detected')

{
  const peer = { id: 'peer-1' }
  let options = null
  let provider = null
  let disposed = false
  const connection = {
    createPeer(o) { options = o; return peer },
    authentication: { register(p) { provider = p; return () => { disposed = true } } },
  }
  const dispose = registerOperatorProvider(connection, cred)
  check(options && options.principal && options.principal.kind === 'owner', 'provider owns an owner Peer')
  check(provider.authenticate({ headers: { [OPERATOR_HEADER]: cred.secret } }) === peer, 'matching request returns the owned Peer')
  check(provider.authenticate({ headers: {} }) === undefined, 'non-matching request defers to the next provider')
  check(provider.authenticate(undefined) === undefined, 'a malformed request is refused, not thrown on')
  dispose()
  check(disposed, 'registration disposer is returned to the calling scope')
}

// ---------------------------------------------------------------------------
// Full relay loop against a fake gateway + echo upstream, per host generation
// ---------------------------------------------------------------------------
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function waitFor(what, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timeout waiting for ' + what)
}

/** Echo upstream standing in for the local dsh web: records headers, answers 200. */
async function startUpstream() {
  const seen = { http: null, ws: null }
  const server = http.createServer((req, res) => {
    seen.http = req.headers
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seen.ws = req.headers
    wss.handleUpgrade(req, socket, head, (ws) => { ws.on('message', (m) => ws.send(m)) })
  })
  const port = await listen(server)
  // Best-effort teardown: the relay keeps keep-alive/upgraded sockets open, so
  // drop them and let process.exit() reap the rest rather than await close().
  return { port, seen, close: () => { for (const c of wss.clients || []) c.terminate(); wss.close(); server.closeAllConnections(); server.close() } }
}

/** Fake gateway: completes the join handshake, then relays one HTTP request and one WS open. */
async function startGateway() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  const state = { socket: null, joined: false, responses: [], bodies: new Map(), ends: [], wsOk: [], parser: new BinaryFrameParser() }
  wss.on('connection', (socket) => {
    state.socket = socket
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: ControlType.CHALLENGE, payload: { nonce: 'n' } }))
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        for (const frame of state.parser.push(Buffer.from(raw))) {
          const chunks = state.bodies.get(frame.channel) || []
          chunks.push(frame.data)
          state.bodies.set(frame.channel, chunks)
        }
        return
      }
      const msg = JSON.parse(raw.toString('utf8'))
      if (msg.type === ControlType.CHALLENGE_RESPONSE) {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: ControlType.REGISTRATION_STATUS, payload: { state: 'approved', machineId: 'm-test' } }))
        state.joined = true
      } else if (msg.type === DataType.RELAY_RESPONSE) state.responses.push(msg.payload)
      else if (msg.type === DataType.RELAY_END) state.ends.push(msg.payload.channel)
      else if (msg.type === DataType.RELAY_WS_OPEN_OK) state.wsOk.push(msg.payload.channel)
    })
  })
  const send = (type, payload) => state.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload }))
  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    state,
    relay: (channel, path) => send(DataType.RELAY_REQUEST, {
      channel, method: 'GET', path, contentLength: 0,
      // Browser markers as the gateway relays them, plus a spoofed operator header.
      headers: { host: 'gw.example:3300', origin: 'https://gw.example:3300', cookie: 'gw=1', [OPERATOR_HEADER]: 'spoofed', 'X-Dsh-Gateway-Agent-Operator': 'spoofed-mixed' },
    }),
    // Mixed-case spoof included: the WS path must collapse it, not send both.
    relayWs: (channel, path) => send(DataType.RELAY_WS_OPEN, { channel, path, headers: { host: 'gw.example:3300', cookie: 'gw=1', [OPERATOR_HEADER]: 'spoofed', 'X-Dsh-Gateway-Agent-Operator': 'spoofed-mixed' } }),
    close: () => { for (const c of wss.clients) c.terminate(); wss.close() },
  }
}

/** Host stub whose inject() only fires when every declared service exists. */
function makeCtx(services) {
  const provided = {}
  return {
    provided,
    provide(name, service) { provided[name] = service },
    inject(deps, cb) {
      if (deps.includes('typert')) return cb({ get: () => ({ register: () => () => {} }) })
      if (deps.every((d) => services[d] !== undefined)) return cb({ get: (name) => services[name] })
      return () => {}
    },
  }
}

function newHostStub() {
  const host = { peer: null, provider: null, createPeerCalls: 0 }
  host.connection = {
    createPeer(options) { host.createPeerCalls++; host.peer = { id: 'owner-peer', principal: options.principal }; return host.peer },
    authentication: {
      register(provider) { host.provider = provider; return () => { host.provider = null } },
    },
  }
  return host
}

function legacyHostStub() {
  const host = { calls: [], cookie: 'dsh-auth-test=v1.signed' }
  host.connection = {
    authenticatedUrl(base) { host.calls.push(['authenticatedUrl', base]); return `${base}/?token=launch` },
    authorizeIndex(req, res) {
      host.calls.push(['authorizeIndex', req])
      res.writeHead(303, { 'set-cookie': `${host.cookie}; Path=/; HttpOnly` })
      res.end()
      return false
    },
  }
  return host
}

async function runGeneration(label, { host, services, expect }) {
  const home = mkdtempSync(join(tmpdir(), `dshgw-operator-auth-${label}-`))
  const upstream = await startUpstream()
  const gateway = await startGateway()
  mkdirSync(join(home, 'dsh-gateway-agent'), { recursive: true })
  writeFileSync(join(home, 'dsh-gateway-agent', 'config.json'), JSON.stringify({
    gatewayUrl: gateway.url, pairingCode: 'test', dshPort: upstream.port, machineName: 'test',
  }))
  process.env.DSH_HOME = home

  const { default: apply } = await import('../src/index.js')
  const ctx = makeCtx(services)
  apply(ctx)

  try {
    await waitFor('join', () => gateway.state.joined)
    const status = await ctx.provided.gatewayAgent.status()
    check(status.state === 'online', `${label}: agent joins the gateway`)
    check(status.authMode === expect.authMode, `${label}: status reports authMode=${expect.authMode}`)
    check(hasProviderApi(services.connection) === expect.provider, `${label}: host generation detected`)

    gateway.relay(7, '/probe')
    await waitFor('http relay', () => gateway.state.ends.includes(7))
    const response = gateway.state.responses.find((r) => r.channel === 7)
    check(response && response.status === 200, `${label}: relayed HTTP request is admitted (200, not 401)`)
    const body = Buffer.concat(gateway.state.bodies.get(7) || []).toString('utf8')
    check(body.includes('"path":"/probe"'), `${label}: upstream body is relayed back`)
    const sent = upstream.seen.http
    check(sent && sent.host === `127.0.0.1:${upstream.port}`, `${label}: Host is the loopback authority`)
    expect.admits(sent, `${label}: HTTP`)
    expect.credentials(sent, `${label}: HTTP`)

    gateway.relayWs(8, '/api/remote.mux')
    await waitFor('ws relay', () => gateway.state.wsOk.includes(8))
    const wsSent = upstream.seen.ws
    check(!!wsSent, `${label}: relayed WS upgrade reaches the upstream`)
    check(wsSent && wsSent.host === `127.0.0.1:${upstream.port}`, `${label}: WS Host is the loopback authority`)
    check(wsSent && wsSent.origin === `http://127.0.0.1:${upstream.port}`, `${label}: WS Origin matches Host`)
    expect.admits(wsSent, `${label}: WS`)
    expect.credentials(wsSent, `${label}: WS`)
  } finally {
    gateway.close()
    upstream.close()
  }
}

const newHost = newHostStub()
await runGeneration('provider', {
  host: newHost,
  services: { connection: newHost.connection, 'connection.authentication': newHost.connection.authentication },
  expect: {
    authMode: 'provider',
    provider: true,
    admits(headers, what) {
      check(newHost.provider && newHost.provider.authenticate({ headers }) === newHost.peer, `${what} headers are admitted by our provider`)
    },
    credentials(headers, what) {
      check(headers[OPERATOR_HEADER] !== 'spoofed', `${what}: browser-supplied operator header is overwritten`)
      check(!Object.keys(headers).some((k) => k !== OPERATOR_HEADER && k.toLowerCase() === OPERATOR_HEADER), `${what}: no case-variant copy of the operator header survives`)
      check(credentialMatches(headers, { header: OPERATOR_HEADER, secret: headers[OPERATOR_HEADER] }), `${what}: operator header is a single well-formed value`)
      check(headers.cookie === 'gw=1', `${what}: no cookie is invented on provider hosts`)
    },
  },
})
check(newHost.createPeerCalls === 1, 'provider host: exactly one owner Peer is created')

const legacy = legacyHostStub()
await runGeneration('legacy', {
  host: legacy,
  services: { connection: legacy.connection },
  expect: {
    authMode: 'cookie',
    provider: false,
    admits(headers, what) {
      check(headers.cookie === legacy.cookie, `${what}: legacy host receives the minted operator cookie`)
    },
    credentials(headers, what) {
      // No provider exists on a legacy host, so nothing is stamped; the
      // browser's own (meaningless) copy is left as it arrived.
      check(headers[OPERATOR_HEADER] === 'spoofed' || headers[OPERATOR_HEADER] === 'spoofed-mixed', `${what}: legacy host does not stamp an operator secret`)
    },
  },
})
check(legacy.calls.some(([m]) => m === 'authorizeIndex'), 'legacy host: cookie is minted through authorizeIndex')

console.log(`dsh-gateway-agent operator-auth: ${passed} checks passed`)
process.exit(process.exitCode || 0)
