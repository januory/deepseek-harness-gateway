// Console HTTP relay: /console/:machineId/* → node → local dsh web (buffered).
// Absolute dsh paths (/api, /plugins, /assets, …) are served by a single-node
// passthrough catch-all. Both paths are fail-closed behind the console
// authorization check (assignment + seat, ADR-0004/0005).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { IStore } from 'dsh-gateway-store'
import type { NodeRegistry } from './nodes.js'
import { authorizeConsole } from './authz.js'

const FORWARD_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const
const DROP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
])

function queryString(req: FastifyRequest): string {
  return req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : ''
}

export async function relayHttp(
  registry: NodeRegistry,
  machineId: string,
  req: FastifyRequest,
  reply: FastifyReply,
  upstreamPath: string,
): Promise<void> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_HEADERS.has(k.toLowerCase())) continue
    headers[k] = Array.isArray(v) ? v.join(', ') : v
  }

  const body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined

  try {
    const res = await registry.relay(machineId, { method: req.method, path: upstreamPath, headers, body })
    const out = { ...res.headers }
    for (const k of ['content-length', 'transfer-encoding', 'connection']) delete out[k]
    reply.code(res.status).headers(out).send(res.body)
  } catch (e) {
    reply.code(502).send({ error: 'relay failed', detail: String(e) })
  }
}

export function registerRouter(app: FastifyInstance, registry: NodeRegistry, store: IStore): void {
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

    const consoleAuthz = async (req: FastifyRequest, reply: FastifyReply) => {
      const machineId = (req.params as any).machineId as string
      const res = await authorizeConsole(store, req.user, machineId)
      if (!res.allowed) return reply.code(res.status).send({ error: res.error, heldBy: res.heldBy })
    }

    const singleNodeAuthz = async (req: FastifyRequest, reply: FastifyReply) => {
      const mid = registry.singleNodeId()
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

    // Single-node passthrough: relay absolute dsh paths (/api, /plugins, /assets, …).
    for (const method of FORWARD_METHODS) {
      scoped.route({
        method,
        url: '/*',
        preHandler: singleNodeAuthz,
        handler: async (req, reply) => {
          const mid = registry.singleNodeId()
          if (!mid) return reply.code(503).send({ error: 'no connected node' })
          await relayHttp(registry, mid, req, reply, req.raw.url ?? '/')
        },
      })
    }
  })
}
