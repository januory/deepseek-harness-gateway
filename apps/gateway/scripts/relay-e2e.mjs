// P1 data-plane relay end-to-end test: HTTP relay + WS stream relay.
// Starts mock upstreams (HTTP echo + WS echo), onboards a scripted node with a
// pairing code, approves it via the admin API, reconnects with the node key,
// then exercises /console/<machineId>/... over both transports.
//
// Usage: DSH_GATEWAY_CODE=testcode node scripts/relay-e2e.mjs
//   (gateway must be running with DSH_GATEWAY_PAIRING_CODES="testcode:default")

import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { encodeFrame, DataKind, BinaryFrameParser } from 'dsh-gateway-protocol'

const code = process.env.DSH_GATEWAY_CODE ?? 'testcode'
const adminId = process.env.DSH_GATEWAY_ADMIN_ID ?? 'admin'
const adminPassword = process.env.DSH_GATEWAY_ADMIN_PASSWORD ?? 'admin'
const gatewayWs = process.env.DSH_GATEWAY_URL ?? 'ws://127.0.0.1:3300/agent'
const gatewayHttp = process.env.DSH_GATEWAY_HTTP ?? 'http://127.0.0.1:3300'
const upstreamHttpPort = 3999
const upstreamWsPort = 3998

// --- mock upstreams -------------------------------------------------------
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-upstream', 'mock')
    res.end(JSON.stringify({ upstream: true, method: req.method, url: req.url, body: body.toString() }))
  })
})
await new Promise((r) => upstream.listen(upstreamHttpPort, '127.0.0.1', r))

const wsUpstream = new WebSocketServer({ port: upstreamWsPort })
wsUpstream.on('connection', (uws) => {
  uws.on('message', (data, isBinary) => uws.send(data, { binary: isBinary }))
})

// --- node client ----------------------------------------------------------
const parser = new BinaryFrameParser()
const wsUpstreams = new Map() // channel -> { u, queue }
let machineId = null
let nodeKey = null
let httpPassed = false
let wsPassed = false

const timeout = setTimeout(() => {
  console.error('FAIL: timeout (httpPassed=%s wsPassed=%s)', httpPassed, wsPassed)
  process.exit(1)
}, 15000)

function authAndGetWs(authPayload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayWs)
    const onAuth = (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'challenge') {
        ws.send(JSON.stringify({ v: 1, type: 'challenge_response', payload: authPayload(msg.payload.nonce) }))
      } else if (msg.type === 'registration_status') {
        ws.off('message', onAuth)
        resolve({ ws, msg })
      }
    }
    ws.on('message', onAuth)
    ws.on('error', reject)
  })
}

// 1. onboard → pending + node key
const onboard = await authAndGetWs((nonce) => ({ nonce, code, machineName: 'relay-test-node', dshVersion: '0.1.0' }))
if (onboard.msg.payload.state !== 'pending') {
  console.error('FAIL: expected pending, got', JSON.stringify(onboard.msg.payload))
  process.exit(1)
}
machineId = onboard.msg.payload.machineId
nodeKey = onboard.msg.payload.nodeKey
onboard.ws.close()
console.log('onboarded pending:', machineId)

