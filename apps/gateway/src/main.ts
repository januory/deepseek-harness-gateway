import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

// ---------------------------------------------------------------------------
// Runtime config: CLI flag > environment variable > default.
// `dshgw` (the published bundle) accepts these as flags; dev/docker run
// `tsx src/main.ts` and pass no flags, so the CLI layer is inert there.
// ---------------------------------------------------------------------------
const CLI_MAP: Record<string, string> = {
  host: 'DSH_GATEWAY_HOST',
  port: 'DSH_GATEWAY_PORT',
  db: 'DSH_GATEWAY_DB_PATH',
  'admin-id': 'DSH_GATEWAY_ADMIN_ID',
  'admin-password': 'DSH_GATEWAY_ADMIN_PASSWORD',
  'pairing-codes': 'DSH_GATEWAY_PAIRING_CODES',
  'web-dist': 'DSH_GATEWAY_WEB_DIST',
}
function cliConfig(): Record<string, string> {
  const out: Record<string, string> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      console.log(
        [
          'dshgw — start the deepseek-harness-gateway server',
          '',
          'Usage: dshgw [options]',
          '',
          'Options (CLI flag > env var > default):',
          '  --host <addr>            bind host                (DSH_GATEWAY_HOST,           default 127.0.0.1)',
          '  --port <n>               bind port                (DSH_GATEWAY_PORT,           default 3300)',
          '  --db <path>              sqlite db path           (DSH_GATEWAY_DB_PATH,        default ./gateway.db)',
          '  --admin-id <id>          bootstrap admin id       (DSH_GATEWAY_ADMIN_ID,       default admin)',
          '  --admin-password <pw>    bootstrap admin password (DSH_GATEWAY_ADMIN_PASSWORD, default admin)',
          '  --pairing-codes <a,b>    seed onboarding codes    (DSH_GATEWAY_PAIRING_CODES)',
          '  --web-dist <dir>         portal static dir        (DSH_GATEWAY_WEB_DIST)',
          '  -h, --help               show this help and exit',
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
    const key = arg.replace(/^--/, '')
    const env = CLI_MAP[key]
    if (env === undefined) {
      if (arg.startsWith('--')) console.error(`[dshgw] unknown option: ${arg} (try --help)`)
      continue
    }
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) {
      console.error(`[dshgw] missing value for ${arg}`)
      process.exit(1)
    }
    out[env] = val
    i++
  }
  return out
}
const CLI = cliConfig()

const HOST = CLI.DSH_GATEWAY_HOST ?? process.env.DSH_GATEWAY_HOST ?? '127.0.0.1'
const PORT = Number(CLI.DSH_GATEWAY_PORT ?? process.env.DSH_GATEWAY_PORT ?? 3300)
// Durable SQLite store (ADR-0007). Defaults to ./gateway.db; set DSH_GATEWAY_DB_PATH
// to ':memory:' for a throwaway run or to a custom file path.
const DB_PATH = CLI.DSH_GATEWAY_DB_PATH ?? process.env.DSH_GATEWAY_DB_PATH ?? './gateway.db'
// Bootstrap platform admin (created on first run).
const ADMIN_ID = CLI.DSH_GATEWAY_ADMIN_ID ?? process.env.DSH_GATEWAY_ADMIN_ID ?? 'admin'
const ADMIN_PASSWORD = CLI.DSH_GATEWAY_ADMIN_PASSWORD ?? process.env.DSH_GATEWAY_ADMIN_PASSWORD ?? 'admin'

const app = Fastify({ logger: true })

const store = new SqliteStore({ filename: DB_PATH })
await store.open()

// Ensure the bootstrap system admin exists.
await bootstrap(store, { adminId: ADMIN_ID, adminPassword: ADMIN_PASSWORD })
if (CLI.DSH_GATEWAY_ADMIN_PASSWORD === undefined && process.env.DSH_GATEWAY_ADMIN_PASSWORD === undefined) {
  app.log.warn('using default bootstrap admin password ("admin") — set DSH_GATEWAY_ADMIN_PASSWORD in production')
}

const auth = buildAuth()
const registry = new NodeRegistry(store)

// Seed one-time pairing codes for testing: DSH_GATEWAY_PAIRING_CODES="code,code,..."
for (const code of (CLI.DSH_GATEWAY_PAIRING_CODES ?? process.env.DSH_GATEWAY_PAIRING_CODES ?? '').split(',').filter(Boolean)) {
  try {
    await registry.seedPairingCode(code)
  } catch (e) {
    app.log.warn(`failed to seed pairing code "${code}": ${String((e as Error).message ?? e)}`)
  }
}
registry.start()

// Console HTTP relay → node → local dsh web.
registerRouter(app, registry, store, auth)

// Portal-user auth (session cookie + login/logout/me).
await auth.register(app, store)

// Control-plane REST API (users/machines/assignments/pairing-codes/seats/audit).
await registerControl(app, store, registry, auth)

// Version / hot-update API (git check + fast-forward pull + reload).
await registerUpdater(app, auth, store)

// no-store so the portal's post-update recovery poll (and any proxy/cache in
// front of the gateway) always re-checks the live process instead of a stale body.
app.get('/health', async (_req, reply) =>
  reply.header('Cache-Control', 'no-store').send({
    ok: true,
    service: 'deepseek-harness-gateway',
    version: '0.2.0',
    protocol: PROTOCOL_VERSION,
    connectedNodes: registry.connectedCount(),
  }),
)

app.get('/nodes', async () => ({ nodes: await registry.listNodes() }))

