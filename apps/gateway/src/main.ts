import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { PROTOCOL_VERSION } from 'dsh-gateway-protocol'
import { SqliteStore } from 'dsh-gateway-store'
import { NodeRegistry } from './nodes.js'
import { registerRouter } from './router.js'
import { buildAuth, bootstrap, SESSION_COOKIE } from './auth.js'
import { registerControl } from './control.js'
import { registerUpdater } from './updater.js'
import { authorizeConsole, getCookie } from './authz.js'

const HOST = process.env.DSH_GATEWAY_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DSH_GATEWAY_PORT ?? 3300)
// Durable SQLite store (ADR-0007). Defaults to ./gateway.db; set DSH_GATEWAY_DB_PATH
// to ':memory:' for a throwaway run or to a custom file path.
const DB_PATH = process.env.DSH_GATEWAY_DB_PATH ?? './gateway.db'
// Bootstrap platform admin (created on first run).
const ADMIN_ID = process.env.DSH_GATEWAY_ADMIN_ID ?? 'admin'
const ADMIN_PASSWORD = process.env.DSH_GATEWAY_ADMIN_PASSWORD ?? 'admin'

const app = Fastify({ logger: true })

const store = new SqliteStore({ filename: DB_PATH })
await store.open()

// Ensure the bootstrap system admin exists.
await bootstrap(store, { adminId: ADMIN_ID, adminPassword: ADMIN_PASSWORD })
if (process.env.DSH_GATEWAY_ADMIN_PASSWORD === undefined) {
  app.log.warn('using default bootstrap admin password ("admin") — set DSH_GATEWAY_ADMIN_PASSWORD in production')
}

const auth = buildAuth()
const registry = new NodeRegistry(store)

// Seed one-time pairing codes for testing: DSH_GATEWAY_PAIRING_CODES="code,code,..."
for (const code of (process.env.DSH_GATEWAY_PAIRING_CODES ?? '').split(',').filter(Boolean)) {
  try {
    await registry.seedPairingCode(code)
  } catch (e) {
    app.log.warn(`failed to seed pairing code "${code}": ${String((e as Error).message ?? e)}`)
  }
}
registry.start()

// Console HTTP relay → node → local dsh web.
registerRouter(app, registry, store)

// Portal-user auth (session cookie + login/logout/me).
await auth.register(app, store)

// Control-plane REST API (users/machines/assignments/pairing-codes/seats/audit).
await registerControl(app, store, registry, auth)

// Version / hot-update API (git check + fast-forward pull + reload).
await registerUpdater(app, auth, store)

app.get('/health', async () => ({
  ok: true,
  service: 'deepseek-harness-gateway',
  version: '0.1.0',
  protocol: PROTOCOL_VERSION,
  connectedNodes: registry.connectedCount(),
}))

app.get('/nodes', async () => ({ nodes: await registry.listNodes() }))

// Portal static hosting — apps/web build output. The SPA is served at `/` and
// its assets at `/portal/*` (Vite base=/portal/), so the dsh web UI's absolute
// paths (/assets, /api, /plugins) fall through to the `/*` relay passthrough.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
const indexHtml = join(webDist, 'index.html')

// The SPA shell must always be fresh so a hot-updated build (new hashed assets)
// is picked up immediately instead of a stale cached copy. Re-check existence on
// every request: a hot-update rebuild can transiently remove dist/index.html, and
// a failed or interrupted build must degrade to a retryable 503 rather than a raw
// ENOENT 500 that never recovers.
app.get('/', async (_req, reply) => {
  if (!existsSync(indexHtml)) {
    app.log.warn('portal index.html missing — serving 503 (rebuild in progress or failed)')
    return reply
      .code(503)
      .type('text/html')
      .header('Cache-Control', 'no-store')
      .header('Retry-After', '5')
      .send('<!doctype html><html lang="en"><body><p>Portal is rebuilding — refresh in a few seconds.</p></body></html>')
  }
  return reply.type('text/html').header('Cache-Control', 'no-store').send(readFileSync(indexHtml))
})

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/portal/' })
} else {
  app.log.warn('apps/web/dist not built — portal static hosting disabled')
}

// /agent — outbound wss from dsh-gateway-agent (onboarding + heartbeat).
// /console/:machineId/* and the /* fallback — browser console WS, fail-closed
// behind the same assignment+seat check as the HTTP relay.
const wss = new WebSocketServer({ noServer: true })

async function handleBrowserUpgrade(req: any, socket: any, head: Buffer): Promise<void> {
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 80)
  const u = new URL(req.url ?? '/', 'http://console')
  const isConsole = u.pathname.startsWith('/console/')
  let machineId: string | undefined
  let upstreamPath: string
  if (isConsole) {
    const segs = u.pathname.split('/').filter(Boolean) // ['console', machineId, ...]
    if (segs.length < 2) {
      console.log(`[console-ws] upgrade rejected bad path=${u.pathname} ua=${ua} at=${new Date().toISOString()}`)
      return socket.destroy()
    }
    machineId = segs[1]
    upstreamPath = '/' + segs.slice(2).join('/') + u.search
  } else {
    machineId = registry.singleNodeId()
    upstreamPath = u.pathname + u.search
  }
  if (!machineId) {
    console.log(`[console-ws] upgrade rejected no machine path=${u.pathname} ua=${ua} at=${new Date().toISOString()}`)
    return socket.destroy()
  }

  const token = getCookie(req.headers.cookie, SESSION_COOKIE)
  const session = token ? auth.sessions.get(token) : undefined
  const user = session ? await store.getUser(session.userId) : undefined
  const res = await authorizeConsole(store, user, machineId)
  if (!res.allowed) {
    console.log(
      `[console-ws] upgrade denied machine=${machineId} path=${u.pathname} ua=${ua} reason=${res.error} at=${new Date().toISOString()}`,
    )
    return socket.destroy()
  }

  registry.upgradeBrowserWs(req, socket, head, machineId, upstreamPath)
}

app.server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/agent')) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    void handleBrowserUpgrade(req, socket, head)
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
