// Cross-restart lockout integration test (audit follow-up on persistent
// lockout): boots the REAL gateway process (tsx src/main.ts) against a temp
// SQLite file, drives /gw/login over HTTP until the account locks (5 wrong
// passwords → 401 ×5, next attempt → 429), then restarts the gateway against
// the SAME database file and asserts the account is still locked (429) and the
// throttled rejections left `login_throttled` audit rows.
//
// This closes the earlier gap where only LoginThrottle unit tests + a manual
// curl smoke covered the restart path.
import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { SqliteStore } from 'dsh-gateway-store'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const gatewayRoot = join(here, '..')
const tsxCli = require.resolve('tsx/cli')

const ADMIN = 'admin'
// Not the default bootstrap password (fail-fast guard in main.ts), so the
// spawned gateway boots without DSH_GATEWAY_ALLOW_DEFAULT_ADMIN.
const ADMIN_PW = 'integration-test-pw-1'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface GatewayProc {
  child: ChildProcess
  logs: () => string
}

async function startGateway(dbPath: string, port: number): Promise<GatewayProc> {
  const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
    cwd: gatewayRoot,
    env: {
      ...process.env,
      DSH_GATEWAY_HOST: '127.0.0.1',
      DSH_GATEWAY_PORT: String(port),
      DSH_GATEWAY_DB_PATH: dbPath,
      DSH_GATEWAY_ADMIN_ID: ADMIN,
      DSH_GATEWAY_ADMIN_PASSWORD: ADMIN_PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (d: Buffer) => (logs += d.toString()))
  child.stderr.on('data', (d: Buffer) => (logs += d.toString()))

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early (code ${child.exitCode})\n${logs}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return { child, logs: () => logs }
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  child.kill('SIGKILL')
  throw new Error(`gateway did not become healthy in time\n${logs}`)
}

async function stopGateway(gw: GatewayProc): Promise<void> {
  const { child } = gw
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(killer)
}

async function login(port: number, id: string, password: string) {
  const res = await fetch(`http://127.0.0.1:${port}/gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body }
}

describe('persistent lockout across a real gateway restart', () => {
  it(
    'keeps a locked account locked after restarting the gateway on the same DB',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dshgw-lockout-'))
      const dbPath = join(dir, 'gateway.db')
      const first = await freePort()
      const second = await freePort()

      let gw: GatewayProc | undefined
      try {
        // ---- First boot: lock the admin account over real HTTP. ----
        gw = await startGateway(dbPath, first)
        // 5 wrong passwords → 5 × 401 (denied + throttled state accrues)…
        for (let i = 1; i <= 5; i++) {
          const r = await login(first, ADMIN, `wrong-${i}`)
          expect(r.status).toBe(401)
        }
        // …the 6th attempt trips the account lockout → 429 with Retry-After.
        const blocked = await login(first, ADMIN, 'wrong-6')
        expect(blocked.status).toBe(429)
        expect(Number(blocked.retryAfter)).toBeGreaterThan(0)
        await stopGateway(gw)
        gw = undefined

        // ---- Restart the gateway on the SAME database file. ----
        gw = await startGateway(dbPath, second)

        // The lock must survive the restart: even the CORRECT password is
        // rejected while the account is locked (throttle check runs before any
        // credential verification).
        const afterRestart = await login(second, ADMIN, ADMIN_PW)
        expect(afterRestart.status).toBe(429)
        expect(Number(afterRestart.retryAfter)).toBeGreaterThan(0)

        const afterRestartWrong = await login(second, ADMIN, 'still-wrong')
        expect(afterRestartWrong.status).toBe(429)
      } finally {
        if (gw) {
          await stopGateway(gw).catch(() => gw!.child.kill('SIGKILL'))
        }
      }

      // ---- Audit forensics: throttled rejections were recorded, and the rows
      // survived the restart (append-only, persisted alongside lock state). ----
      const store = new SqliteStore({ filename: dbPath })
      await store.open()
      const audits = await store.queryAudit()
      await store.close()

      const denied = audits.filter((a) => a.action === 'login' && a.result === 'denied')
      const throttled = audits.filter((a) => a.action === 'login_throttled')
      expect(denied).toHaveLength(5)
      expect(throttled.length).toBeGreaterThanOrEqual(2)
      for (const a of throttled) {
        expect(a.result).toBe('denied')
        expect(a.actor).toBe(ADMIN)
        const detail = JSON.parse(a.detail ?? '{}') as { reason?: string }
        expect(detail.reason).toBe('account')
      }

      rmSync(dir, { recursive: true, force: true })
    },
    120_000,
  )
})
