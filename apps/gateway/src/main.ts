import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION } from 'dsh-gateway-protocol'
import { SqliteStore } from 'dsh-gateway-store'
import { NodeRegistry } from './nodes.js'
import { registerRouter } from './router.js'

const HOST = process.env.GATEWAY_HOST ?? '127.0.0.1'
const PORT = Number(process.env.GATEWAY_PORT ?? 3300)
// Durable SQLite store (ADR-0007). Defaults to ./gateway.db; set GATEWAY_DB_PATH
// to ':memory:' for a throwaway run or to a custom file path.
const DB_PATH = process.env.GATEWAY_DB_PATH ?? './gateway.db'

const app = Fastify({ logger: true })

const store = new SqliteStore({ filename: DB_PATH })
await store.open()

const registry = new NodeRegistry(store)

// Seed one-time pairing codes for testing: GATEWAY_PAIRING_CODES="code:tenantId,..."
for (const entry of (process.env.GATEWAY_PAIRING_CODES ?? '').split(',').filter(Boolean)) {
  const [code, tenantId] = entry.split(':')
  if (code && tenantId) registry.seedPairingCode(code, tenantId)
}
registry.start()

// Console HTTP relay → node → local dsh web.
registerRouter(app, registry)

app.get('/health', async () => ({
  ok: true,
  service: 'deepseek-harness-gateway',
  version: '0.1.0',
  protocol: PROTOCOL_VERSION,
  connectedNodes: registry.connectedCount(),
}))

app.get('/nodes', async () => ({ nodes: await registry.listNodes() }))

// Portal static hosting — apps/web build output; skipped until built.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' })
} else {
  app.log.warn('apps/web/dist not built — portal static hosting disabled')
}

// /agent — outbound wss from dsh-gateway-agent (onboarding + heartbeat).
// /console/:machineId/* — browser console (HTTP relay + WS stream relay).
const wss = new WebSocketServer({ noServer: true })
app.server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/agent')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else if (req.url?.startsWith('/console/')) {
    registry.handleConsoleUpgrade(req, socket, head)
  } else {
    const mid = registry.singleNodeId()
    if (mid) {
      const u = new URL(req.url ?? '/', 'http://console')
      registry.upgradeBrowserWs(req, socket, head, mid, u.pathname + u.search)
    } else {
      socket.destroy()
    }
  }
})
wss.on('connection', (ws) => registry.attach(ws))

await app.listen({ host: HOST, port: PORT })
app.log.info(`gateway listening on http://${HOST}:${PORT}`)

// Best-effort shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    registry.stop()
    await app.close()
    await store.close()
    process.exit(0)
  })
}
