// dsh-gateway-agent — host half（Node 面）。
//
// P0：出站 wss + HMAC 入网握手 + 心跳/租约 + 数据面 HTTP 中继（把网关转发的
// 浏览器请求打到本机 dsh web，重写 Host 为 loopback，注入机器操作员凭据）。
// WS/SSE 流式中继与凭据的完整托管在下一增量（ADR-0003/0004）。
// 铁律（参照 dsh-remote-workspaces）：不 import @deepseek-ai/* 内部包。

import http from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import WebSocket from 'ws'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  ControlType,
  DataType,
  DataKind,
  signChallenge,
  encodeFrame,
  encodeBinaryFrame,
  BinaryFrameParser,
} from './protocol.js'

export const name = 'dsh-gateway-agent'

const PACKAGE = 'dsh-gateway-agent'
const NAMESPACE = 'gatewayAgent'

// ---------------------------------------------------------------------------
// Config (plain JSON for P0; AES-GCM secret handling per ADR-0010 lands next).
// ---------------------------------------------------------------------------
function configDir() {
  const fromEnv = process.env.DSH_HOME
  const base = fromEnv && String(fromEnv).trim().length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
  return join(base, PACKAGE)
}
function configPath() {
  return join(configDir(), 'config.json')
}
function loadConfig() {
  try {
    if (existsSync(configPath())) {
      const raw = readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '')
      return JSON.parse(raw)
    }
  } catch {
    /* ignore corrupt config */
  }
  return {}
}
function saveConfig(cfg) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

/**
 * Programmatically mint the operator browser-session cookie for loopback
 * authority `127.0.0.1:<dshPort>` using the in-process Connection service
 * (ADR-0010 B3(b)). The cookie is signed by the persistent credential secret,
 * so it stays valid across dsh restarts (only the launch token rotates).
 * @param {{authenticatedUrl(baseUrl: string): string; authorizeIndex(req: unknown, res: unknown): unknown}} connection
 * @param {number} dshPort
 * @returns {string | undefined} cookie header value, or undefined on failure.
 */
export function mintOperatorCookie(connection, dshPort) {
  const authority = `127.0.0.1:${dshPort}`
  const launchUrl = new URL(connection.authenticatedUrl(`http://${authority}`))
  let cookie
  const res = {
    writeHead(_code, headers) {
      const sc = headers && headers['set-cookie']
      if (typeof sc === 'string') cookie = sc.split(';', 1)[0]
    },
    end() {},
  }
  connection.authorizeIndex(
    { url: launchUrl.pathname + launchUrl.search, method: 'GET', headers: { host: authority } },
    res,
  )
  return cookie
}

// ---------------------------------------------------------------------------
// Outbound connection + data-plane bridge.
// ---------------------------------------------------------------------------
class Connection {
  constructor(onState, mintCookie) {
    this.ws = null
    this.state = 'unconfigured'
    this.machineId = null
    this.lastError = null
    this.heartbeat = null
    this.operatorCookie = ''
    this.configOperatorCookie = ''
    this.dshPort = 3080
    this.onState = onState
    this.mintCookie = typeof mintCookie === 'function' ? mintCookie : null
    this.parser = new BinaryFrameParser()
    this.pendingBodies = new Map() // channel -> { expected, chunks }
    this.wsUpstreams = new Map() // channel -> { u, queue }
  }

  setState(s) {
    this.state = s
    if (this.onState) this.onState()
  }

