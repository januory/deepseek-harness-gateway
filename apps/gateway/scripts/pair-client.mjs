// P0 handshake client — simulates dsh-gateway-agent against a running gateway.
// Usage: CODE=testcode GATEWAY_URL=ws://127.0.0.1:3300/agent node scripts/pair-client.mjs

import WebSocket from 'ws'
import { signChallenge } from 'dsh-gateway-protocol'

const code = process.env.CODE ?? 'testcode'
const url = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:3300/agent'

const ws = new WebSocket(url)
const timeout = setTimeout(() => {
  console.error('FAIL: timeout')
  process.exit(1)
}, 8000)

ws.on('open', () => console.log('connected:', url))

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  console.log('recv:', JSON.stringify(msg))

  if (msg.type === 'challenge') {
    const signature = signChallenge(code, msg.payload.nonce)
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'challenge_response',
        payload: { nonce: msg.payload.nonce, signature, code, machineName: 'test-node', dshVersion: '0.1.0' },
      }),
    )
  } else if (msg.type === 'registration_status' && msg.payload.state === 'approved') {
    ws.send(JSON.stringify({ v: 1, type: 'heartbeat', payload: { machineId: msg.payload.machineId } }))
  } else if (msg.type === 'lease') {
    console.log('OK: approved + lease granted')
    clearTimeout(timeout)
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})

ws.on('close', (codeNum, reason) => {
  console.log('closed:', codeNum, String(reason))
  clearTimeout(timeout)
  if (codeNum !== 1000) process.exit(1)
})
