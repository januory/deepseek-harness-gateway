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
  DAEMON_CONTROL_TIMEOUT_MS,
  DataKind,
  DataType,
  DaemonType,
  NodeRole,
  normalizeDaemonState,
  normalizeRole,
  challenge,
  encodeFrame,
  encodeBinaryFrame,
  BinaryFrameParser,
} from 'dsh-gateway-protocol'
import type { IStore, MachineStatus } from 'dsh-gateway-store'
import { DaemonControlRegistry } from './daemon-control.js'

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

interface ConnectedNode {
  ws: WebSocketT
  machineId: string
  role: string
  status: MachineStatus
  leaseExpiry: number
  parser: BinaryFrameParser
  /** Last daemon state the supervisor reported (DaemonState); console nodes keep ''. */
  daemonState: string
  /** Control action behind that state (start/stop/restart), for finer labels. */
  daemonAction: string
  /** Whether the machine has daemon supervision enabled in its own config. */
  daemonEnabled: boolean
}

/**
 * A machine can hold two sockets at once: the `console` plugin (data plane) and
 * the standalone `supervisor` (dsh lifecycle). Keying the live map by
 * machineId+role keeps both, so stopping dsh does not detach the supervisor.
 */
function nodeKey(machineId: string, role: string): string {
  return `${machineId}:${role}`
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
  private daemonControls = new DaemonControlRegistry({
    timeoutMs: DAEMON_CONTROL_TIMEOUT_MS,
    onTimeout: (id, action) =>
      console.log(`[gateway] daemon control timed out id=${id} action=${action} at=${new Date().toISOString()}`),
  })
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
    this.daemonControls.failAll('gateway shutting down')
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
    return this.nodes.has(nodeKey(machineId, NodeRole.CONSOLE)) || this.nodes.has(nodeKey(machineId, NodeRole.SUPERVISOR))
  }

  /** True when the data-plane plugin (inside dsh) holds a live socket. */
  isConsoleConnected(machineId: string): boolean {
    return this.nodes.has(nodeKey(machineId, NodeRole.CONSOLE))
  }

  /** True when the machine's lifecycle supervisor holds a live socket. */
  isSupervisorConnected(machineId: string): boolean {
    return this.nodes.has(nodeKey(machineId, NodeRole.SUPERVISOR))
  }

  /** The live console socket for a machine (data plane relay target), if any. */
  private consoleNode(machineId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeKey(machineId, NodeRole.CONSOLE))
  }

  private supervisorNode(machineId: string): ConnectedNode | undefined {
    return this.nodes.get(nodeKey(machineId, NodeRole.SUPERVISOR))
  }

  /**
   * Live daemon picture for the portal. `connected` reflects the supervisor
   * socket; `state` is what the supervisor last reported (falling back to the
   * persisted value when no supervisor is connected).
   */
  daemonStatus(machineId: string): { connected: boolean; enabled: boolean; state: string; action: string } {
    const node = this.supervisorNode(machineId)
    if (!node) return { connected: false, enabled: false, state: '', action: '' }
    return {
      connected: true,
      enabled: node.daemonEnabled,
      state: normalizeDaemonState(node.daemonState),
      action: node.daemonAction || '',
    }
  }

  /**
   * Ask a machine's supervisor to start/stop/restart dsh. Rejects when the
   * machine has no supervisor socket or the supervisor does not answer within
   * the control timeout.
   */
  async controlDaemon(machineId: string, action: string): Promise<{ ok: boolean; state?: string; error?: string }> {
    const node = this.supervisorNode(machineId)
    if (!node) throw new Error('machine has no supervisor connected')
    const { id, promise } = this.daemonControls.register(action)
    try {
      node.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DaemonType.DAEMON_CONTROL, payload: { id, action } }))
    } catch (e) {
      this.daemonControls.settle(id, { ok: false, error: String((e as Error).message ?? e) })
    }
    const result = await promise
    // The supervisor answers with the state it just reached; apply it to the live
    // node right away. Otherwise the portal badge and the 启动/关闭 button keep the
    // pre-click state until the next heartbeat (15s), so a click looks dead.
    if (result.ok) this.applyDaemonControlState(machineId, result.state, action)
    return result
  }

  /** Record a supervisor's post-action state on the live node (portal freshness). */
  applyDaemonControlState(machineId: string, state: string | null | undefined, action = ''): void {
    if (!state) return
    const node = this.supervisorNode(machineId)
    if (!node) return
    node.daemonState = normalizeDaemonState(state)
    node.daemonAction = action
  }

  /** Live nodes: machineId → { status, role }. */
  listConnected(): Array<{ machineId: string; status: MachineStatus; role: string }> {
    return [...this.nodes.values()].map((n) => ({ machineId: n.machineId, status: n.status, role: n.role }))
  }

  /** List machines for the portal/admin (durable metadata). */
  async listNodes(): Promise<Array<{ machineId: string; name?: string; dshVersion?: string }>> {
    const out: Array<{ machineId: string; name?: string; dshVersion?: string }> = []
    for (const node of this.nodes.values()) {
      const m = await this.store.getMachine(node.machineId)
      out.push({ machineId: node.machineId, name: m?.name, dshVersion: m?.dshVersion })
    }
    return out
  }

  /** Approve a pending machine; if it is connected, promote + notify it live. */
  async approveMachine(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) throw new Error('machine not found')
    if (m.status !== 'pending') throw new Error('machine is not pending')
    await this.store.upsertMachine({ ...m, status: 'approved' })
    // Both sockets (console plugin + supervisor) must learn about the approval.
    for (const node of this.nodes.values()) {
      if (node.machineId !== machineId) continue
      node.status = 'approved'
      node.ws.send(
        JSON.stringify({ v: PROTOCOL_VERSION, type: 'registration_status', payload: { state: 'approved', machineId, leaseMs: LEASE_TTL_MS } }),
      )
    }
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', machineId, action: 'approve_machine', result: 'ok' })
  }

  /** Revoke a machine and drop its live connections. */
  async revokeMachine(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) throw new Error('machine not found')
    await this.store.upsertMachine({ ...m, status: 'revoked' })
    for (const [key, node] of [...this.nodes]) {
      if (node.machineId !== machineId) continue
      node.ws.close(4003, 'machine revoked')
      this.nodes.delete(key)
    }
    this.daemonControls.failAll('machine revoked')
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', machineId, action: 'revoke_machine', result: 'ok' })
  }

  /** Delete a machine record entirely; drops its live connections if any. */
  async deleteMachine(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) throw new Error('machine not found')
    for (const [key, node] of [...this.nodes]) {
      if (node.machineId !== machineId) continue
      node.ws.close(4000, 'machine deleted')
      this.nodes.delete(key)
    }
    this.daemonControls.failAll('machine deleted')
    await this.store.deleteMachine(machineId)
    await this.store.appendAudit({ ts: new Date().toISOString(), actor: 'admin', machineId, action: 'delete_machine', result: 'ok' })
  }

  /** Relay an HTTP request to a connected, approved node and stream the response. */
  relayStream(machineId: string, req: RelayRequest, handlers: RelayStreamHandlers): void {
    const node = this.consoleNode(machineId)
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

  /** Machine id when exactly one APPROVED console node is connected (single-node passthrough). */
  singleNodeId(): string | undefined {
    let found: string | undefined
    for (const node of this.nodes.values()) {
      if (node.role !== NodeRole.CONSOLE) continue
      if (node.status !== 'approved') continue
      if (found !== undefined) return undefined
      found = node.machineId
    }
    return found
  }

  /** Relay any browser WebSocket upgrade to a node at an arbitrary upstream path. */
  upgradeBrowserWs(req: IncomingMessage, socket: Duplex, head: Buffer, machineId: string, upstreamPath: string): void {
    const node = this.consoleNode(machineId)
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
    const ua = (headers['user-agent'] || '').slice(0, 80)
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
    } catch (e) {
      console.log(
        `[console-ws] relay open FAILED machine=${machineId} path=${restPath} ua=${ua} err=${(e as Error).message ?? String(e)} at=${new Date().toISOString()}`,
      )
      bws.close(1011)
      return
    }

    bws.on('message', (data, isBinary) => {
      const d = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      this.sendWs(channel, isBinary ? DataKind.BINARY : DataKind.TEXT, d)
    })
    bws.on('close', () => {
      this.closeWsChannel(channel)
    })
  }

  private relayWsOpen(machineId: string, path: string, headers: Record<string, string>, handler: WsChannelHandler): number {
    const node = this.consoleNode(machineId)
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
    const node = mid ? this.consoleNode(mid) : undefined
    if (node) node.ws.send(encodeFrame(kind, channel, 0, data))
  }

  private closeWsChannel(channel: number): void {
    const mid = this.wsChannelNode.get(channel)
    const node = mid ? this.consoleNode(mid) : undefined
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
    let role: string = NodeRole.CONSOLE
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
          .then(({ machineId: id, state, role: nodeRole }) => {
            machineId = id
            role = nodeRole
            authed = true
            this.nodes.set(nodeKey(id, nodeRole), {
              ws,
              machineId: id,
              role: nodeRole,
              status: state,
              leaseExpiry: Date.now() + LEASE_TTL_MS,
              parser,
              daemonState: '',
              daemonAction: '',
              daemonEnabled: false,
            })
            console.log(
              `[gateway] node attached machineId=${id} state=${state} role=${nodeRole} at=${new Date().toISOString()}`,
            )
          })
          .catch((e) => console.log('[gateway] onboarding ERROR:', (e as Error).message ?? e))
        return
      }

      if (msg.type === 'heartbeat') {
        // Route by this socket's own identity, never by the payload's machineId:
        // a machine can hold a console and a supervisor socket at the same time.
        const node = this.nodes.get(nodeKey(machineId, role))
        if (!node) return ws.close(4004, 'unknown machine')
        const payload = msg.payload ?? {}
        node.leaseExpiry = Date.now() + LEASE_TTL_MS
        node.daemonState = normalizeDaemonState(payload.daemonState ?? payload.daemon?.state)
        if (typeof payload.daemonAction === 'string') node.daemonAction = payload.daemonAction
        node.daemonEnabled = payload.daemonEnabled === true || payload.daemon?.enabled === true
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'lease', payload: { ttlMs: LEASE_TTL_MS } }))
        this.recordHeartbeat(node, payload).catch((e) =>
          console.log('[gateway] heartbeat persist ERROR:', (e as Error).message ?? e),
        )
        return
      }

      if (msg.type === DaemonType.DAEMON_RESULT) {
        this.daemonControls.settle(msg.payload?.id, {
          ok: msg.payload?.ok !== false,
          state: typeof msg.payload?.state === 'string' ? msg.payload.state : undefined,
          error: typeof msg.payload?.error === 'string' ? msg.payload.error : undefined,
        })
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
        const key = nodeKey(machineId, role)
        // Only drop the entry if it still belongs to THIS socket: a reconnect
        // may already have replaced it, and we must not evict the fresh one.
        if (this.nodes.get(key)?.ws === ws) this.nodes.delete(key)
        this.dropChannelsForMachine(machineId)
        if (role === NodeRole.SUPERVISOR) {
          this.daemonControls.failAll('supervisor disconnected')
          // Remember the last lifecycle intent so a portal rendered after the
          // drop still shows "stopped" rather than falling back to unknown.
          this.persistDaemonState(machineId).catch(() => {})
        }
      }
      console.log(
        `[gateway] node disconnected machineId=${machineId || '(unauthed)'} role=${role} code=${code} reason=${reason.toString('utf8') || '-'} at=${new Date().toISOString()}`,
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

  /**
   * Persist durable health metadata on each heartbeat (accurate "last seen" +
   * version). The console socket owns dshVersion; the supervisor socket owns the
   * daemon columns — neither may clobber the other's fields, so each heartbeat
   * writes only what its own role is authoritative for.
   */
  private async recordHeartbeat(
    node: ConnectedNode,
    payload: { machineId?: string; dshVersion?: string; agentVersion?: string },
  ): Promise<void> {
    const m = await this.store.getMachine(node.machineId)
    if (!m) return
    const patch = { ...m, lastHeartbeatAt: new Date().toISOString() }
    if (node.role === NodeRole.SUPERVISOR) {
      patch.daemonState = node.daemonState
      patch.daemonEnabled = node.daemonEnabled
    } else if (typeof payload.dshVersion === 'string' && payload.dshVersion) {
      patch.dshVersion = payload.dshVersion
    }
    await this.store.upsertMachine(patch)
  }

  /** Persist the supervisor's last known daemon state (used on disconnect). */
  private async persistDaemonState(machineId: string): Promise<void> {
    const m = await this.store.getMachine(machineId)
    if (!m) return
    const state = m.daemonState
    if (!state) return
    await this.store.upsertMachine({ ...m, daemonState: state })
  }

  /** Returns the authenticated machine id, its live status and its socket role. */
  private async handleOnboarding(
    ws: WebSocketT,
    msg: any,
  ): Promise<{ machineId: string; state: MachineStatus; role: string }> {
    const { code, machineId, nodeKey, machineName, dshVersion, role } = msg.payload ?? {}
    const nodeRole = normalizeRole(role)
    console.log(
      '[gateway] onboarding',
      code ? 'code=' + String(code).slice(0, 8) : 'reconnect machineId=' + machineId,
      'role=' + nodeRole,
    )

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
      return { machineId: id, state: 'pending', role: nodeRole }
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
      return { machineId: m.id, state, role: nodeRole }
    }

    ws.close(4001, 'expected pairing code or machineId+nodeKey')
    throw new Error('expected auth')
  }

  private expire(): void {
    const now = Date.now()
    for (const [key, node] of this.nodes) {
      if (now > node.leaseExpiry) {
        node.ws.close(4005, 'lease expired')
        this.nodes.delete(key)
      }
    }
  }
}
