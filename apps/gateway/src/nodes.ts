// Node registration + pairing/onboarding + heartbeat/lease + data-plane relay.
// Data plane: buffered HTTP relay AND bidirectional WS stream relay.
//
// Control-plane lifecycle (ADR-0002/0004/0005):
//   admin issues one-time pairing code (hashed in store)
//   → node onboards with the code → machine created `pending` + a node key issued
//   → admin approves → node reconnects with its node key → `approved` + leased
// Durable metadata goes through IStore; live sockets stay in memory.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
  encodeFrame,
  encodeBinaryFrame,
  BinaryFrameParser,
} from 'dsh-gateway-protocol'
import type { IStore, MachineStatus } from 'dsh-gateway-store'

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

interface ConnectedNode {
  ws: WebSocketT
  machineId: string
  tenantId: string
  status: MachineStatus
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
  private nodes = new Map<string, ConnectedNode>()
  private pending = new Map<number, PendingRelay>()
  private wsChannels = new Map<number, WsChannelHandler>()
  private wsChannelNode = new Map<number, string>()
  private browserWss = new WebSocketServer({ noServer: true })
  private channelSeq = 0
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly store: IStore) {}

  /** Seed a pairing code from env/config (hashed in store, one-time, TTL). */
  async seedPairingCode(code: string, tenantId: string, ttlMs = 600_000): Promise<void> {
    await this.store.upsertPairingCode({
      codeHash: sha256Hex(code),
      tenantId,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    })
  }

  /** Issue a one-time pairing code; returns the plaintext code for the admin. */
  async issuePairingCode(tenantId: string, ttlMs = 600_000): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    await this.store.upsertPairingCode({ codeHash: sha256Hex(code), tenantId, expiresAt })
    return { code, expiresAt }
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

  /** Live nodes: machineId → { status, tenantId }. */
  listConnected(): Array<{ machineId: string; tenantId: string; status: MachineStatus }> {
    return [...this.nodes.values()].map((n) => ({ machineId: n.machineId, tenantId: n.tenantId, status: n.status }))
  }

  /** List machines for the portal/admin (durable metadata). */
  async listNodes(): Promise<Array<{ machineId: string; name?: string; dshVersion?: string }>> {
    const out: Array<{ machineId: string; name?: string; dshVersion?: string }> = []
    for (const id of this.nodes.keys()) {
      const m = await this.store.getMachine(id)
      out.push({ machineId: id, name: m?.name, dshVersion: m?.dshVersion })
    }
    return out
  }

  /** Approve a pending machine; if it is connected, promote + notify it live. */
  async approveMachine(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) throw new Error('machine not found')
    if (m.status !== 'pending') throw new Error('machine is not pending')
    await this.store.upsertMachine({ ...m, status: 'approved' })
    const node = this.nodes.get(machineId)
    if (node) {
      node.status = 'approved'
      node.ws.send(
        JSON.stringify({ v: PROTOCOL_VERSION, type: 'registration_status', payload: { state: 'approved', machineId, leaseMs: LEASE_TTL_MS } }),
      )
    }
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', tenantId: m.tenantId, machineId, action: 'approve_machine', result: 'ok' })
  }

  /** Revoke a machine and drop its live connection. */
  async revokeMachine(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) throw new Error('machine not found')
    await this.store.upsertMachine({ ...m, status: 'revoked' })
    const node = this.nodes.get(machineId)
    if (node) {
      node.ws.close(4003, 'machine revoked')
      this.nodes.delete(machineId)
    }
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', tenantId: m.tenantId, machineId, action: 'revoke_machine', result: 'ok' })
  }

  /** Relay an HTTP request to a connected, approved node and await the response. */
  relay(machineId: string, req: RelayRequest): Promise<RelayResponse> {
    const node = this.nodes.get(machineId)
    if (!node) return Promise.reject(new Error('node not connected'))
    if (node.status !== 'approved') return Promise.reject(new Error('node not approved'))

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

  /** Machine id when exactly one APPROVED node is connected (single-node passthrough). */
  singleNodeId(): string | undefined {
    let found: string | undefined
    for (const [id, node] of this.nodes) {
      if (node.status !== 'approved') continue
      if (found !== undefined) return undefined
      found = id
    }
    return found
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
    const node = this.nodes.get(machineId)
    if (!node || node.status !== 'approved') {
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
    if (!node || node.status !== 'approved') throw new Error('node not connected/approved')
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
        this.handleOnboarding(ws, msg)
          .then(({ machineId: id, tenantId, state }) => {
            machineId = id
            authed = true
            this.nodes.set(id, { ws, machineId: id, tenantId, status: state, leaseExpiry: Date.now() + LEASE_TTL_MS, parser })
          })
          .catch((e) => console.log('[gateway] onboarding ERROR:', (e as Error).message ?? e))
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

  /** Returns the authenticated machine id, its tenant, and its live status. */
  private async handleOnboarding(
    ws: WebSocketT,
    msg: any,
  ): Promise<{ machineId: string; tenantId: string; state: MachineStatus }> {
    const { code, machineId, nodeKey, machineName, dshVersion } = msg.payload ?? {}
    console.log('[gateway] onboarding', code ? 'code=' + String(code).slice(0, 8) : 'reconnect machineId=' + machineId)

    // First-time onboarding with a one-time pairing code (bearer secret over wss).
    if (code) {
      const codeHash = sha256Hex(String(code))
      const pc = await this.store.getPairingCodeByHash(codeHash)
      if (!pc) {
        ws.close(4003, 'invalid pairing code')
        throw new Error('invalid pairing code')
      }
      if (new Date(pc.expiresAt).getTime() < Date.now()) {
        ws.close(4003, 'pairing code expired')
        throw new Error('pairing code expired')
      }
      if (pc.consumedBy) {
        ws.close(4003, 'pairing code already used')
        throw new Error('pairing code already used')
      }

      const id = randomUUID()
      const nodeKey = randomBytes(32).toString('hex')
      await this.store.upsertMachine({
        id,
        tenantId: pc.tenantId,
        name: machineName ?? 'node',
        nodeKeyHash: sha256Hex(nodeKey),
        status: 'pending',
        dshVersion: dshVersion ?? '',
        configRev: 0,
        createdAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      })
      await this.store.consumePairingCode(codeHash, id)
      await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'node', tenantId: pc.tenantId, machineId: id, action: 'register_pending', result: 'ok' })

      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'registration_status', payload: { state: 'pending', machineId: id, nodeKey } }))
      return { machineId: id, tenantId: pc.tenantId, state: 'pending' }
    }

    // Reconnect with the issued node key.
    if (machineId && nodeKey) {
      const m = await this.store.getMachine(String(machineId))
      if (!m) {
        ws.close(4004, 'unknown machine')
        throw new Error('unknown machine')
      }
      if (sha256Hex(String(nodeKey)) !== m.nodeKeyHash) {
        ws.close(4002, 'bad node key')
        throw new Error('bad node key')
      }
      if (m.status === 'revoked') {
        ws.close(4003, 'machine revoked')
        throw new Error('machine revoked')
      }
      await this.store.upsertMachine({ ...m, lastHeartbeatAt: new Date().toISOString() })

      const state: MachineStatus = m.status === 'approved' ? 'approved' : 'pending'
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'registration_status',
          payload: state === 'approved' ? { state, machineId: m.id, leaseMs: LEASE_TTL_MS } : { state, machineId: m.id },
        }),
      )
      return { machineId: m.id, tenantId: m.tenantId, state }
    }

    ws.close(4001, 'expected pairing code or machineId+nodeKey')
    throw new Error('expected auth')
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
