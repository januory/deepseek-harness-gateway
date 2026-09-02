import { describe, it, expect } from 'vitest'
import { JsonLineCodec, encodeFrame, encodeBinaryFrame, BinaryFrameParser, DataKind } from '../src/index.js'

describe('JsonLineCodec', () => {
  it('round-trips a frame', () => {
    const c = new JsonLineCodec()
    const msg = { v: 1, type: 'hello', id: 'a1', payload: { ok: true } }
    expect(c.push(c.encode(msg))).toEqual([msg])
  })

  it('parses multiple frames and split chunks', () => {
    const c = new JsonLineCodec()
    const a = { v: 1, type: 'heartbeat' }
    const b = { v: 1, type: 'lease', payload: { ttl: 45000 } }
    const wire = c.encode(a) + c.encode(b)
    const out = []
    for (const ch of wire) out.push(...c.push(ch))
    expect(out).toEqual([a, b])
  })

  it('ignores blank lines', () => {
    const c = new JsonLineCodec()
    expect(c.push('\n\n')).toEqual([])
  })
})

describe('binary frames', () => {
  it('round-trips a single frame with channel', () => {
    const payload = Buffer.from('hello relay')
    const wire = encodeBinaryFrame(7, 3, payload)
    const parser = new BinaryFrameParser()
    const frames = parser.push(wire)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ kind: 1, channel: 7, seq: 3, data: payload })
  })

  it('parses frames split across arbitrary chunk boundaries', () => {
    const p1 = encodeBinaryFrame(1, 0, Buffer.from('aaaa'))
    const p2 = encodeBinaryFrame(2, 1, Buffer.from('bbbbbb'))
    const wire = Buffer.concat([p1, p2])
    const parser = new BinaryFrameParser()
    const frames = []
    for (let i = 0; i < wire.length; i++) frames.push(...parser.push(wire.subarray(i, i + 1)))
    expect(frames.map((f) => f.channel)).toEqual([1, 2])
    expect(frames[0].seq).toBe(0)
    expect(frames[1].seq).toBe(1)
    expect(frames[0].data.toString()).toBe('aaaa')
    expect(frames[1].data.toString()).toBe('bbbbbb')
  })

  it('preserves frame kind (text vs binary)', () => {
    const parser = new BinaryFrameParser()
    const text = parser.push(encodeFrame(DataKind.TEXT, 5, 0, Buffer.from('hi')))
    const bin = parser.push(encodeFrame(DataKind.BINARY, 5, 1, Buffer.from([0, 1, 2])))
    expect(text[0].kind).toBe(DataKind.TEXT)
    expect(bin[0].kind).toBe(DataKind.BINARY)
  })
})
