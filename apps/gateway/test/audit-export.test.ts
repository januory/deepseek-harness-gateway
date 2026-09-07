// ADR-0012 integration test over a REAL gateway process: boots src/main.ts
// against a pre-seeded SQLite DB (rows both inside and far outside the
// retention window), then verifies end-to-end that
//  1. the retention purge (startup pass + short interval) removes the
//     out-of-window rows and keeps the recent ones,
//  2. GET /gw/audit composes filters and pagination,
//  3. GET /gw/audit/export streams JSONL (default) and CSV of the matching
//     rows, chronological and complete,
//  4. both endpoints stay admin-gated (401 without a session).
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
      // ADR-0012 retention: 30-day window; short interval so the test does not
      // wait an hour for the periodic purge.
      DSH_GATEWAY_AUDIT_RETENTION_DAYS: '30',
      DSH_GATEWAY_AUDIT_PURGE_INTERVAL_MS: '300',
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

async function login(port: number): Promise<{ status: number; token?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/gw/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: ADMIN, password: ADMIN_PW }),
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  const m = /(?:^|;\s*)(gw_session|__Host-gw_session)=([^;]+)/.exec(setCookie)
  return { status: res.status, token: m ? `${m[1]}=${m[2]}` : undefined }
}

function gwFetch(port: number, path: string, token?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { cookie: token } : {},
  })
}

