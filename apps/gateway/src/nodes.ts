// Node registration + HMAC onboarding + heartbeat/lease + data-plane relay (P0).
// Data plane: buffered HTTP relay AND bidirectional WS stream relay.
// ADR-0002/0004/0005. Durable metadata goes through IStore; live sockets in memory.

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebSocket as WebSocketT } from 'ws'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  LEASE_TTL_MS,
  DataKind,
  DataType,
  challenge,
  verifyChallenge,
  encodeFrame,
  encodeBinaryFrame,
  BinaryFrameParser,
} from 'dsh-gateway-protocol'
import type { IStore } from 'dsh-gateway-store'

interface PendingCode {
  tenantId: string
  expiresAt: number
}

interface ConnectedNode {
  ws: WebSocketT
  machineId: string
  leaseExpiry: number
  parser: BinaryFrameParser
}

export interface RelayRequest {
  method: string
  path: string
  headers: Record<string, string>
  body?: Buffer
}

export interface RelayResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

interface PendingRelay {
  status?: number
  headers?: Record<string, string>
  chunks: Buffer[]
  resolve: (r: RelayResponse) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

interface WsChannelHandler {
  onOpen(): void
  onData(kind: number, data: Buffer): void
  onClose(code: number): void
}

const RELAY_TIMEOUT_MS = 15_000
const WS_DROP_HEADERS = new Set(['host', 'connection', 'upgrade', 'origin', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])

export class NodeRegistry {
  private codes = new Map<string, PendingCode>()
  private nodes = new Map<string, ConnectedNode>()
  private pending = new Map<number, PendingRelay>()
  private wsChannels = new Map<number, WsChannelHandler>()
  private wsChannelNode = new Map<number, string>()
  private browserWss = new WebSocketServer({ noServer: true })
  private channelSeq = 0
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly store: IStore) {}

  seedPairingCode(code: string, tenantId: string, ttlMs = 600_000): void {
    this.codes.set(code, { tenantId, expiresAt: Date.now() + ttlMs })
  }