// 2. admin login + approve
const loginResp = await fetch(`${gatewayHttp}/gw/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: adminId, password: adminPassword }),
})
const cookie = loginResp.headers.getSetCookie()[0].split(';')[0]
const approveResp = await fetch(`${gatewayHttp}/gw/machines/${machineId}/approve`, { method: 'POST', headers: { cookie } })
if (approveResp.status !== 200) {
  console.error('FAIL: approve', approveResp.status, await approveResp.text())
  process.exit(1)
}
const seatResp = await fetch(`${gatewayHttp}/gw/seats/${machineId}/acquire`, { method: 'POST', headers: { cookie } })
if (seatResp.status !== 200) {
  console.error('FAIL: acquire seat', seatResp.status, await seatResp.text())
  process.exit(1)
}

// 3. reconnect with node key → approved; keep this socket for relay
const reconn = await authAndGetWs((nonce) => ({ nonce, machineId, nodeKey }))
if (reconn.msg.payload.state !== 'approved') {
  console.error('FAIL: expected approved, got', JSON.stringify(reconn.msg.payload))
  process.exit(1)
}
const ws = reconn.ws
ws.on('message', (raw, isBinary) => {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (isBinary) {
    for (const f of parser.push(data)) {
      const e = wsUpstreams.get(f.channel)
      if (!e) continue
      if (e.u.readyState === WebSocket.OPEN) e.u.send(f.data, { binary: f.kind === DataKind.BINARY })
      else e.queue.push({ data: f.data, binary: f.kind === DataKind.BINARY })
    }
    return
  }

  const msg = JSON.parse(data.toString('utf8'))
  if (msg.type === 'relay_request') handleRelay(msg.payload)
  else if (msg.type === 'relay_ws_open') handleWsOpen(msg.payload)
  else if (msg.type === 'relay_ws_close') {
    const e = wsUpstreams.get(msg.payload.channel)
    if (e) e.u.terminate()
    wsUpstreams.delete(msg.payload.channel)
  }
})
console.log('reconnected approved:', machineId)
testHttp()
testWs()

function handleRelay({ channel, method, path, headers }) {
  const ureq = http.request(
    { host: '127.0.0.1', port: upstreamHttpPort, method, path, headers },
    (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        ws.send(JSON.stringify({ v: 1, type: 'relay_response', payload: { channel, status: res.statusCode, headers: res.headers } }))
        if (body.length > 0) ws.send(encodeFrame(DataKind.BINARY, channel, 0, body))
        ws.send(JSON.stringify({ v: 1, type: 'relay_end', payload: { channel } }))
      })
    },
  )
  ureq.on('error', () => {
    ws.send(JSON.stringify({ v: 1, type: 'relay_response', payload: { channel, status: 502, headers: {} } }))
    ws.send(JSON.stringify({ v: 1, type: 'relay_end', payload: { channel } }))
  })
  ureq.end()
}

function handleWsOpen({ channel, path }) {
  const u = new WebSocket(`ws://127.0.0.1:${upstreamWsPort}${path}`)
  const entry = { u, queue: [] }
  wsUpstreams.set(channel, entry)
  u.on('open', () => {
    ws.send(JSON.stringify({ v: 1, type: 'relay_ws_open_ok', payload: { channel } }))
    for (const f of entry.queue) u.send(f.data, { binary: f.binary })
    entry.queue = []
  })
  u.on('message', (data, isBinary) => {
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data)
    ws.send(encodeFrame(isBinary ? DataKind.BINARY : DataKind.TEXT, channel, 0, d))
  })
  u.on('close', (c) => ws.send(JSON.stringify({ v: 1, type: 'relay_ws_close', payload: { channel, code: c } })))
  u.on('error', () => {})
}

// --- client tests ---------------------------------------------------------
async function testHttp() {
  const resp = await fetch(`${gatewayHttp}/console/${machineId}/hello?x=1`, { headers: { cookie } })
  const text = await resp.text()
  httpPassed = resp.status === 200 && resp.headers.get('x-upstream') === 'mock' && text.includes('/hello?x=1')
  console.log('HTTP relay:', httpPassed ? 'PASS' : 'FAIL', resp.status, text)
  checkDone()
}

function testWs() {
  const c = new WebSocket(`${gatewayHttp.replace(/^http/, 'ws')}/console/${machineId}/ws?x=1`, { headers: { cookie } })
  let phase = 0 // 0=await echo text, 1=await echo binary
  c.on('open', () => {
    phase = 0
    c.send('ping')
  })
  c.on('message', (data, isBinary) => {
    if (phase === 0 && !isBinary) {
      const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      if (s === 'ping') {
        phase = 1
        c.send(Buffer.from([1, 2, 3]), { binary: true })
      }
    } else if (phase === 1 && isBinary) {
      const b = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (b.length === 3 && b[0] === 1 && b[1] === 2 && b[2] === 3) {
        wsPassed = true
        c.close()
        console.log('WS relay: PASS')
        checkDone()
      }
    }
  })
  c.on('error', (e) => {
    console.error('WS relay FAIL:', e.message)
    checkDone()
  })
}

function checkDone() {
  if (httpPassed && wsPassed) {
    clearTimeout(timeout)
    console.log('PASS: HTTP + WS relay round-trips OK')
    upstream.close()
    wsUpstream.close()
    ws.close()
    process.exit(0)
  }
}
