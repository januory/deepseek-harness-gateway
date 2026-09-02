// P1 control-plane + lifecycle end-to-end test (scripted node + admin API).
//
// Flow: onboard with pairing code → pending + node key → admin approve via /gw
// → reconnect with node key → approved + lease → HTTP relay round-trip.
//
// Usage: CODE=testcode node scripts/onboard-e2e.mjs
//   (gateway running with GATEWAY_PAIRING_CODES="testcode:default")

import http from 'node:http'
import WebSocket from 'ws'
import { encodeFrame, DataKind } from 'dsh-gateway-protocol'

const gatewayWs = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:3300/agent'
const gatewayHttp = process.env.GATEWAY_HTTP ?? 'http://127.0.0.1:3300'
const code = process.env.CODE ?? 'testcode'
const adminId = process.env.ADMIN_ID ?? 'admin'
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin'

let machineId = null
let nodeKey = null
const timeout = setTimeout(() => {
  console.error('FAIL: timeout')
  process.exit(1)
}, 15000)

function fail(msg) {
  console.error('FAIL:', msg)
  process.exit(1)
}

function connect(getPayload, onRelayRequest) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayWs)
    const onMessage = (raw, isBinary) => {
      if (isBinary) return
      const msg = JSON.parse(String(raw))
      if (msg.type === 'challenge') {
        ws.send(JSON.stringify({ v: 1, type: 'challenge_response', payload: getPayload(msg.payload.nonce) }))
      } else if (msg.type === 'registration_status') {
        resolve({ ws, msg })
      } else if (msg.type === 'relay_request' && onRelayRequest) {
        onRelayRequest(ws, msg.payload)
      }
    }
    ws.on('message', onMessage)
    ws.on('error', (e) => reject(e))
  })
}

// --- 1. onboard with pairing code -----------------------------------------
const onboard = await connect((nonce) => ({ nonce, code, machineName: 'e2e-node', dshVersion: '0.1.0' }))
if (onboard.msg.payload.state !== 'pending') fail(`expected pending, got ${JSON.stringify(onboard.msg.payload)}`)
machineId = onboard.msg.payload.machineId
nodeKey = onboard.msg.payload.nodeKey
if (!machineId || !nodeKey) fail('missing machineId/nodeKey in pending registration')
console.log('1. onboard pending:', machineId)
onboard.ws.close()

// --- 2. admin login + approve ---------------------------------------------
const loginResp = await fetch(`${gatewayHttp}/gw/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: adminId, password: adminPassword }),
})
if (loginResp.status !== 200) fail(`login failed: ${loginResp.status}`)
const setCookie = loginResp.headers.getSetCookie?.()?.[0]
if (!setCookie) fail('no set-cookie on login')
const cookie = setCookie.split(';')[0]

const approveResp = await fetch(`${gatewayHttp}/gw/machines/${machineId}/approve`, { method: 'POST', headers: { cookie } })
if (approveResp.status !== 200) fail(`approve failed: ${approveResp.status} ${await approveResp.text()}`)
console.log('2. approved via admin API')

// Acquire the console seat so the relay is authorized (ADR-0005).
const seatResp = await fetch(`${gatewayHttp}/gw/seats/${machineId}/acquire`, { method: 'POST', headers: { cookie } })
if (seatResp.status !== 200) fail(`acquire seat failed: ${seatResp.status} ${await seatResp.text()}`)
console.log('3. console seat acquired')

// --- 3. reconnect with node key → approved + relay ------------------------
const relayHandler = (ws, { channel, path }) => {
  const body = Buffer.from(JSON.stringify({ ok: true, path }))
  ws.send(JSON.stringify({ v: 1, type: 'relay_response', payload: { channel, status: 200, headers: { 'content-type': 'application/json', 'x-e2e': '1' } } }))
  if (body.length > 0) ws.send(encodeFrame(DataKind.BINARY, channel, 0, body))
  ws.send(JSON.stringify({ v: 1, type: 'relay_end', payload: { channel } }))
}

const reconn = await connect((nonce) => ({ nonce, machineId, nodeKey }), relayHandler)
if (reconn.msg.payload.state !== 'approved') fail(`expected approved, got ${JSON.stringify(reconn.msg.payload)}`)
console.log('4. reconnected approved:', machineId)

const relayResp = await fetch(`${gatewayHttp}/console/${machineId}/hello?x=1`, { headers: { cookie } })
const relayBody = await relayResp.text()
if (relayResp.status !== 200 || relayResp.headers.get('x-e2e') !== '1' || !relayBody.includes('/hello?x=1')) {
  fail(`relay failed: ${relayResp.status} ${relayBody}`)
}
console.log('5. HTTP relay round-trip OK')

clearTimeout(timeout)
console.log('PASS: onboarding → approve → reconnect → relay')
reconn.ws.close()
process.exit(0)
