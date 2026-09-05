// Console HTTP relay: /console/:machineId/* → node → local dsh web (buffered).
// Absolute dsh paths (/api, /plugins, /assets, …) are served by a passthrough
// catch-all. Both paths are fail-closed behind the console authorization check
// (assignment, ADR-0004).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { IStore } from 'dsh-gateway-store'
import type { NodeRegistry } from './nodes.js'
import { authorizeConsole } from './authz.js'
import { SESSION_COOKIE, type Auth } from './auth.js'
import { CONSOLE_ADAPT_ENABLED, injectMobileAdapt, injectTransportOwnership } from './console-adapt.js'

const FORWARD_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const
const DROP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  // Browser trust-fence markers: the machine's dsh web is loopback-only and
  // rejects requests whose Origin/Referer/sec-fetch markers don't match its own
  // authority (the agent rewrites Host to 127.0.0.1:<port>, but the browser's
  // Origin still names the gateway). Strip them so the relayed request reads as
  // a clean same-origin loopback request.
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
])

function queryString(req: FastifyRequest): string {
  return req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : ''
}

export function relayHttp(
  registry: NodeRegistry,
  machineId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamPath: string,
): void {
  const started = Date.now()
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 80)
  const bodyUp = Buffer.isBuffer(req.body) ? (req.body as Buffer).length : 0
  let downBytes = 0
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_HEADERS.has(k.toLowerCase())) continue
    headers[k] = Array.isArray(v) ? v.join(', ') : v
  }

  // The node gzips text/html responses over 1KB when the browser advertises
  // Accept-Encoding, and console-HTML injection cannot inject into compressed
  // bytes. For document-like GETs (last path segment has no extension) ask the
  // node for identity so the index arrives plain, gets the injection applied,
  // and is streamed out uncompressed. Hashed asset requests keep compression.
  const lastSegment = (upstreamPath.split('?')[0] ?? '').split('/').pop() ?? ''
  const docLikeGet = req.method === 'GET' && !lastSegment.includes('.')
  if (docLikeGet) {
    delete headers['accept-encoding']
  }

  const body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined

  // Stream the relayed response through the raw socket (a buffered relay can't
  // carry long-lived SSE or slow machine-side queries). Fail-closed on error.
  // The one exception: GET pages the node answers as small text/html — those
  // are buffered and passed through the console-HTML injection helpers
  // (transport ownership + the portrait mobile-adapt layer; console-adapt.ts).
  reply.hijack()
  const raw = reply.raw

  // HTML-injection state. resHeaders are stashed because the transformed body
  // is only complete at onEnd, and the headers must be written with it.
  let htmlBuf: string | null = null // null = streaming mode
  let pendingStatus = 0
  let pendingHeaders: Record<string, string> | null = null
  const HTML_BUFFER_CAP = 256 * 1024
  // Console HTML is always injected (transport ownership) so the relayed page
  // reports its privileged surface as reachable; the portrait mobile-adapt
  // layer is folded in only while CONSOLE_ADAPT_ENABLED is set.
  const wantsInjection = req.method === 'GET'

  const fail = (e: unknown) => {
    console.log(
      `[relay] ${req.method} ${upstreamPath} machine=${machineId} ERROR ${(e as Error)?.message ?? String(e)} after ${Date.now() - started}ms up=${bodyUp}B down=${downBytes}B ua=${ua}`,
    )
    if (raw.headersSent) {
      // Headers already streamed — just close; the client sees a truncated body.
      raw.end()
      return
    }
    raw.writeHead(502, { 'content-type': 'application/json' })
    raw.end(JSON.stringify({ error: 'relay failed', detail: String((e as Error)?.message ?? e) }))
  }

  /** Decide at first response headers whether to buffer for injection. */
  const isHtmlForInjection = (status: number, resHeaders: Record<string, string>): boolean => {
    if (!wantsInjection) return false
    const type = (resHeaders['content-type'] ?? '').toLowerCase()
    if (!type.startsWith('text/html')) return false
    const encoding = (resHeaders['content-encoding'] ?? '').toLowerCase()
    if (encoding !== '' && encoding !== 'identity') return false
    return status >= 200 && status < 300
  }

  try {
    registry.relayStream(
      machineId,
      { method: req.method, path: upstreamPath, headers, body },
      {
        onResponse: (status, resHeaders) => {
          const out = { ...resHeaders }
          for (const k of ['content-length', 'transfer-encoding', 'connection']) delete out[k]
          if (isHtmlForInjection(status, resHeaders)) {
            htmlBuf = ''
            pendingStatus = status
            pendingHeaders = out
            return
          }
          raw.writeHead(status, out)
        },
        onData: (chunk) => {
          downBytes += chunk.length
          if (htmlBuf === null) {
            raw.write(chunk)
            return
          }
          if (htmlBuf.length + chunk.length > HTML_BUFFER_CAP) {
            // Oversized HTML: abandon injection and stream what we buffered.
            const out = pendingHeaders
            if (!raw.headersSent && out !== null) raw.writeHead(pendingStatus, out)
            pendingHeaders = null
            raw.write(Buffer.from(htmlBuf, 'utf8'))
            htmlBuf = null
            raw.write(chunk)
            return
          }
          htmlBuf += chunk.toString('utf8')
        },
        onEnd: () => {
          if (htmlBuf !== null) {
            const out = pendingHeaders
            // Never let HTTP caches (incl. vendor accelerator layers) reuse the
            // console document: an injected copy must always be what the browser
            // parses. Some vendor built-in browsers render a cached pre-injection
            // copy while the gateway still logs the upstream fetch.
            if (out !== null) {
              out['cache-control'] = 'no-store'
              delete out.etag
              delete out['last-modified']
            }
            const withTransport = injectTransportOwnership(htmlBuf)
            const bodyText = CONSOLE_ADAPT_ENABLED
              ? injectMobileAdapt(withTransport, { marker: upstreamPath.includes('mark=1') })
              : withTransport
            if (!raw.headersSent && out !== null) raw.writeHead(pendingStatus, out)
            pendingHeaders = null
            htmlBuf = null
            raw.end(bodyText, 'utf8')
            return
          }
          if (!raw.headersSent) raw.writeHead(200, { 'content-type': 'application/json' })
          raw.end()
        },
        onError: (err) => {
          fail(err)
        },
      },
    )
  } catch (e) {
    fail(e)
  }
}

