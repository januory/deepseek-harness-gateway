// Newline-delimited JSON-RPC-ish framing and a channel-multiplexed binary frame codec.

/**
 * @typedef {object} JsonFrame
 * @property {number} v       protocol version
 * @property {string} type    control message type (see ControlType / DataType)
 * @property {string} [id]    correlation id
 * @property {unknown} [payload]
 */

/** Incremental newline-delimited JSON codec. */
export class JsonLineCodec {
  constructor() {
    /** @type {string} */
    this.buf = ''
  }

  /**
   * @param {JsonFrame | unknown} message
   * @returns {string}
   */
  encode(message) {
    return JSON.stringify(message) + '\n'
  }

  /**
   * Feed a text chunk; returns any complete JSON frames.
   * @param {string} chunk
   * @returns {unknown[]}
   */
  push(chunk) {
    this.buf += chunk
    const out = []
    let idx
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        out.push(JSON.parse(trimmed))
      }
    }
    return out
  }
}

// Binary frame header: [kind: u8][channel: u32le][seq: u32le][len: u32le] = 13 bytes.
const HEADER_BYTES = 13

/**
 * Encode a data frame on a relay channel.
 * @param {number} kind     frame kind (DataKind.BINARY | DataKind.TEXT)
 * @param {number} channel  relay channel id
 * @param {number} seq      per-channel sequence number
 * @param {Uint8Array | Buffer} payload
 * @returns {Buffer}
 */
export function encodeFrame(kind, channel, seq, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const head = Buffer.alloc(HEADER_BYTES)
  head.writeUInt8(kind & 0xff, 0)
  head.writeUInt32LE(channel >>> 0, 1)
  head.writeUInt32LE(seq >>> 0, 5)
  head.writeUInt32LE(p.length, 9)
  return Buffer.concat([head, p])
}

/** Encode a binary data frame (kind = BINARY). */
export function encodeBinaryFrame(channel, seq, payload) {
  return encodeFrame(1, channel, seq, payload)
}

/**
 * @typedef {object} BinaryFrame
 * @property {number} kind
 * @property {number} channel
 * @property {number} seq
 * @property {Buffer} data
 */

/** Incremental binary frame parser (accumulates across chunk boundaries). */
export class BinaryFrameParser {
  constructor() {
    /** @type {Buffer} */
    this.buf = Buffer.alloc(0)
  }

  /**
   * @param {Uint8Array | Buffer} chunk
   * @returns {BinaryFrame[]}
   */
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