  connect(gatewayUrl, code, config) {
    this.stop()
    if (!gatewayUrl) {
      this.setState('unconfigured')
      return
    }
    this.dshPort = (config && config.dshPort) || 3080
    this.configOperatorCookie = (config && config.operatorCookie) || ''

    // Re-mint the operator cookie before EVERY connection attempt (boot AND
    // reconnect), so a bad/expired boot cookie self-heals on the next connect.
    if (this.mintCookie) {
      try {
        const fresh = this.mintCookie()
        if (fresh) this.operatorCookie = fresh
      } catch {
        /* keep the previous cookie */
      }
    }

    this.setState('connecting')

    let ws
    try {
      ws = new WebSocket(gatewayUrl)
    } catch (e) {
      this.lastError = String(e && e.message ? e.message : e)
      this.setState('error')
      return
    }
    this.ws = ws

    ws.on('message', (raw, isBinary) => {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      if (!isBinary) console.log('[dsh-gateway-agent] msg:', data.toString('utf8').slice(0, 80))
      if (isBinary) {
        for (const frame of this.parser.push(data)) {
          const e = this.wsUpstreams.get(frame.channel)
          if (e) {
            if (e.u.readyState === WebSocket.OPEN) e.u.send(frame.data, { binary: frame.kind === DataKind.BINARY })
            else e.queue.push({ data: frame.data, binary: frame.kind === DataKind.BINARY })
          } else {
            this.collectRequestBody(frame)
          }
        }
        return
      }

      let msg
      try {
        msg = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }

      console.log('[dsh-gateway-agent] recv', msg.type, msg.payload && msg.payload.path ? msg.payload.path : '')

      if (msg.type === ControlType.CHALLENGE) {
        const signature = signChallenge(code ?? '', msg.payload.nonce)
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: ControlType.CHALLENGE_RESPONSE,
            payload: { nonce: msg.payload.nonce, signature, code: code ?? '' },
          }),
        )
      } else if (msg.type === ControlType.REGISTRATION_STATUS) {
        if (msg.payload.state === 'approved') {
          this.machineId = msg.payload.machineId
          this.setState('online')
          this.heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  v: PROTOCOL_VERSION,
                  type: ControlType.HEARTBEAT,
                  payload: { machineId: this.machineId },
                }),
              )
            }
          }, HEARTBEAT_INTERVAL_MS)
        } else {
          this.lastError = msg.payload.reason ?? msg.payload.state
          this.setState('error')
        }
      } else if (msg.type === ControlType.LEASE) {
        // lease extended; nothing to persist for now
      } else if (msg.type === DataType.RELAY_REQUEST) {
        this.handleRelayRequest(ws, msg.payload)
      } else if (msg.type === DataType.RELAY_WS_OPEN) {
        this.handleWsOpen(ws, msg.payload)
      } else if (msg.type === DataType.RELAY_WS_CLOSE) {
        const e = this.wsUpstreams.get(msg.payload.channel)
        if (e) e.u.terminate()
        this.wsUpstreams.delete(msg.payload.channel)
      }
    })

    ws.on('close', (closeCode) => {
      this.setState('error')
      this.lastError = 'connection closed (' + closeCode + ')'
      this.scheduleReconnect(gatewayUrl, code, config)
    })
    ws.on('error', (e) => {
      this.lastError = e && e.message ? e.message : String(e)
      this.setState('error')
    })
  }

  scheduleReconnect(gatewayUrl, code, config) {
    this.stop()
    setTimeout(() => this.connect(gatewayUrl, code, config), 5000)
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  setOperatorCookie(cookie) {
    if (cookie) this.operatorCookie = cookie
  }

  // Request bodies arrive as binary frames after the relay_request JSON.
  collectRequestBody(frame) {
    const p = this.pendingBodies.get(frame.channel)
    if (!p) return
    p.chunks.push(frame.data)
    const total = p.chunks.reduce((n, c) => n + c.length, 0)
    if (total >= p.expected) {
      this.pendingBodies.delete(frame.channel)
      const body = Buffer.concat(p.chunks)
      this.forwardUpstream(p.ws, p.channel, p.method, p.path, p.headers, body)
    }
  }

  handleRelayRequest(ws, payload) {
    const { channel, method, path, headers, contentLength } = payload
    if ((contentLength ?? 0) === 0) {
      this.forwardUpstream(ws, channel, method, path, headers, Buffer.alloc(0))
    } else {
      this.pendingBodies.set(channel, { expected: contentLength, chunks: [], ws, channel, method, path, headers })
    }
  }

  effectiveCookie() {
    return this.operatorCookie || this.configOperatorCookie
  }

  forwardUpstream(ws, channel, method, path, headers, body, retried) {
    console.log('[dsh-gateway-agent] forward', method, path, 'dshPort=', this.dshPort)
    const reqHeaders = { ...(headers || {}), host: `127.0.0.1:${this.dshPort}` }
    const cookie = this.effectiveCookie()
    if (cookie) reqHeaders.cookie = cookie

    const ureq = http.request(
      { host: '127.0.0.1', port: this.dshPort, method, path, headers: reqHeaders },
      (res) => {
        // Self-heal: on 401, re-mint the operator cookie and retry once.
        if (res.statusCode === 401 && !retried && this.mintCookie) {
          let fresh
          try {
            fresh = this.mintCookie()
          } catch {
            fresh = undefined
          }
          if (fresh && fresh !== cookie) {
            this.operatorCookie = fresh
            res.resume() // discard the 401 body; only the retry sends a response
            this.forwardUpstream(ws, channel, method, path, headers, body, true)
            return
          }
        }
        if (res.statusCode && res.statusCode >= 400) {
          console.log('[dsh-gateway-agent] upstream', res.statusCode, method, path, 'cookie=', cookie ? cookie.slice(0, 24) : 'MISSING', 'dshPort=', this.dshPort)
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const resBody = Buffer.concat(chunks)
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: DataType.RELAY_RESPONSE,
              payload: { channel, status: res.statusCode, headers: res.headers },
            }),
          )
          if (resBody.length > 0) ws.send(encodeBinaryFrame(channel, 0, resBody))
          ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_END, payload: { channel } }))
        })
      },
    )
    ureq.on('error', (e) => {
      ws.send(
        JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_RESPONSE, payload: { channel, status: 502, headers: {} } }),
      )
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_END, payload: { channel } }))
    })
    ureq.end(body)
  }

  handleWsOpen(ws, payload) {
    const { channel, path, headers } = payload
    const wsHeaders = { ...(headers || {}) }
    const cookie = this.effectiveCookie()
    if (cookie) wsHeaders.cookie = cookie

    const u = new WebSocket(`ws://127.0.0.1:${this.dshPort}${path}`, { headers: wsHeaders })
    const entry = { u, queue: [] }
    this.wsUpstreams.set(channel, entry)

    u.on('open', () => {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_WS_OPEN_OK, payload: { channel } }))
      for (const f of entry.queue) u.send(f.data, { binary: f.binary })
      entry.queue = []
    })
    u.on('message', (data, isBinary) => {
      const d = Buffer.isBuffer(data) ? data : Buffer.from(data)
      ws.send(encodeFrame(isBinary ? DataKind.BINARY : DataKind.TEXT, channel, 0, d))
    })
    u.on('close', (c) => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: DataType.RELAY_WS_CLOSE, payload: { channel, code: c } })))
    u.on('error', () => {})
  }

  status() {
    return {
      state: this.state,
      machineId: this.machineId,
      lastError: this.lastError,
      version: '0.1.0',
    }
  }
}