// /wscheck — unauthenticated WebSocket self-test page. Opens a same-origin WS,
// echoes text and a ~1MB binary frame, and prints what happened. Used to tell
// whether a device/browser can carry WebSocket frames over this exact
// nginx+TLS chain at all (vendor built-in browsers often pass the handshake
// but lose every frame). No secrets; gated by nothing (like /health).
const WSCHECK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gateway wscheck</title><style>body{font:13px/1.5 ui-monospace,monospace;background:#111;color:#9f6;padding:14px;white-space:pre-wrap}</style></head><body><div id="out">starting…</div><script>
(function(){
  var out=document.getElementById('out'),log=function(s){out.textContent+=s+"\\n"};
  log('ua: '+navigator.userAgent);
  log('proto: '+(location.protocol==='https:'?'wss':'ws')+' url: '+location.href);
  try{log('sw: '+(navigator.serviceWorker?'present':'none'))}catch(e){}
  var url=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/wscheck';
  var ws,open=false,fail='';
  try{ ws=new WebSocket(url) }catch(e){ log('new WebSocket THREW: '+e); return }
  var t0=Date.now(),sent=0,echoed=0,binaryEchoed=0;
  ws.onopen=function(){ open=true; log('WS open OK at '+(Date.now()-t0)+'ms');
    var ping=function(){ try{ ws.send('ping-'+ (++sent)) }catch(e){ log('send threw: '+e) } };
    ping();
    setTimeout(function(){ // one big binary frame (~1MB)
      try{ var buf=new ArrayBuffer(1000000); ws.send(buf); log('sent 1MB binary') }catch(e){ log('big send threw: '+e) }
    }, 600);
  };
  ws.onmessage=function(ev){
    var t=Date.now()-t0;
    if(typeof ev.data==='string'){ echoed++; log('echo #'+echoed+' "'+ev.data+'" at '+t+'ms') }
    else { binaryEchoed++; log('binary echo OK size='+(ev.data&&ev.data.byteLength)+' at '+t+'ms') }
  };
  ws.onerror=function(e){ log('WS error event at '+(Date.now()-t0)+'ms (details hidden by browser)') };
  ws.onclose=function(ev){ log('WS closed code='+ev.code+' reason='+ev.reason+' at '+(Date.now()-t0)+'ms; open='+open+' sent='+sent+' echoed='+echoed+' binEcho='+binaryEchoed) };
  window.setTimeout(function(){ if(open){ log('still open after 8s; sent='+sent+' echoed='+echoed+' binEcho='+binaryEchoed); ws.close(1000) } }, 8000);
})();
</script></body></html>`

app.get('/wscheck', async (_req, reply) =>
  reply.type('text/html').header('Cache-Control', 'no-store').send(WSCHECK_HTML))

// wscheck echo server: text frames echo as 'echo:<payload>'; the first text
// frame answers 'pong:hello'. Compression disabled (mirrors console mux).
const wscheckWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
wscheckWss.on('connection', (ws) => {
  ws.send('pong:hello')
  ws.on('message', (data, isBinary) => {
    try {
      ws.send(data, { binary: isBinary })
    } catch {
      /* ignore */
    }
  })
})

// Portal static hosting — apps/web build output. The SPA is served at `/` and
// its assets at `/portal/*` (Vite base=/portal/), so the dsh web UI's absolute
// paths (/assets, /api, /plugins) fall through to the `/*` relay passthrough.
//
// Resolution supports every deployment shape:
//   - monorepo dev / docker: apps/web/dist relative to this module
//   - published npm package: dist/portal (copied by scripts/bundle.mjs)
//   - explicit override via DSH_GATEWAY_WEB_DIST
// The first candidate whose index.html exists wins; if none, portal hosting is
// disabled (the server still runs the control plane + router + WS).
function resolveWebDist(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    CLI.DSH_GATEWAY_WEB_DIST ?? process.env.DSH_GATEWAY_WEB_DIST,
    join(here, '..', '..', 'web', 'dist'),
    join(here, 'portal'),
    join(here, '..', 'portal'),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c
  }
  if (candidates.length === 0) {
    app.log.warn('portal hosting disabled — no web dist candidate configured (set DSH_GATEWAY_WEB_DIST)')
  } else {
    app.log.warn(`portal hosting disabled — no built index.html in ${candidates.join(', ')}`)
  }
  return undefined
}
const webDist = resolveWebDist()
const indexHtml = webDist ? join(webDist, 'index.html') : null

// The SPA shell must always be fresh so a hot-updated build (new hashed assets)
// is picked up immediately instead of a stale cached copy. Re-check existence on
// every request: a hot-update rebuild can transiently remove dist/index.html, and
// a failed or interrupted build must degrade to a retryable 503 rather than a raw
// ENOENT 500 that never recovers.
app.get('/', async (_req, reply) => {
  if (!indexHtml || !existsSync(indexHtml)) {
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

if (webDist) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/portal/' })
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
    // Machine-less console paths (the page issues /api/remote.mux etc. as
    // absolute URLs with no machineId): route to the session's bound machine
    // first, then the single-node passthrough.
    const bound = getCookie(req.headers.cookie, SESSION_COOKIE)
    machineId = (bound ? auth.sessions.machineOf(bound) : undefined) ?? registry.singleNodeId()
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
  if (req.url?.startsWith('/wscheck')) {
    wscheckWss.handleUpgrade(req, socket, head, (ws) => wscheckWss.emit('connection', ws, req))
  } else if (req.url?.startsWith('/agent')) {
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