export function registerRouter(app: FastifyInstance, registry: NodeRegistry, store: IStore, auth: Auth): void {
  // Register the relay under its own encapsulated scope so the raw-buffer body
  // parser only applies here — control-plane routes (app-level) keep Fastify's
  // default JSON parsing.
  app.register(async (scoped) => {
    // Accept any content type as a raw Buffer (the node re-serializes upstream).
    const rawBodyParser = (request: any, payload: any, done: (e: Error | null, body?: Buffer) => void) => {
      const chunks: Buffer[] = []
      payload.on('data', (c: Buffer) => chunks.push(c))
      payload.on('end', () => done(null, Buffer.concat(chunks)))
      payload.on('error', (e: Error) => done(e))
    }
    scoped.addContentTypeParser('*', rawBodyParser)
    scoped.addContentTypeParser('application/json', rawBodyParser)

    /** The console machine this session is bound to, or undefined. */
    const sessionMachine = (req: FastifyRequest): string | undefined => {
      const token = req.cookies?.[SESSION_COOKIE]
      return token ? auth.sessions.machineOf(token) : undefined
    }

    const consoleAuthz = async (req: FastifyRequest, reply: FastifyReply) => {
      const machineId = (req.params as any).machineId as string
      const res = await authorizeConsole(store, req.user, machineId)
      if (!res.allowed) return reply.code(res.status).send({ error: res.error, heldBy: res.heldBy })
      // Bind this session to the machine whose console it just opened. The
      // relayed page then issues its /api, /plugins, /assets and WebSocket
      // requests as machine-less absolute paths; those are routed to this
      // machine by the /* passthrough below (and the WS upgrade in main.ts).
      const token = req.cookies?.[SESSION_COOKIE]
      if (token) auth.sessions.bindMachine(token, machineId)
    }

    const singleNodeAuthz = async (req: FastifyRequest, reply: FastifyReply) => {
      const mid = sessionMachine(req) ?? registry.singleNodeId()
      if (!mid) return reply.code(503).send({ error: 'no connected node' })
      const res = await authorizeConsole(store, req.user, mid)
      if (!res.allowed) return reply.code(res.status).send({ error: res.error, heldBy: res.heldBy })
    }

    for (const method of FORWARD_METHODS) {
      scoped.route({
        method,
        url: '/console/:machineId/*',
        preHandler: consoleAuthz,
        handler: (req, reply) =>
          relayHttp(registry, (req.params as any).machineId, req, reply, '/' + ((req.params as any)['*'] || '') + queryString(req)),
      })
      scoped.route({
        method,
        url: '/console/:machineId',
        preHandler: consoleAuthz,
        handler: (req, reply) => relayHttp(registry, (req.params as any).machineId, req, reply, '/' + queryString(req)),
      })
    }

    // Machine-less passthrough: relay the absolute dsh paths (/api, /plugins,
    // /assets, …) the console page issues. These carry no machineId, so route
    // them to the session's bound machine first; fall back to the single-node
    // passthrough for sessions that haven't opened a console (or the portal).
    for (const method of FORWARD_METHODS) {
      scoped.route({
        method,
        url: '/*',
        preHandler: singleNodeAuthz,
        handler: async (req, reply) => {
          const mid = sessionMachine(req) ?? registry.singleNodeId()
          if (!mid) return reply.code(503).send({ error: 'no connected node' })
          await relayHttp(registry, mid, req, reply, req.raw.url ?? '/')
        },
      })
    }
  })
}