  start(): void {
    this.timer = setInterval(() => this.expire(), HEARTBEAT_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const node of this.nodes.values()) node.ws.close(4000, 'shutdown')
    this.nodes.clear()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('shutdown'))
    }
    this.pending.clear()
    this.wsChannels.clear()
    this.wsChannelNode.clear()
  }

  connectedCount(): number {
    return this.nodes.size
  }

  isConnected(machineId: string): boolean {
    return this.nodes.has(machineId)
  }

  /** List currently connected machines (for the portal / manual verification). */
  async listNodes(): Promise<Array<{ machineId: string; name?: string; dshVersion?: string }>> {
    const out: Array<{ machineId: string; name?: string; dshVersion?: string }> = []
    for (const id of this.nodes.keys()) {
      const m = await this.store.getMachine(id)
      out.push({ machineId: id, name: m?.name, dshVersion: m?.dshVersion })
    }
    return out
  }

  /** Relay an HTTP request to a connected node and await the buffered response. */
  relay(machineId: string, req: RelayRequest): Promise<RelayResponse> {
    const node = this.nodes.get(machineId)
    if (!node) return Promise.reject(new Error('node not connected'))

    const channel = ++this.channelSeq
    node.ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: DataType.RELAY_REQUEST,
        payload: {
          channel,
          method: req.method,
          path: req.path,
          headers: req.headers,
          contentLength: req.body?.length ?? 0,
        },
      }),
    )
    if (req.body && req.body.length > 0) {
      node.ws.send(encodeBinaryFrame(channel, 0, req.body))
    }

    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(channel)
        reject(new Error('relay timeout'))
      }, RELAY_TIMEOUT_MS)
      this.pending.set(channel, { chunks: [], resolve, reject, timer })
    })
  }

  /** Machine id when exactly one node is connected (P0 single-node passthrough). */
  singleNodeId(): string | undefined {
    if (this.nodes.size === 1) return this.nodes.keys().next().value
    return undefined
  }

  /** Handle a browser WebSocket upgrade on /console/<machineId>/... */
  handleConsoleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const u = new URL(req.url ?? '/', 'http://console')
    const segs = u.pathname.split('/').filter(Boolean) // ['console', machineId, ...]
    if (segs.length < 2 || segs[0] !== 'console') {
      socket.destroy()
      return
    }
    this.upgradeBrowserWs(req, socket, head, segs[1], '/' + segs.slice(2).join('/') + u.search)
  }

  /** Relay any browser WebSocket upgrade to a node at an arbitrary upstream path. */
  upgradeBrowserWs(req: IncomingMessage, socket: Duplex, head: Buffer, machineId: string, upstreamPath: string): void {
    if (!this.isConnected(machineId)) {
      socket.destroy()
      return
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || WS_DROP_HEADERS.has(k.toLowerCase())) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }

    this.browserWss.handleUpgrade(req, socket, head, (bws) => this.attachBrowserWs(bws, machineId, upstreamPath, headers))
  }

  private attachBrowserWs(bws: WebSocketT, machineId: string, restPath: string, headers: Record<string, string>): void {
    let channel: number
    try {
      channel = this.relayWsOpen(machineId, restPath, headers, {
        onOpen: () => {},
        onData: (kind, data) => {
          if (bws.readyState === WebSocket.OPEN) bws.send(data, { binary: kind === DataKind.BINARY })
        },
        onClose: (code) => {
          try {
            bws.close(code)
          } catch {
            /* ignore */
          }
        },
      })
    } catch {
      bws.close(1011)
      return
    }

    bws.on('message', (data, isBinary) => {
      const d = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      this.sendWs(channel, isBinary ? DataKind.BINARY : DataKind.TEXT, d)
    })
    bws.on('close', () => this.closeWsChannel(channel))
  }

  private relayWsOpen(machineId: string, path: string, headers: Record<string, string>, handler: WsChannelHandler): number {
    const node = this.nodes.get(machineId)
    if (!node) throw new Error('node not connected')
    const channel = ++this.channelSeq
    this.wsChannels.set(channel, handler)
    this.wsChannelNode.set(channel, machineId)
    node.ws.send(
      JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_WS_OPEN, payload: { channel, path, headers } }),
    )
    return channel
  }

  private sendWs(channel: number, kind: number, data: Buffer): void {
    const mid = this.wsChannelNode.get(channel)
    const node = mid ? this.nodes.get(mid) : undefined
    if (node) node.ws.send(encodeFrame(kind, channel, 0, data))
  }

  private closeWsChannel(channel: number): void {
    const mid = this.wsChannelNode.get(channel)
    const node = mid ? this.nodes.get(mid) : undefined
    if (node) {
      node.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_WS_CLOSE, payload: { channel } }))
    }
    this.wsChannels.delete(channel)
    this.wsChannelNode.delete(channel)
  }

  attach(ws: WebSocketT): void {
    const nonce = challenge().nonce
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'challenge', payload: { nonce } }))

    let authed = false
    let machineId = ''
    const parser = new BinaryFrameParser()

    ws.on('message', (raw, isBinary) => {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
      if (isBinary) {
        for (const frame of parser.push(data)) {
          const handler = this.wsChannels.get(frame.channel)
          if (handler) handler.onData(frame.kind, frame.data)
          else this.handleDataFrame(frame.channel, frame.data)
        }
        return
      }

      let msg: any
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch {
        return ws.close(4001, 'invalid json')
      }

      if (!authed) {
        this.handleOnboarding(ws, msg, nonce)
          .then((id) => {
            machineId = id
            authed = true
            this.nodes.set(id, { ws, machineId: id, leaseExpiry: Date.now() + LEASE_TTL_MS, parser })
          })
          .catch(() => {})
        return
      }

      if (msg.type === 'heartbeat') {
        const node = this.nodes.get(msg.payload?.machineId)
        if (!node) return ws.close(4004, 'unknown machine')
        node.leaseExpiry = Date.now() + LEASE_TTL_MS
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'lease', payload: { ttlMs: LEASE_TTL_MS } }))
        return
      }

      if (msg.type === DataType.RELAY_RESPONSE) {
        const p = this.pending.get(msg.payload?.channel)
        if (p) {
          p.status = msg.payload?.status
          p.headers = msg.payload?.headers
        }
        return
      }

      if (msg.type === DataType.RELAY_END) {
        const p = this.pending.get(msg.payload?.channel)
        if (p) {
          clearTimeout(p.timer)
          this.pending.delete(msg.payload.channel)
          p.resolve({ status: p.status ?? 502, headers: p.headers ?? {}, body: Buffer.concat(p.chunks) })
        }
        return
      }

      if (msg.type === DataType.RELAY_WS_OPEN_OK) {
        this.wsChannels.get(msg.payload?.channel)?.onOpen()
        return
      }

      if (msg.type === DataType.RELAY_WS_CLOSE) {
        const channel = msg.payload?.channel
        const handler = this.wsChannels.get(channel)
        if (handler) handler.onClose(msg.payload?.code ?? 1000)
        this.wsChannels.delete(channel)
        this.wsChannelNode.delete(channel)
      }
    })

    ws.on('close', () => {
      if (machineId) this.nodes.delete(machineId)
    })
  }

  private handleDataFrame(channel: number, data: Buffer): void {
    const p = this.pending.get(channel)
    if (p) p.chunks.push(data)
  }

  private async handleOnboarding(ws: WebSocketT, msg: any, nonce: string): Promise<string> {
    const { nonce: n, signature, code, machineName, dshVersion } = msg.payload ?? {}
    console.log('[gateway] onboarding msg code=', JSON.stringify(code), 'sig=', typeof signature)

    const pending = this.codes.get(code)
    if (!pending) {
      console.log('[gateway] onboarding REJECT: invalid pairing code', JSON.stringify(code))
      ws.close(4003, 'invalid pairing code')
      throw new Error('invalid pairing code')
    }
    if (Date.now() > pending.expiresAt) {
      console.log('[gateway] onboarding REJECT: expired')
      this.codes.delete(code)
      ws.close(4003, 'pairing code expired')
      throw new Error('pairing code expired')
    }
    if (!verifyChallenge(code, n, signature)) {
      console.log('[gateway] onboarding REJECT: bad signature')
      ws.close(4002, 'bad signature')
      throw new Error('bad signature')
    }

    // P0: keep the pairing code valid for its TTL so the node can re-onboard on
    // reconnect. (A persistent node key replaces this in P1.)
    const id = randomUUID()
    await this.store.upsertMachine({
      id,
      tenantId: pending.tenantId,
      name: machineName ?? 'node',
      nodeKeyHash: '', // TODO: long-term key hash after onboarding issues a node key (ADR-0004)
      status: 'approved',
      dshVersion: dshVersion ?? '',
      configRev: 0,
      createdAt: new Date().toISOString(),
    })
    await this.store.appendAudit({
      ts: new Date().toISOString(),
      actor: 'node',
      tenantId: pending.tenantId,
      machineId: id,
      action: 'register_approved',
      result: 'ok',
    })

    ws.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'registration_status',
        payload: { state: 'approved', machineId: id, leaseMs: LEASE_TTL_MS },
      }),
    )
    return id
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, node] of this.nodes) {
      if (now > node.leaseExpiry) {
        node.ws.close(4005, 'lease expired')
        this.nodes.delete(id)
      }
    }
  }
}
