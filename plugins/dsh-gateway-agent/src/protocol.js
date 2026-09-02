// Vendored protocol subset for dsh-gateway-agent (self-contained; mirrors
// packages/protocol so the plugin installs standalone via `dsh plugin add`
// without a workspace dependency on dsh-gateway-protocol).

import { createHmac } from 'node:crypto'

export const PROTOCOL_VERSION = 1
export const HEARTBEAT_INTERVAL_MS = 15_000
export const LEASE_TTL_MS = 45_000

export const ControlType = Object.freeze({
  CHALLENGE: 'challenge',
  CHALLENGE_RESPONSE: 'challenge_response',
  REGISTRATION_STATUS: 'registration_status',
  HEARTBEAT: 'heartbeat',
  LEASE: 'lease',
  ERROR: 'error',
})

export const DataType = Object.freeze({
  RELAY_REQUEST: 'relay_request',
  RELAY_RESPONSE: 'relay_response',
  RELAY_END: 'relay_end',
  RELAY_WS_OPEN: 'relay_ws_open',
  RELAY_WS_OPEN_OK: 'relay_ws_open_ok',
  RELAY_WS_CLOSE: 'relay_ws_close',
})

export const DataKind = Object.freeze({
  BINARY: 1,
  TEXT: 2,
})

export function signChallenge(secret, nonce) {
  return createHmac('sha256', secret).update(nonce).digest('hex')
}

// Binary frame: [kind u8][channel u32le][seq u32le][len u32le] = 13 bytes.
const HEADER_BYTES = 13

export function encodeFrame(kind, channel, seq, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = Buffer.alloc(HEADER_BYTES)
  head.writeUInt8(kind & 0xff, 0)
  head.writeUInt32LE(channel >>> 0, 1)
  head.writeUInt32LE(seq >>> 0, 5)
  head.writeUInt32LE(p.length, 9)
  return Buffer.concat([head, p])
}

export function encodeBinaryFrame(channel, seq, payload) {
  return encodeFrame(DataKind.BINARY, channel, seq, payload)
}

export class BinaryFrameParser {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buf = Buffer.concat([this.buf, c])
    const frames = []
    for (;;) {
      if (this.buf.length < HEADER_BYTES) break
      const kind = this.buf.readUInt8(0)
      const channel = this.buf.readUInt32LE(1)
      const seq = this.buf.readUInt32LE(5)
      const len = this.buf.readUInt32LE(9)
      if (this.buf.length < HEADER_BYTES + len) break
      const data = this.buf.subarray(HEADER_BYTES, HEADER_BYTES + len)
      this.buf = this.buf.subarray(HEADER_BYTES + len)
      frames.push({ kind, channel, seq, data })
    }
    return frames
  }
}
