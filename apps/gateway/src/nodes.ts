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

export interface RelayStreamHandlers {
  onResponse(status: number, headers: Record<string, string>): void
  onData(chunk: Buffer): void
  onEnd(): void
  onError(err: Error): void
}

interface RelayStreamState {
  handlers: RelayStreamHandlers
  arm: () => void
  clear: () => void
}

interface WsChannelHandler {
  onOpen(): void
  onData(kind: number, data: Buffer): void
  onClose(code: number): void
}

// Idle timeout for a relayed HTTP response: how long the gateway waits for the
// next response chunk before giving up. Generous on purpose — slow machine-side
// queries (e.g. a big session/list) and long-lived SSE streams must survive.
const RELAY_TIMEOUT_MS = Number(process.env.DSH_GATEWAY_RELAY_TIMEOUT_MS ?? 60_000)
const WS_DROP_HEADERS = new Set(['host', 'connection', 'upgrade', 'origin', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'])

export class NodeRegistry {
  private nodes = new Map<string, ConnectedNode>()
  private streams = new Map<number, RelayStreamState>()
  private streamsNode = new Map<number, string>()
  private wsChannels = new Map<number, WsChannelHandler>()
  private wsChannelNode = new Map<number, string>()
  // Browser-facing console WebSockets run WITHOUT permessage-deflate: several
  // vendor mobile browsers (e.g. realme/OPPO's built-in browser, often behind a
  // system-level acceleration/relay) complete the upgrade but then lose the
  // compressed first frames, leaving the dsh mux with up=0B / close 4000 churn.
  // Plaintext frames cost a little bandwidth and are transparent to normal
  // browsers, so compression is not worth the device breakage.
  private browserWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  private channelSeq = 0
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly store: IStore) {}

  /** Seed a pairing code from env/config (hashed in store, one-time, TTL). */
  async seedPairingCode(code: string, ttlMs = 600_000): Promise<void> {
    await this.store.upsertPairingCode({
      codeHash: sha256Hex(code),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    })
  }

  /** Issue a one-time pairing code; returns the plaintext code for the admin. */
  async issuePairingCode(ttlMs = 600_000): Promise<{ code: string; expiresAt: string }> {
    const code = randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    await this.store.upsertPairingCode({ codeHash: sha256Hex(code), expiresAt })
    return { code, expiresAt }
  }

  start(): void {
    this.timer = setInterval(() => this.expire(), HEARTBEAT_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const node of this.nodes.values()) node.ws.close(4000, 'shutdown')
    this.nodes.clear()
    for (const s of this.streams.values()) {
      s.clear()
      s.handlers.onError(new Error('shutdown'))
    }
    this.streams.clear()
    this.streamsNode.clear()
    this.wsChannels.clear()
    this.wsChannelNode.clear()
  }

  connectedCount(): number {
    return this.nodes.size
  }

  isConnected(machineId: string): boolean {
    return this.nodes.has(machineId)
  }

  /** Live nodes: machineId → { status }. */
  listConnected(): Array<{ machineId: string; status: MachineStatus }> {
    return [...this.nodes.values()].map((n) => ({ machineId: n.machineId, status: n.status }))
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
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', machineId, action: 'approve_machine', result: 'ok' })
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
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', machineId, action: 'revoke_machine', result: 'ok' })
  }

  /** Delete a machine record entirely; drops its live connection if any. */
  async deleteMachine(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) throw new Error('machine not found')
    const node = this.nodes.get(machineId)
    if (node) {
      node.ws.close(4000, 'machine deleted')
      this.nodes.delete(machineId)
    }
    await this.store.deleteMachine(machineId)
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', machineId, action: 'delete_machine', result: 'ok' })
  }

  /** Relay an HTTP request to a connected, approved node and stream the response. */
  relayStream(machineId: string, req: RelayRequest, handlers: RelayStreamHandlers): void {
    const node = this.nodes.get(machineId)
    if (!node) {
      handlers.onError(new Error('node not connected'))
      return
    }
    if (node.status !== 'approved') {
      handlers.onError(new Error('node not approved'))
      return
    }

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

    let timer: NodeJS.Timeout | undefined
    const clear = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }
    const arm = () => {
      clear()
      timer = setTimeout(() => {
        this.streams.delete(channel)
        this.streamsNode.delete(channel)
        handlers.onError(new Error('relay timeout'))
      }, RELAY_TIMEOUT_MS)
    }
    this.streams.set(channel, { handlers, arm, clear })
    this.streamsNode.set(channel, machineId)
    arm()
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
    let upBytes = 0
    let downBytes = 0
    const ua = (headers['user-agent'] || '').slice(0, 80)
    // Logical-stream tracing for the /api/remote.mux protocol: remember the
    // endpoint each client streamId opens so server error/end frames are
    // attributable. Only small text frames are inspected (payload frames are
    // relayed untouched).
    const streamEndpoints = new Map<string, string>()
    const traceServerFrame = (text: string): void => {
      if (text.length > 8192) return
      try {
        const msg = JSON.parse(text) as { type?: string; streamId?: unknown; error?: { code?: unknown; message?: unknown } }
        if (msg.type === 'error' && typeof msg.streamId === 'string') {
          const endpoint = streamEndpoints.get(msg.streamId)
          console.log(
            `[mux] server error ch=${channel} stream=${msg.streamId.slice(0, 8)} endpoint=${endpoint ?? '?'} code=${typeof msg.error?.code === 'string' ? msg.error.code : '?'} message=${typeof msg.error?.message === 'string' ? msg.error.message.slice(0, 200) : '?'} at=${new Date().toISOString()}`,
          )
        } else if (msg.type === 'end' && typeof msg.streamId === 'string') {
          const endpoint = streamEndpoints.get(msg.streamId)
          console.log(`[mux] server end ch=${channel} stream=${msg.streamId.slice(0, 8)} endpoint=${endpoint ?? '?'} at=${new Date().toISOString()}`)
          streamEndpoints.delete(msg.streamId)
        }
      } catch {
        /* not a JSON control frame */
      }
    }
    try {
      channel = this.relayWsOpen(machineId, restPath, headers, {
        onOpen: () => {
          console.log(`[console-ws] upstream open channel=${channel} machine=${machineId} path=${restPath} at=${new Date().toISOString()}`)
        },
        onData: (kind, data) => {
          downBytes += data.length
          if (kind === DataKind.TEXT) traceServerFrame(data.toString('utf8'))
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
      console.log(`[console-ws] relay open channel=${channel} machine=${machineId} path=${restPath} ua=${ua} at=${new Date().toISOString()}`)
    } catch (e) {
      console.log(
        `[console-ws] relay open FAILED machine=${machineId} path=${restPath} ua=${ua} err=${(e as Error).message ?? String(e)} at=${new Date().toISOString()}`,
      )
      bws.close(1011)
      return
    }

    bws.on('message', (data, isBinary) => {
      const d = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      upBytes += d.length
      if (!isBinary && d.length < 8192) {
        try {
          const msg = JSON.parse(d.toString('utf8')) as { type?: string; streamId?: unknown; endpoint?: unknown }
          if (msg.type === 'open' && typeof msg.streamId === 'string' && typeof msg.endpoint === 'string') {
            streamEndpoints.set(msg.streamId, msg.endpoint)
            console.log(`[mux] client open ch=${channel} stream=${msg.streamId.slice(0, 8)} endpoint=${msg.endpoint} at=${new Date().toISOString()}`)
          } else if (msg.type === 'cancel' && typeof msg.streamId === 'string') {
            const endpoint = streamEndpoints.get(msg.streamId)
            console.log(`[mux] client cancel ch=${channel} stream=${msg.streamId.slice(0, 8)} endpoint=${endpoint ?? '?'} at=${new Date().toISOString()}`)
            streamEndpoints.delete(msg.streamId)
          }
        } catch {
          /* not a JSON control frame */
        }
      }
      this.sendWs(channel, isBinary ? DataKind.BINARY : DataKind.TEXT, d)
    })
    bws.on('close', (code) => {
      console.log(
        `[console-ws] relay close channel=${channel} machine=${machineId} code=${code} up=${upBytes}B down=${downBytes}B at=${new Date().toISOString()}`,
      )
      this.closeWsChannel(channel)
    })
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

  /**
   * Fail every in-flight relay owned by a node that just disconnected.
   * Browser WebSocket channels are closed (1011) so the browser's client
   * reconnects promptly instead of waiting forever on a silent channel, and
   * buffered HTTP relays error out immediately instead of hanging until the
   * idle timer. Without this, a mid-stream node drop leaves the console UI
   * stuck (e.g. "loading history…" that never settles) until a full reload.
   */
  private dropChannelsForMachine(machineId: string): void {
    const wsChannelsToClose: number[] = []
    for (const [channel, mid] of this.wsChannelNode) {
      if (mid === machineId) wsChannelsToClose.push(channel)
    }
    for (const channel of wsChannelsToClose) {
      const handler = this.wsChannels.get(channel)
      if (handler) {
        try {
          handler.onClose(1011)
        } catch {
          /* ignore */
        }
      }
      this.wsChannels.delete(channel)
      this.wsChannelNode.delete(channel)
    }

    const streamsToFail: number[] = []
    for (const [channel, mid] of this.streamsNode) {
      if (mid === machineId) streamsToFail.push(channel)
    }
    for (const channel of streamsToFail) {
      const s = this.streams.get(channel)
      if (s) {
        s.clear()
        try {
          s.handlers.onError(new Error('node disconnected'))
        } catch {
          /* ignore */
        }
      }
      this.streams.delete(channel)
      this.streamsNode.delete(channel)
    }

    const dropped = wsChannelsToClose.length + streamsToFail.length
    if (dropped > 0) {
      console.log(`[gateway] dropped ${dropped} relay channel(s) of disconnected node ${machineId}`)
    }
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
          .then(({ machineId: id, state }) => {
            machineId = id
            authed = true
            this.nodes.set(id, { ws, machineId: id, status: state, leaseExpiry: Date.now() + LEASE_TTL_MS, parser })
            console.log(`[gateway] node attached machineId=${id} state=${state} at=${new Date().toISOString()}`)
          })
          .catch((e) => console.log('[gateway] onboarding ERROR:', (e as Error).message ?? e))
        return
      }

      if (msg.type === 'heartbeat') {
        const node = this.nodes.get(msg.payload?.machineId)
        if (!node) return ws.close(4004, 'unknown machine')
        node.leaseExpiry = Date.now() + LEASE_TTL_MS
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'lease', payload: { ttlMs: LEASE_TTL_MS } }))
        this.recordHeartbeat(msg.payload).catch((e) => console.log('[gateway] heartbeat persist ERROR:', (e as Error).message ?? e))
        return
      }

      if (msg.type === DataType.RELAY_RESPONSE) {
        const s = this.streams.get(msg.payload?.channel)
        if (s) {
          s.arm()
          s.handlers.onResponse(msg.payload?.status ?? 502, msg.payload?.headers ?? {})
        }
        return
      }

      if (msg.type === DataType.RELAY_END) {
        const s = this.streams.get(msg.payload?.channel)
        if (s) {
          s.clear()
          this.streams.delete(msg.payload.channel)
          this.streamsNode.delete(msg.payload.channel)
          s.handlers.onEnd()
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

    ws.on('close', (code: number, reason: Buffer) => {
      if (machineId) {
        this.nodes.delete(machineId)
        this.dropChannelsForMachine(machineId)
      }
      console.log(
        `[gateway] node disconnected machineId=${machineId || '(unauthed)'} code=${code} reason=${reason.toString('utf8') || '-'} at=${new Date().toISOString()}`,
      )
    })
    ws.on('error', (e) => {
      console.log(
        `[gateway] node socket error machineId=${machineId || '(unauthed)'} err=${(e as Error).message ?? String(e)} at=${new Date().toISOString()}`,
      )
    })
  }

  private handleDataFrame(channel: number, data: Buffer): void {
    const s = this.streams.get(channel)
    if (s) {
      s.arm()
      s.handlers.onData(data)
    }
  }

  /** Persist durable health metadata on each heartbeat (accurate "last seen" + version). */
  private async recordHeartbeat(payload: { machineId?: string; dshVersion?: string }): Promise<void> {
    if (!payload?.machineId) return
    const m = await this.store.getMachine(payload.machineId)
    if (!m) return
    const patch = { ...m, lastHeartbeatAt: new Date().toISOString() }
    if (typeof payload.dshVersion === 'string' && payload.dshVersion) patch.dshVersion = payload.dshVersion
    await this.store.upsertMachine(patch)
  }

  /** Returns the authenticated machine id and its live status. */
  private async handleOnboarding(
    ws: WebSocketT,
    msg: any,
  ): Promise<{ machineId: string; state: MachineStatus }> {
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
        name: machineName ?? 'node',
        nodeKeyHash: sha256Hex(nodeKey),
        status: 'pending',
        dshVersion: dshVersion ?? '',
        configRev: 0,
        createdAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      })
      await this.store.consumePairingCode(codeHash, id)
      await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'node', machineId: id, action: 'register_pending', result: 'ok' })

      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'registration_status', payload: { state: 'pending', machineId: id, nodeKey } }))
      return { machineId: id, state: 'pending' }
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
      return { machineId: m.id, state }
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
