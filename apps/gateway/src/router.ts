// Console HTTP relay: /console/:machineId/* → node → local dsh web (P0, buffered).
// Absolute dsh paths (/api, /plugins, /assets, …) are served by a single-node
// passthrough catch-all, so the dsh WebUI works under any gateway path prefix.
// Authz (assignment + seat, ADR-0005) lands in P1.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { NodeRegistry } from './nodes.js'

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

export function registerRouter(app: FastifyInstance, registry: NodeRegistry): void {
  // Accept any content type as a raw Buffer (the node re-serializes upstream).
  // `application/json` is registered explicitly because Fastify's built-in JSON
  // parser would otherwise win over `*` and turn the body into an object.
  const rawBodyParser = (request: any, payload: any, done: (e: Error | null, body?: Buffer) => void) => {
    const chunks: Buffer[] = []
    payload.on('data', (c: Buffer) => chunks.push(c))
    payload.on('end', () => done(null, Buffer.concat(chunks)))
    payload.on('error', (e: Error) => done(e))
  }
  app.addContentTypeParser('*', rawBodyParser)
  app.addContentTypeParser('application/json', rawBodyParser)

  for (const method of FORWARD_METHODS) {
    app.route({
      method,
      url: '/console/:machineId/*',
      handler: (req, reply) =>
        relayHttp(registry, (req.params as any).machineId, req, reply, '/' + ((req.params as any)['*'] || '') + queryString(req)),
    })
    app.route({
      method,
      url: '/console/:machineId',
      handler: (req, reply) => relayHttp(registry, (req.params as any).machineId, req, reply, '/' + queryString(req)),
    })
  }

  // Single-node passthrough: relay absolute dsh paths (/api, /plugins, /assets, …).
  for (const method of FORWARD_METHODS) {
    app.route({
      method,
      url: '/*',
      handler: async (req, reply) => {
        const mid = registry.singleNodeId()
        if (!mid) return reply.code(503).send({ error: 'no connected node' })
        await relayHttp(registry, mid, req, reply, req.raw.url ?? '/')
      },
    })
  }
}