// ---------------------------------------------------------------------------
// Remote contract (mirrors src/client.js — must match).
// ---------------------------------------------------------------------------
const JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'JsonValue',
  schema: Object.freeze({ parse(value) { return value } }),
})

function jsonParameter(paramName) {
  return { name: paramName, wire: paramName, source: 'json', codec: JSON_CODEC }
}

function invocation(method, parameters = []) {
  return {
    id: `${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: JSON_CODEC,
  }
}

const INVOCATIONS = [
  invocation('status'),
  invocation('getConfig'),
  invocation('applyConfig', [jsonParameter('config')]),
  invocation('onboard', [jsonParameter('gatewayUrl'), jsonParameter('pairingCode')]),
]

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------
export default function apply(ctx) {
  const cfg = loadConfig()
  const dshPort = cfg.dshPort || 3080

  let connectionService = null
  const mintCookie = () => {
    if (connectionService) {
      try {
        return mintOperatorCookie(connectionService, dshPort)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const conn = new Connection(() => {}, mintCookie)

  const service = {
    async status() {
      return { ok: true, value: conn.status() }
    },
    async getConfig() {
      return { ok: true, value: loadConfig() }
    },
    async applyConfig(config) {
      const cfg = { ...loadConfig(), ...(config || {}) }
      saveConfig(cfg)
      return { ok: true, value: { applied: true } }
    },
    async onboard(gatewayUrl, pairingCode) {
      const cfg = { ...loadConfig(), gatewayUrl, pairingCode }
      saveConfig(cfg)
      conn.connect(gatewayUrl, pairingCode, cfg)
      return { ok: true, value: conn.status() }
    },
  }
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })

  ctx.provide(NAMESPACE, service)

  ctx.inject(['typert'], (typertCtx) => {
    const typert = typertCtx.get('typert')
    if (typert && typeof typert.register === 'function') {
      typert.register({
        package: PACKAGE,
        face: 'host',
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: INVOCATIONS,
      })
    }
    return () => {}
  })

  // Auto-connect on boot if already configured.
  let connected = false
  const maybeConnect = () => {
    if (connected || !cfg.gatewayUrl) return
    connected = true
    conn.connect(cfg.gatewayUrl, cfg.pairingCode ?? '', cfg)
  }

  // Mint the operator browser-session cookie in-process (ADR-0010 B3(b)), then
  // connect only AFTER the cookie is ready — avoids a 401 race where the first
  // relayed request arrives before the async mint completes.
  ctx.inject(['connection'], (cctx) => {
    connectionService = cctx.get('connection')
    if (connectionService && typeof connectionService.authenticatedUrl === 'function' && typeof connectionService.authorizeIndex === 'function') {
      const cookie = mintCookie()
      if (cookie) {
        conn.setOperatorCookie(cookie)
        console.log('[dsh-gateway-agent] operator cookie ready')
      } else {
        console.log('[dsh-gateway-agent] operator cookie NOT minted')
      }
    } else {
      console.log('[dsh-gateway-agent] connection service unavailable')
    }
    maybeConnect()
    return () => {}
  })
}
