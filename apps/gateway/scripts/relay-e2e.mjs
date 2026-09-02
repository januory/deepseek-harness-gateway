// P0 data-plane relay end-to-end test: HTTP relay + WS stream relay.
// Starts mock upstreams (HTTP echo + WS echo), pairs a scripted node to the
// running gateway, then exercises /console/<machineId>/... over both transports.
//
// Usage: CODE=testcode node scripts/relay-e2e.mjs
//   (gateway must be running with GATEWAY_PAIRING_CODES="testcode:t1")

import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { signChallenge, encodeFrame, DataKind, BinaryFrameParser } from 'dsh-gateway-protocol'

const code = process.env.CODE ?? 'testcode'
const gatewayWs = 'ws://127.0.0.1:3300/agent'
const gatewayHttp = 'http://127.0.0.1:3300'
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
let httpPassed = false
let wsPassed = false

const timeout = setTimeout(() => {
  console.error('FAIL: timeout (httpPassed=%s wsPassed=%s)', httpPassed, wsPassed)
  process.exit(1)
}, 12000)

const ws = new WebSocket(gatewayWs)

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
  if (msg.type === 'challenge') {
    const signature = signChallenge(code, msg.payload.nonce)
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'challenge_response',
        payload: { nonce: msg.payload.nonce, signature, code, machineName: 'relay-test-node', dshVersion: '0.1.0' },
      }),
    )
  } else if (msg.type === 'registration_status' && msg.payload.state === 'approved') {
    machineId = msg.payload.machineId
    console.log('paired machineId:', machineId)
    testHttp()
    testWs()
  } else if (msg.type === 'relay_request') {
    handleRelay(msg.payload)
  } else if (msg.type === 'relay_ws_open') {
    handleWsOpen(msg.payload)
  } else if (msg.type === 'relay_ws_close') {
    const e = wsUpstreams.get(msg.payload.channel)
    if (e) e.u.terminate()
    wsUpstreams.delete(msg.payload.channel)
  }
})

ws.on('error', (e) => {
  console.error('FAIL ws:', e.message)
  process.exit(1)
})

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
  const resp = await fetch(`${gatewayHttp}/console/${machineId}/hello?x=1`)
  const text = await resp.text()
  httpPassed = resp.status === 200 && resp.headers.get('x-upstream') === 'mock' && text.includes('/hello?x=1')
  console.log('HTTP relay:', httpPassed ? 'PASS' : 'FAIL', resp.status, text)
  checkDone()
}

function testWs() {
  const c = new WebSocket(`ws://127.0.0.1:3300/console/${machineId}/ws?x=1`)
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