describe('audit retention + export over a real gateway', () => {
  it(
    'purges out-of-window rows, filters/paginates GET /gw/audit and streams exports',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dshgw-audit-'))
      const dbPath = join(dir, 'gateway.db')

      // Seed the DB BEFORE the gateway boots: two recent rows inside the
      // 30-day window and three rows from 2020 (far out of the window).
      const seed = new SqliteStore({ filename: dbPath })
      await seed.open()
      await seed.appendAudit({ ts: '2020-01-01T00:00:00.000Z', actor: 'seed-admin', machineId: 'm-seed', action: 'approve', result: 'ok' })
      await seed.appendAudit({ ts: '2020-02-01T00:00:00.000Z', actor: 'seed-admin', machineId: 'm-seed', action: 'revoke', result: 'denied' })
      await seed.appendAudit({ ts: '2020-03-01T00:00:00.000Z', actor: 'alice', action: 'login', result: 'ok' })
      await seed.appendAudit({ ts: '2026-09-05T00:00:00.000Z', actor: 'alice', machineId: 'm1', action: 'approve', result: 'ok', detail: '"note"' })
      await seed.appendAudit({ ts: '2026-09-05T00:00:01.000Z', actor: ADMIN, action: 'login', result: 'ok' })
      await seed.close()

      const port = await freePort()
      let gw: GatewayProc | undefined
      try {
        gw = await startGateway(dbPath, port)

        // Admin session (audit endpoints are admin-only).
        const auth = await login(port)
        expect(auth.status).toBe(200)
        const token = auth.token
        expect(token).toBeTruthy()

        // 401 without a session on both audit endpoints.
        expect((await gwFetch(port, '/gw/audit')).status).toBe(401)
        expect((await gwFetch(port, '/gw/audit/export')).status).toBe(401)

        // Wait for the retention purge (startup pass + 300ms interval) to drop
        // the 2020 rows; poll until they are gone.
        let gone = false
        for (let i = 0; i < 40 && !gone; i++) {
          await sleep(200)
          const res = await gwFetch(port, '/gw/audit', token)
          if (!res.ok) continue
          const body = (await res.json()) as { events: Array<{ ts: string }> }
          gone = body.events.every((e) => !e.ts.startsWith('2020'))
        }
        expect(gone).toBe(true)

        // ---- GET /gw/audit: no out-of-window rows, recent rows present ----
        const allRes = await gwFetch(port, '/gw/audit', token)
        expect(allRes.status).toBe(200)
        const all = (await allRes.json()) as { events: Array<{ ts: string; actor: string; action: string; result: string; machineId?: string }> }
        expect(all.events.length).toBeGreaterThanOrEqual(3) // 2 seeded recent + bootstrap + login…
        expect(all.events.some((e) => e.ts === '2026-09-05T00:00:00.000Z' && e.action === 'approve' && e.machineId === 'm1')).toBe(true)
        expect(all.events.every((e) => !e.ts.startsWith('2020'))).toBe(true)

        // ---- filters compose ----
        const byMachine = await gwFetch(port, '/gw/audit?machineId=m1', token)
        const machineEvents = (await byMachine.json()) as { events: Array<{ machineId?: string; action: string }> }
        expect(machineEvents.events.length).toBeGreaterThanOrEqual(1)
        expect(machineEvents.events.every((e) => e.machineId === 'm1' && e.action === 'approve')).toBe(true)

        const byAction = await gwFetch(port, '/gw/audit?action=approve', token)
        const approveEvents = (await byAction.json()) as { events: Array<{ action: string }> }
        expect(approveEvents.events.length).toBeGreaterThanOrEqual(1)
        expect(approveEvents.events.every((e) => e.action === 'approve')).toBe(true)

        const byResult = await gwFetch(port, '/gw/audit?result=ok', token)
        const okEvents = (await byResult.json()) as { events: Array<{ result: string }> }
        expect(okEvents.events.every((e) => e.result === 'ok')).toBe(true)

        // ---- pagination: chronological pages over the same filter ----
        // action=login has ≥2 rows (the seeded r2 login + this session's login).
        const p1 = await gwFetch(port, '/gw/audit?action=login&limit=1&offset=0', token)
        const page1 = (await p1.json()) as { events: Array<{ ts: string; action: string }> }
        expect(page1.events).toHaveLength(1)
        expect(page1.events[0].ts).toBe('2026-09-05T00:00:01.000Z')
        const p2 = await gwFetch(port, '/gw/audit?action=login&limit=1&offset=1', token)
        const page2 = (await p2.json()) as { events: Array<{ ts: string; action: string }> }
        expect(page2.events).toHaveLength(1)
        expect(page2.events[0].ts).not.toBe('2026-09-05T00:00:01.000Z')
        // offset beyond the end → empty page
        const p3 = await gwFetch(port, '/gw/audit?action=login&limit=1&offset=99', token)
        const page3 = (await p3.json()) as { events: unknown[] }
        expect(page3.events).toHaveLength(0)

        // ---- JSONL export (default): streaming, chronological, complete ----
        const jsonlRes = await gwFetch(port, '/gw/audit/export', token)
        expect(jsonlRes.status).toBe(200)
        expect(jsonlRes.headers.get('content-type')).toContain('application/x-ndjson')
        expect(jsonlRes.headers.get('content-disposition')).toContain('attachment; filename="audit-export-')
        expect(jsonlRes.headers.get('content-disposition')).toContain('.jsonl"')
        const jsonl = (await jsonlRes.text()).trimEnd().split('\n')
        expect(jsonl.length).toBe(all.events.length) // full dump, no pagination cap
        const parsed = jsonl.map((l) => JSON.parse(l) as { ts: string; actor: string; action: string; result: string; machineId?: string; detail?: string })
        for (const e of parsed) {
          expect(typeof e.ts).toBe('string')
          expect(typeof e.actor).toBe('string')
          expect(typeof e.action).toBe('string')
          expect(['ok', 'denied', 'error']).toContain(e.result)
        }
        const tsSeq = parsed.map((e) => e.ts)
        expect(tsSeq).toEqual([...tsSeq].sort()) // non-decreasing chronological
        expect(parsed.some((e) => e.ts === '2026-09-05T00:00:00.000Z' && e.detail === '"note"')).toBe(true)
        expect(parsed.every((e) => !e.ts.startsWith('2020'))).toBe(true)

        // Export honors the same filters.
        const filteredExport = await gwFetch(port, '/gw/audit/export?action=approve', token)
        const filteredLines = (await filteredExport.text()).trimEnd().split('\n')
        expect(filteredLines.every((l) => (JSON.parse(l) as { action: string }).action === 'approve')).toBe(true)
        expect(filteredLines.length).toBe(approveEvents.events.length)

        // ---- CSV export ----
        const csvRes = await gwFetch(port, '/gw/audit/export?format=csv', token)
        expect(csvRes.status).toBe(200)
        expect(csvRes.headers.get('content-type')).toContain('text/csv')
        const csv = (await csvRes.text()).trimEnd().split('\n')
        expect(csv[0]).toBe('ts,actor,machineId,action,result,detail')
        expect(csv.length - 1).toBe(all.events.length) // header + one line per event
      } finally {
        if (gw) {
          await stopGateway(gw).catch(() => gw!.child.kill('SIGKILL'))
        }
      }
      rmSync(dir, { recursive: true, force: true })
    },
    120_000,
  )
})
